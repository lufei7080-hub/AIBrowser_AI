use std::collections::HashSet;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::sync::Arc;
use std::time::Duration;

use dashmap::DashMap;
use rusqlite::Connection;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::db;
use crate::error::AppError;
use crate::{log_info, log_warn};
use crate::extension_paths::{collect_extension_paths, merge_extension_paths};
use crate::models::{Profile, StartProfileResult};
use crate::process_win::{
    kill_process_tree, prepare_sidecar_command, register_child_for_lifecycle,
};
use crate::profile_id::parse_profile_id;
use crate::proxy::{self, ResolvedProxy};
use crate::sidecar::emit_sidecar_line;
use crate::sidecar_paths::{resolve_sidecar_dist, sidecar_working_dir};
use crate::win_taskbar;
use crate::AppState;

const PROFILE_IP_GEO_EVENT: &str = "profile-ip-geo-updated";

const INTERACTIVE_EXTRACT_CACHE_FILES: &[&str] = &[
    "cloakforge-interactive-elements.json",
    "cloakforge-agent-elements.json",
];

/// 关闭浏览器时清除元素提取调试/填表缓存（不删 profile 其它数据）。
fn purge_interactive_extract_cache(user_data_dir: &Path) {
    for name in INTERACTIVE_EXTRACT_CACHE_FILES {
        let path = user_data_dir.join(name);
        if path.is_file() {
            if let Err(error) = std::fs::remove_file(&path) {
                log_warn!(
                    "[browser_manager] purge extract cache failed path={} err={error}",
                    path.display()
                );
            }
        }
    }
}

fn profile_user_data_dir(app: &AppHandle, profile_id: &str) -> Result<PathBuf, AppError> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| AppError::Filesystem(error.to_string()))?
        .join("browser-profiles")
        .join(format!("profile-{profile_id}")))
}

#[derive(Default)]
pub struct BrowserManager {
    processes: Arc<DashMap<String, Child>>,
    /// 启动中的 profile_id（跨 await 互斥），防止同环境双开 / 并发抢 CDP。
    launching: Arc<DashMap<String, ()>>,
}

impl BrowserManager {
    pub fn is_running(&self, profile_id: &str) -> bool {
        self.processes.contains_key(profile_id) || self.launching.contains_key(profile_id)
    }

    /// 向 launch sidecar stdin 发送 extract_now，触发当前页元素提取并推送测试窗。
    pub fn request_interactive_extract(&self, profile_id: &str) -> Result<(), AppError> {
        let mut entry = self.processes.get_mut(profile_id).ok_or_else(|| {
            AppError::Validation(format!(
                "profile {profile_id} is not running; start browser first"
            ))
        })?;
        let stdin = entry.stdin.as_mut().ok_or_else(|| {
            AppError::Launcher("launch sidecar stdin unavailable".to_owned())
        })?;
        stdin
            .write_all(b"{\"command\":\"extract_now\"}\n")
            .map_err(|error| {
                AppError::Launcher(format!("failed to request interactive extract: {error}"))
            })?;
        stdin.flush().map_err(|error| {
            AppError::Launcher(format!("failed to flush extract_now: {error}"))
        })?;
        Ok(())
    }

    pub async fn start_profile(
        &self,
        app: &AppHandle,
        db_state: &AppState,
        profile_id: String,
    ) -> Result<StartProfileResult, AppError> {
        if self.is_running(&profile_id) {
            return Err(AppError::AlreadyRunning(profile_id));
        }
        if self
            .launching
            .insert(profile_id.clone(), ())
            .is_some()
        {
            return Err(AppError::AlreadyRunning(profile_id));
        }

        let result = self
            .start_profile_isolated(app, db_state, profile_id.clone())
            .await;
        self.launching.remove(&profile_id);
        result
    }

    /// 单次启动的独立作用域：DB 查询 / 代理解析 / Launch Payload 全部绑定本 `profile_id`。
    async fn start_profile_isolated(
        &self,
        app: &AppHandle,
        db_state: &AppState,
        profile_id: String,
    ) -> Result<StartProfileResult, AppError> {
        let numeric_id = parse_profile_id(&profile_id)?;

        let launch_outcome = self
            .start_profile_bound(app, db_state, profile_id, numeric_id)
            .await;

        if launch_outcome.is_err() {
            if let Ok(connection) = db_state.database.lock() {
                let _ = db::release_cdp_port_reservation(&connection, numeric_id);
            }
        }

        launch_outcome
    }

    async fn start_profile_bound(
        &self,
        app: &AppHandle,
        db_state: &AppState,
        profile_id: String,
        numeric_id: i64,
    ) -> Result<StartProfileResult, AppError> {
        let (profile, cdp_port, proxy_input, profiles_root, license_key) = {
            let connection = db_state
                .database
                .lock()
                .map_err(|_| AppError::State("database lock poisoned".to_owned()))?;
            let profile = db::get_profile(&connection, numeric_id)?;
            if profile.id != numeric_id {
                return Err(AppError::Validation(format!(
                    "profile id mismatch: requested={profile_id} db={}",
                    profile.id
                )));
            }
            // 立刻预留端口，避免并发启动撞 CDP → 连错浏览器/代理表现错位
            let cdp_port = db::allocate_and_reserve_cdp_port(&connection, numeric_id)?;
            let proxy_input = proxy::proxy_resolution_input_from_profile(&connection, &profile)?;
            let profiles_root = app
                .path()
                .app_data_dir()
                .map_err(|error| AppError::Filesystem(error.to_string()))?
                .join("browser-profiles");
            let license_key = db::get_setting(&connection, "cloak_license_key")?
                .filter(|value| !value.trim().is_empty());
            (profile, cdp_port, proxy_input, profiles_root, license_key)
        };

        let resolved_proxy = match proxy_input {
            Some(input) => Some(proxy::resolve_profile_proxy_input(input).await?),
            None => None,
        };

        let user_data_dir = profiles_root.join(format!("profile-{profile_id}"));
        std::fs::create_dir_all(&user_data_dir)?;
        let user_data_dir = user_data_dir
            .canonicalize()
            .unwrap_or_else(|_| profiles_root.join(format!("profile-{profile_id}")));

        proxy::purge_stale_profile_proxy_auth_ext(&user_data_dir);
        let auth_extension_dir = if let Some(ref resolved) = resolved_proxy {
            if proxy::resolved_proxy_needs_auth_extension(resolved) {
                Some(proxy::generate_proxy_auth_extension(&profile_id, resolved)?)
            } else {
                proxy::purge_proxy_auth_extension(&profile_id);
                None
            }
        } else {
            proxy::purge_proxy_auth_extension(&profile_id);
            None
        };

        let (proxy_env, ip_geo) = match crate::ip_geo::resolve_profile_launch_env(
            resolved_proxy.as_ref(),
            profile.use_geoip,
        )
        .await
        {
            Ok(Some(env)) => {
                let geo = crate::ip_geo::profile_ip_geo_from_env(&profile_id, &env);
                let _ = app.emit(PROFILE_IP_GEO_EVENT, &geo);
                (Some(env), Some(geo))
            }
            Ok(None) => (None, None),
            Err(error) => {
                if resolved_proxy.is_some() {
                    return Err(error);
                }
                log_warn!("[browser_manager] direct geoip sync skipped: {error}");
                (None, None)
            }
        };

        let launch_config = build_launch_config(
            app,
            &profile_id,
            &user_data_dir,
            cdp_port,
            &profile,
            resolved_proxy.as_ref(),
            auth_extension_dir.as_deref(),
            license_key.as_deref(),
            proxy_env.as_ref(),
            profile.interactive_element_extract_enabled,
        )?;

        // Launch Payload 自检：profileId / userDataDir / proxyUrl 必须与本环境一致
        let payload_profile_id = launch_config
            .get("profileId")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        if payload_profile_id != profile_id {
            return Err(AppError::Launcher(format!(
                "launch payload profileId mismatch: payload={payload_profile_id} expected={profile_id}"
            )));
        }
        let child = spawn_cloakbrowser_sidecar(app, &profile_id, &launch_config).await?;

        if self.processes.contains_key(&profile_id) {
            let _ = stop_child(child);
            return Err(AppError::AlreadyRunning(profile_id));
        }

        self.processes.insert(profile_id.clone(), child);
        spawn_launch_exit_watcher(
            self.processes.clone(),
            app.clone(),
            db_state.database.clone(),
            profile_id.clone(),
        );

        {
            let connection = db_state
                .database
                .lock()
                .map_err(|_| AppError::State("database lock poisoned".to_owned()))?;
            if let Err(error) = db::set_profile_running(&connection, numeric_id, cdp_port) {
                if let Some((_, running_child)) = self.processes.remove(&profile_id) {
                    let _ = stop_child(running_child);
                }
                return Err(error);
            }
        }

        let _ = app.emit(
            "browser-status",
            serde_json::json!({
                "profileId": profile_id,
                "status": "running",
                "cdpPort": cdp_port,
            }),
        );

        Ok(StartProfileResult {
            profile_id,
            cdp_port,
            ip_geo,
        })
    }

    pub fn stop_profile(
        &self,
        app: &AppHandle,
        db_state: &AppState,
        profile_id: String,
    ) -> Result<(), AppError> {
        let numeric_id = parse_profile_id(&profile_id)?;

        let (cdp_port, user_data_dir) = {
            let connection = db_state
                .database
                .lock()
                .map_err(|_| AppError::State("database lock poisoned".to_owned()))?;
            let profile = db::get_profile(&connection, numeric_id)?;
            let profiles_root = app
                .path()
                .app_data_dir()
                .map_err(|error| AppError::Filesystem(error.to_string()))?
                .join("browser-profiles");
            let user_data_dir = profiles_root
                .join(format!("profile-{profile_id}"))
                .to_string_lossy()
                .into_owned();
            (profile.cdp_port, user_data_dir)
        };

        if let Some((_, child)) = self.processes.remove(&profile_id) {
            stop_child(child)?;
        }

        if !force_kill_profile_browser(app, cdp_port, &user_data_dir) {
            log_warn!(
                "[browser_manager] force kill returned false for profile={profile_id} (process tree may linger)"
            );
        }
        proxy::purge_proxy_auth_extension(&profile_id);
        proxy::purge_stale_profile_proxy_auth_ext(Path::new(&user_data_dir));
        purge_interactive_extract_cache(Path::new(&user_data_dir));

        {
            let connection = db_state
                .database
                .lock()
                .map_err(|_| AppError::State("database lock poisoned".to_owned()))?;
            let profile = db::get_profile(&connection, numeric_id)?;
            if profile.status != "running" {
                return Err(AppError::NotRunning(profile_id));
            }
            db::set_profile_stopped(&connection, numeric_id)?;
        }

        let _ = app.emit(
            "browser-status",
            serde_json::json!({
                "profileId": profile_id,
                "status": "stopped",
            }),
        );
        let _ = app.emit(
            "interactive-extract-cleared",
            serde_json::json!({ "profileId": profile_id }),
        );

        Ok(())
    }

    pub fn running_profile_ids(&self) -> Vec<String> {
        self.processes
            .iter()
            .map(|entry| entry.key().clone())
            .collect()
    }

    pub fn stop_all_profiles(
        &self,
        app: &AppHandle,
        db_state: &AppState,
    ) -> Result<usize, AppError> {
        let profiles_root = app
            .path()
            .app_data_dir()
            .map_err(|error| AppError::Filesystem(error.to_string()))?
            .join("browser-profiles");

        let targets = {
            let connection = db_state
                .database
                .lock()
                .map_err(|_| AppError::State("database lock poisoned".to_owned()))?;
            let mut profile_ids: HashSet<String> =
                self.running_profile_ids().into_iter().collect();
            for profile in db::list_profiles(&connection)? {
                if profile.status == "running" {
                    profile_ids.insert(profile.id.to_string());
                }
            }

            let mut rows = Vec::new();
            for profile_id in profile_ids {
                if let Ok(numeric_id) = parse_profile_id(&profile_id) {
                    let profile = db::get_profile(&connection, numeric_id)?;
                    let user_data_dir = profiles_root
                        .join(format!("profile-{profile_id}"))
                        .to_string_lossy()
                        .into_owned();
                    rows.push((profile_id, profile.cdp_port, user_data_dir));
                }
            }
            rows
        };

        let mut stopped = 0usize;
        for (profile_id, cdp_port, user_data_dir) in targets {
            if let Some((_, child)) = self.processes.remove(&profile_id) {
                let _ = stop_child(child);
            }

            if force_kill_profile_browser(app, cdp_port, &user_data_dir) {
                stopped += 1;
            }
            proxy::purge_proxy_auth_extension(&profile_id);
            proxy::purge_stale_profile_proxy_auth_ext(Path::new(&user_data_dir));
            purge_interactive_extract_cache(Path::new(&user_data_dir));

            if let Ok(numeric_id) = parse_profile_id(&profile_id) {
                let connection = db_state
                    .database
                    .lock()
                    .map_err(|_| AppError::State("database lock poisoned".to_owned()))?;
                if db::get_profile(&connection, numeric_id)?.status == "running" {
                    db::set_profile_stopped(&connection, numeric_id)?;
                }
            }

            let _ = app.emit(
                "browser-status",
                serde_json::json!({
                    "profileId": profile_id,
                    "status": "stopped",
                }),
            );
            let _ = app.emit(
                "interactive-extract-cleared",
                serde_json::json!({ "profileId": profile_id }),
            );
        }

        // 扫尾：DB/内存未登记但仍占席位的孤儿 Chromium（仅限本应用 browser-profiles）
        #[cfg(windows)]
        {
            let orphan = crate::win_taskbar::kill_all_browsers_under_profiles_root(
                &profiles_root.to_string_lossy(),
            );
            if orphan > 0 {
                log_info!(
                    "[browser_manager] stop_all orphan kill under profiles_root={orphan} process tree(s)"
                );
                stopped = stopped.saturating_add(orphan);
            }
        }

        Ok(stopped)
    }
}

#[tauri::command]
pub fn get_running_profile_ids(manager: State<'_, BrowserManager>) -> Vec<String> {
    manager.running_profile_ids()
}

/// Bring the running profile's Chromium window to the foreground (Windows).
#[tauri::command]
pub async fn focus_profile_browser(
    db_state: State<'_, AppState>,
    profile_id: String,
) -> Result<(), AppError> {
    let numeric_id = parse_profile_id(&profile_id)?;
    let cdp_port = {
        let connection = db_state
            .database
            .lock()
            .map_err(|_| AppError::State("database lock poisoned".to_owned()))?;
        let profile = db::get_profile(&connection, numeric_id)?;
        profile
            .cdp_port
            .filter(|port| *port > 0 && *port <= i64::from(u16::MAX))
            .ok_or_else(|| {
                AppError::Validation(format!(
                    "环境 #{profile_id} 无有效 CDP 端口（请确认浏览器已启动）"
                ))
            })?
    };
    let port = cdp_port as u16;
    tauri::async_runtime::spawn_blocking(move || {
        crate::win_taskbar::focus_browser_by_cdp_port(port)
    })
    .await
    .map_err(|error| AppError::Launcher(error.to_string()))?
    .map_err(AppError::Launcher)
}

#[tauri::command]
pub fn stop_all_profiles(
    app: AppHandle,
    manager: State<'_, BrowserManager>,
    db_state: State<'_, AppState>,
    rpa_manager: State<'_, crate::rpa_session::RpaSessionManager>,
) -> Result<usize, AppError> {
    rpa_manager.stop_all_sessions();
    let stopped = manager.stop_all_profiles(&app, &db_state)?;
    crate::proxy::purge_all_proxy_auth_extensions();
    Ok(stopped)
}

#[tauri::command]
pub async fn start_profile(
    app: AppHandle,
    manager: State<'_, BrowserManager>,
    db_state: State<'_, AppState>,
    profile_id: String,
) -> Result<StartProfileResult, AppError> {
    manager.start_profile(&app, &db_state, profile_id).await
}

#[tauri::command]
pub fn stop_profile(
    app: AppHandle,
    manager: State<'_, BrowserManager>,
    db_state: State<'_, AppState>,
    rpa_manager: State<'_, crate::rpa_session::RpaSessionManager>,
    profile_id: String,
) -> Result<(), AppError> {
    // Kill Switch：先杀 Sidecar，再停浏览器，杜绝僵尸 Node
    let _ = rpa_manager.stop_session(&profile_id);
    manager.stop_profile(&app, &db_state, profile_id)
}

/// 解析环境额外启动网址（JSON 数组）；失败时返回空列表，不阻断启动。
fn parse_startup_urls_for_launch(raw: &str) -> Vec<String> {
    match serde_json::from_str::<Vec<String>>(raw.trim()) {
        Ok(items) => items
            .into_iter()
            .map(|item| item.trim().to_owned())
            .filter(|item| !item.is_empty())
            .collect(),
        Err(_) => Vec::new(),
    }
}

fn build_launch_config(
    app: &AppHandle,
    profile_id: &str,
    user_data_dir: &Path,
    cdp_port: u16,
    profile: &Profile,
    resolved_proxy: Option<&ResolvedProxy>,
    auth_extension_dir: Option<&str>,
    license_key: Option<&str>,
    proxy_env: Option<&crate::ip_geo::ProxyEnvSync>,
    interactive_element_extract_enabled: bool,
) -> Result<serde_json::Value, AppError> {
    let proxy_url = resolved_proxy.map(ResolvedProxy::chromium_proxy_flag);
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| AppError::Filesystem(error.to_string()))?;
    let extension_paths =
        merge_extension_paths(auth_extension_dir, collect_extension_paths(&app_data_dir));

    let mut config = json!({
        "profileId": profile_id,
        "userDataDir": user_data_dir.to_string_lossy(),
        "cdpPort": cdp_port,
        "proxyUrl": proxy_url,
        "useGeoip": profile.use_geoip,
        "humanize": profile.humanize,
        "fingerprintSeed": profile.fingerprint_seed,
        "stealthPreset": profile.stealth_preset,
        "webglMode": profile.webgl_mode,
        "extensionPaths": extension_paths,
        "licenseKey": license_key,
        "themeColor": profile.theme_color,
        "interactiveElementExtractEnabled": interactive_element_extract_enabled,
        "startupUrls": parse_startup_urls_for_launch(&profile.startup_urls),
    });

    let browser_version = profile.browser_version.trim();
    // 仅传入 CloakBrowser 认可的完整 pin；脏值（如「CloakBrowser」）会导致 launch 直接失败
    if db::is_valid_browser_version_pin(browser_version) {
        config["browserVersion"] = json!(browser_version);
    }

    if let Some(resolved) = resolved_proxy {
        if let Some(username) = resolved
            .username
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            config["proxyUsername"] = json!(username);
            config["proxyPassword"] = json!(resolved.password.clone().unwrap_or_default());
        }
    }

    if let Some(env) = proxy_env {
        config["proxyEnv"] = json!({
            "exitIp": env.exit_ip,
            "timezone": env.timezone,
            "locale": env.locale,
            "latitude": env.latitude,
            "longitude": env.longitude,
            "countryCode": env.country_code,
            "country": env.country,
        });
    }

    if let Some(browse_root) = crate::kernel_policy::resolve_bundled_browse_root() {
        config["bundledBrowseRoot"] = json!(browse_root.to_string_lossy());
    }

    if let Some(state) = app.try_state::<AppState>() {
        if let Ok(connection) = state.database.lock() {
            if let Ok(roots) = crate::storage_paths::download_roots_json(app, &connection) {
                if let Some(browser) = roots.get("browserDownloadDir") {
                    config["browserDownloadDir"] = browser.clone();
                }
                if let Some(scraper) = roots.get("scraperDownloadDir") {
                    config["scraperDownloadDir"] = scraper.clone();
                }
            }

            // CloakBrowser Pro 官方指南兼容旗标（全局开关，默认 false）
            config["licenseThroughProxy"] =
                json!(db::get_bool_setting(&connection, "license_through_proxy")?);
            config["allowThirdPartyCookies"] =
                json!(db::get_bool_setting(&connection, "allow_third_party_cookies")?);
            config["fingerprintOff"] =
                json!(db::get_bool_setting(&connection, "fingerprint_off")?);
        }
    }

    Ok(config)
}

async fn spawn_cloakbrowser_sidecar(
    app: &AppHandle,
    profile_id: &str,
    launch_config: &serde_json::Value,
) -> Result<Child, AppError> {
    let launch_entry = resolve_sidecar_dist("launch.js").map_err(|error| match error {
        AppError::Sidecar(message) => AppError::Launcher(message),
        other => other,
    })?;
    let sidecar_dir = sidecar_working_dir(&launch_entry);

    let config_file = std::env::temp_dir().join(format!(
        "cloakforge-launch-{}-{}-{}.json",
        launch_config
            .get("profileId")
            .and_then(|value| value.as_str())
            .unwrap_or("profile"),
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or(0)
    ));
    std::fs::write(&config_file, launch_config.to_string()).map_err(|error| {
        AppError::Launcher(format!("failed to write launch config: {error}"))
    })?;

    let mut command = Command::new("node");
    command
        .arg(&launch_entry)
        .arg(format!("--config-file={}", config_file.display()))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    prepare_sidecar_command(&mut command);

    if let Some(dir) = sidecar_dir {
        command.current_dir(dir);
    }

    if let Some(key) = launch_config
        .get("licenseKey")
        .and_then(|value| value.as_str())
        .filter(|value| !value.trim().is_empty())
    {
        command.env("CLOAKBROWSER_LICENSE_KEY", key);
    }

    let mut child = command.spawn().map_err(|error| {
        AppError::Launcher(format!("failed to spawn cloakbrowser sidecar: {error}"))
    })?;
    // Job Object / 进程组：Tauri 强杀时级联回收 Node + Chromium 树
    if let Err(error) = register_child_for_lifecycle(&child) {
        log_warn!("[browser_manager] register_child_for_lifecycle skipped: {error}");
    }

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| AppError::Launcher("launch sidecar stdout unavailable".to_owned()))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| AppError::Launcher("launch sidecar stderr unavailable".to_owned()))?;

    let launch_rx = start_launch_sidecar_pump(app.clone(), profile_id.to_owned(), stdout, stderr);

    let launch_result = tauri::async_runtime::spawn_blocking(move || {
        launch_rx.recv_timeout(Duration::from_secs(120)).map_err(|_| {
            AppError::Launcher("cloakbrowser launch timed out after 120s".to_owned())
        })
    })
    .await
    .map_err(|error| AppError::Launcher(error.to_string()))?;

    match launch_result {
        Ok(Ok(())) => {}
        Ok(Err(error)) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
    }

    Ok(child)
}

fn emit_launch_sidecar_line(app: &AppHandle, profile_id: &str, line: &str) {
    if let Ok(value) = serde_json::from_str::<Value>(line) {
        if value.get("type").and_then(|entry| entry.as_str()) == Some("page_url") {
            let url = value
                .get("url")
                .and_then(|entry| entry.as_str())
                .unwrap_or("")
                .to_owned();
            let event_profile_id = value
                .get("profile_id")
                .and_then(|entry| entry.as_str())
                .unwrap_or(profile_id)
                .to_owned();
            let _ = app.emit(
                "page-url-changed",
                json!({
                    "profileId": event_profile_id,
                    "url": url,
                }),
            );
            return;
        }

        if value.get("type").and_then(|entry| entry.as_str()) == Some("interactive_extract") {
            let event_profile_id = value
                .get("profile_id")
                .and_then(|entry| entry.as_str())
                .unwrap_or(profile_id)
                .to_owned();
            let mut payload = value.clone();
            if let Some(object) = payload.as_object_mut() {
                object.insert("profileId".to_owned(), json!(event_profile_id));
            }
            let _ = app.emit("interactive-extract-updated", payload);
            return;
        }

        if value.get("type").and_then(|entry| entry.as_str()) == Some("browser_status") {
            let status = value
                .get("status")
                .and_then(|entry| entry.as_str())
                .unwrap_or("unknown");
            let event_profile_id = value
                .get("profile_id")
                .and_then(|entry| entry.as_str())
                .unwrap_or(profile_id);
            if status == "stopped" {
                if let Ok(dir) = profile_user_data_dir(app, event_profile_id) {
                    purge_interactive_extract_cache(&dir);
                }
                let _ = app.emit(
                    "interactive-extract-cleared",
                    json!({ "profileId": event_profile_id }),
                );
            }
            let mut payload = json!({
                "profileId": event_profile_id,
                "status": status,
            });
            if let Some(cdp_port) = value.get("cdp_port").and_then(|entry| entry.as_u64()) {
                if let Some(object) = payload.as_object_mut() {
                    object.insert("cdpPort".to_owned(), json!(cdp_port));
                }
            }
            let _ = app.emit("browser-status", payload);
            return;
        }

        if value.get("kind").and_then(|entry| entry.as_str()) == Some("result")
            && value.get("message").and_then(|entry| entry.as_str()) == Some("browser_launched")
        {
            let data = value.get("data").and_then(|entry| entry.as_object());
            let event_profile_id = data
                .and_then(|entry| entry.get("profileId"))
                .and_then(|entry| entry.as_str())
                .unwrap_or(profile_id);
            let cdp_port = data
                .and_then(|entry| entry.get("cdpPort"))
                .and_then(|entry| entry.as_u64())
                .map(|entry| entry as u16)
                .unwrap_or(0);
            let theme_color = data
                .and_then(|entry| entry.get("themeColor"))
                .and_then(|entry| entry.as_str())
                .map(str::to_owned);
            let user_data_dir = data
                .and_then(|entry| entry.get("userDataDir"))
                .and_then(|entry| entry.as_str())
                .map(str::to_owned);
            if cdp_port > 0 {
                let profile_id_owned = event_profile_id.to_owned();
                std::thread::spawn(move || {
                    if let Err(error) = win_taskbar::apply_profile_taskbar_badge(
                        cdp_port,
                        &profile_id_owned,
                        theme_color.as_deref(),
                        user_data_dir.as_deref(),
                        12,
                    ) {
                        log_warn!("[taskbar_badge] profile={profile_id_owned} port={cdp_port}: {error}");
                    }
                });
            }
            return;
        }
    }

    emit_sidecar_line(app, line);
}

fn start_launch_sidecar_pump(
    app: AppHandle,
    profile_id: String,
    stdout: impl std::io::Read + Send + 'static,
    stderr: impl std::io::Read + Send + 'static,
) -> mpsc::Receiver<Result<(), AppError>> {
    let (launch_tx, launch_rx) = mpsc::sync_channel(1);
    let app_stdout = app.clone();
    let profile_stdout = profile_id.clone();

    std::thread::spawn(move || {
        let stdout_reader = BufReader::new(stdout);
        let mut launch_reported = false;

        for line in stdout_reader.lines() {
            let line = match line {
                Ok(value) => value,
                Err(_) => break,
            };

            emit_launch_sidecar_line(&app_stdout, &profile_stdout, &line);

            if launch_reported {
                continue;
            }

            match parse_launch_stdout_line(&line) {
                LaunchStdoutEvent::Launched => {
                    launch_reported = true;
                    let _ = launch_tx.send(Ok(()));
                }
                LaunchStdoutEvent::Failed(detail) => {
                    launch_reported = true;
                    let _ = launch_tx.send(Err(AppError::Launcher(format!(
                        "cloakbrowser launch failed: {detail}"
                    ))));
                }
                LaunchStdoutEvent::Ignore => {}
            }
        }

        if !launch_reported {
            let _ = launch_tx.send(Err(AppError::Launcher(
                "launch sidecar exited before browser_launched".to_owned(),
            )));
        }
    });

    let app_stderr = app;
    std::thread::spawn(move || {
        let stderr_reader = BufReader::new(stderr);
        for line in stderr_reader.lines().flatten() {
            emit_launch_sidecar_line(
                &app_stderr,
                &profile_id,
                &serde_json::json!({
                    "kind": "error",
                    "level": "error",
                    "message": "launch_sidecar_stderr",
                    "data": { "line": line }
                })
                .to_string(),
            );
        }
    });

    launch_rx
}

fn spawn_launch_exit_watcher(
    processes: Arc<DashMap<String, Child>>,
    app: AppHandle,
    database: Arc<std::sync::Mutex<Connection>>,
    profile_id: String,
) {
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(Duration::from_millis(500));

            let exited = if let Some(mut entry) = processes.get_mut(&profile_id) {
                match entry.try_wait() {
                    Ok(Some(_status)) => true,
                    Ok(None) => false,
                    Err(_) => true,
                }
            } else {
                break;
            };

            if !exited {
                continue;
            }

            processes.remove(&profile_id);

            if let Ok(numeric_id) = parse_profile_id(&profile_id) {
                if let Ok(connection) = database.lock() {
                    if let Ok(profile) = db::get_profile(&connection, numeric_id) {
                        if profile.status == "running" {
                            let _ = db::set_profile_stopped(&connection, numeric_id);
                            let _ = app.emit(
                                "browser-status",
                                json!({
                                    "profileId": profile_id,
                                    "status": "stopped",
                                }),
                            );
                        }
                    }
                }
            }

            break;
        }
    });
}

enum LaunchStdoutEvent {
    Launched,
    Failed(String),
    Ignore,
}

fn parse_launch_stdout_line(line: &str) -> LaunchStdoutEvent {
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(line) {
        if value.get("type").and_then(|entry| entry.as_str()) == Some("error")
            && value.get("code").and_then(|entry| entry.as_str()) == Some("LAUNCH_FAILED")
        {
            let message = value
                .get("message")
                .and_then(|entry| entry.as_str())
                .unwrap_or("unknown launch error");
            return LaunchStdoutEvent::Failed(message.to_owned());
        }

        if value.get("type").and_then(|entry| entry.as_str()) == Some("browser_status")
            && value.get("status").and_then(|entry| entry.as_str()) == Some("running")
        {
            return LaunchStdoutEvent::Launched;
        }

        if value.get("message").and_then(|entry| entry.as_str()) == Some("browser_launched") {
            return LaunchStdoutEvent::Launched;
        }

        if value.get("kind").and_then(|entry| entry.as_str()) == Some("error") {
            let message = value.get("message").and_then(|entry| entry.as_str()).unwrap_or("");
            if message == "launch_failed" || message == "unhandled_launch_error" {
                let detail = value
                    .get("data")
                    .and_then(|entry| entry.get("error"))
                    .and_then(|entry| entry.as_str())
                    .unwrap_or(message);
                return LaunchStdoutEvent::Failed(detail.to_owned());
            }
        }
    }

    if line.contains("browser_launched") || line.contains("\"type\":\"browser_status\"") {
        return LaunchStdoutEvent::Launched;
    }
    if line.contains("LAUNCH_FAILED") || line.contains("\"message\":\"launch_failed\"") {
        return LaunchStdoutEvent::Failed(line.to_owned());
    }

    LaunchStdoutEvent::Ignore
}

fn stop_child(mut child: Child) -> Result<(), AppError> {
    let pid = child.id();

    if let Some(stdin) = child.stdin.as_mut() {
        let _ = stdin.write_all(b"{\"command\":\"shutdown\"}\n");
        let _ = stdin.flush();
    }

    let deadline = std::time::Instant::now() + Duration::from_secs(12);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return Ok(()),
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    break;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(error) => {
                return Err(AppError::Launcher(format!(
                    "failed while waiting for browser exit: {error}"
                )));
            }
        }
    }

    let _ = kill_process_tree(pid);

    match child.try_wait() {
        Ok(Some(_)) => Ok(()),
        Ok(None) => {
            child
                .kill()
                .map_err(|error| AppError::Launcher(format!("failed to kill browser process: {error}")))?;
            child.wait().map_err(|error| {
                AppError::Launcher(format!("failed to wait for browser exit: {error}"))
            })?;
            Ok(())
        }
        Err(error) => Err(AppError::Launcher(format!(
            "failed while waiting for browser exit: {error}"
        ))),
    }
}

fn force_kill_profile_browser(app: &AppHandle, cdp_port: Option<i64>, user_data_dir: &str) -> bool {
    #[cfg(windows)]
    {
        if let Some(port) = cdp_port.filter(|value| *value > 0 && *value <= u16::MAX as i64) {
            if crate::win_taskbar::kill_browser_for_profile(port as u16, Some(user_data_dir)).is_ok()
            {
                return true;
            }
            if let Some(pid) = crate::win_taskbar::find_pid_listening_on_port(port as u16) {
                if kill_process_tree(pid).is_ok() {
                    return true;
                }
            }
        }
        // 无有效 CDP / 端口已释放：仍按 user-data-dir 清幽灵进程，释放收费席位
        if !user_data_dir.trim().is_empty()
            && crate::win_taskbar::kill_browsers_matching_user_data_dir(user_data_dir) > 0
        {
            return true;
        }
        let _ = app;
        return false;
    }

    #[cfg(not(windows))]
    {
        let Some(port) = cdp_port.filter(|value| *value > 0 && *value <= u16::MAX as i64) else {
            let _ = (app, user_data_dir);
            return false;
        };
        if let Some(pid) = crate::win_taskbar::find_pid_listening_on_port(port as u16) {
            return kill_process_tree(pid).is_ok();
        }
        let _ = app;
        false
    }
}

pub fn detect_browser_path() -> Result<PathBuf, AppError> {
    if let Some(path) = std::env::var_os("CLOAK_BROWSER_PATH").map(PathBuf::from) {
        if path.is_file() {
            return Ok(path);
        }
    }

    let mut candidates = Vec::new();
    if let Some(home) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")) {
        let cloak_cache = PathBuf::from(home).join(".cloakbrowser");
        if let Ok(entries) = std::fs::read_dir(&cloak_cache) {
            for entry in entries.flatten() {
                let chrome = entry.path().join("chrome.exe");
                if chrome.is_file() {
                    candidates.push(chrome);
                }
            }
        }
    }
    if let Some(program_files) = std::env::var_os("ProgramFiles") {
        let root = PathBuf::from(program_files);
        candidates.push(root.join("CloakBrowser/CloakBrowser.exe"));
        candidates.push(root.join("CloakForge Browser/CloakBrowser.exe"));
    }
    if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
        candidates.push(
            PathBuf::from(local_app_data).join("CloakBrowser/CloakBrowser.exe"),
        );
    }

    candidates
        .into_iter()
        .find(|path| path.is_file())
        .ok_or_else(|| {
            AppError::Validation(
                "CloakBrowser executable not found; set CLOAK_BROWSER_PATH".to_owned(),
            )
        })
}

pub fn resolve_browser_path(connection: &rusqlite::Connection) -> Result<PathBuf, AppError> {
    if let Some(raw) = db::get_setting(connection, "cloak_path")? {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            let path = PathBuf::from(trimmed);
            if path.is_file() {
                return Ok(path);
            }
            return Err(AppError::Validation(format!(
                "configured cloak_path does not exist: {trimmed}"
            )));
        }
    }
    detect_browser_path()
}
