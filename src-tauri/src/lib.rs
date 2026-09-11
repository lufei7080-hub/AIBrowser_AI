pub mod ai;
pub mod browser_manager;
pub mod cache_cleanup;
pub mod cloak_binary;
pub mod commands;
pub mod cookie_ops;
pub mod data_planner;
pub mod db;
pub mod db_write_queue;
pub mod error;
pub mod extension_paths;
pub mod fill_sidecar;
pub mod trajectory_files;
pub mod key_file;
pub mod local_ipc;
pub mod ip_geo;
pub mod kernel_policy;
pub mod logging;
pub mod models;
pub mod process_win;
pub mod profile_id;
pub mod proxy;
pub mod rpa_session;
pub mod settings_probe;
pub mod sidecar;
pub mod sidecar_paths;
pub mod storage_paths;
pub mod webview;
pub mod win_taskbar;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use rusqlite::Connection;
use tauri::{Manager, RunEvent};

use crate::ai::ai_chat;
use crate::data_planner::{mock_sandbox_fields, plan_batch_replay_data};
use crate::browser_manager::{
    focus_profile_browser, get_running_profile_ids, start_profile, stop_all_profiles, stop_profile,
    BrowserManager,
};
use crate::commands::{
    add_dynamic_api_proxy, add_proxy, batch_add_proxies, batch_create_profiles, batch_delete_profiles,
    batch_delete_proxies, clear_agent_control_memory, create_profile, delete_agent_trajectory,
    delete_profile, delete_template, export_profile_cookies, export_text_to_download_dir,
    get_profile_interactive_extract, get_profiles, get_proxies, get_settings,
    get_templates_by_domain, import_profile_cookies, list_agent_control_memory,
    list_agent_trajectories, lookup_profiles_ip_geo, open_path_in_os, pick_directory,
    prepare_console_exit, request_profile_interactive_extract, save_agent_trajectory,
    save_template, set_profile_agent_panorama,
    set_profile_interactive_extract, test_proxy_connection, toggle_template_auto_apply,
    update_profile, update_setting, upsert_agent_control_memory, purge_automation_cache,
};
use crate::db::init_database;
use crate::db_write_queue::DbWriteQueue;
use crate::local_ipc::LocalIpcServer;
use crate::error::AppError;
use crate::cloak_binary::{
    cleanup_cloak_binary, diagnose_cloak_binary, download_cloak_binary, get_cloak_binary_status,
    update_cloak_binary,
};
use crate::settings_probe::{
    detect_cloak_path, test_ai_connection, test_cloak_path, verify_cloak_license,
};
use crate::rpa_session::{
    abort_autonomous_agent, bring_profile_to_front, cancel_agent_action, confirm_agent_action,
    continue_agent_handover, get_profile_page_url, pause_rpa_fill, replay_agent_trajectory,
    reply_agent_ask, rescan_rpa_page, resume_rpa_fill, run_rpa_fill, start_autonomous_agent,
    start_rpa_session, stop_rpa_session, RpaSessionManager,
};
use crate::key_file::{
    check_license_entitlement, clear_cloak_license_key, import_key_file, pick_key_file,
    set_cloak_license_key, test_key_file,
};
use crate::sidecar::{preview_ai_fill, run_ai_fill, run_direct_fill, run_smart_fill};

pub struct AppState {
    pub database: Arc<Mutex<Connection>>,
    /// 前端在退出确认框选择「否（保留浏览器）」时为 true，
    /// shutdown_all_runtimes 据此跳过清进程树，避免覆盖用户意图。
    pub keep_runtime_on_exit: Arc<AtomicBool>,
    /// Milestone 1：数据库单写队列（所有落库上报统一由此串行写入）
    pub db_queue: Arc<DbWriteQueue>,
    /// Milestone 1：本地 IPC 服务句柄（Node Sidecar 通过 HTTP /report 上报）
    pub local_ipc: LocalIpcServer,
}

fn shutdown_all_runtimes(app: &tauri::AppHandle) {
    static DONE: AtomicBool = AtomicBool::new(false);
    if DONE.swap(true, Ordering::SeqCst) {
        return;
    }

    // 用户选择「否（保留浏览器）」：跳过清进程树，保留浏览器/Agent/代理扩展。
    let keep_running = app
        .try_state::<AppState>()
        .map(|state| state.keep_runtime_on_exit.load(Ordering::SeqCst))
        .unwrap_or(false);
    if keep_running {
        log_info!("CloakForge: console exiting while keeping runtimes alive (skip cleanup)");
        return;
    }

    log_info!("CloakForge: shutting down sidecars and browser processes");

    if let Some(rpa) = app.try_state::<RpaSessionManager>() {
        rpa.stop_all_sessions();
    }

    if let Some(manager) = app.try_state::<BrowserManager>() {
        if let Some(db_state) = app.try_state::<AppState>() {
            if let Err(error) = manager.stop_all_profiles(app, db_state.inner()) {
                log_error!("CloakForge: shutdown stop_all_profiles failed: {error}");
            }
        }
    }

    // —— Milestone 1：优雅退出 ——
    // 1) 先停本地 IPC（拒绝新上报，等待在途 HTTP 请求处理完毕）
    // 2) 再排空单写队列（FIFO 执行完存量命令后 join 写线程，不丢上报数据）
    if let Some(state) = app.try_state::<AppState>() {
        state.local_ipc.shutdown();
        state.db_queue.shutdown();
    }

    crate::proxy::purge_all_proxy_auth_extensions();
}

pub fn run() {
    let result = tauri::Builder::default()
        .setup(|app| {
            let app_data_dir = app
                .path()
                .app_data_dir()
                .map_err(|error| AppError::Filesystem(error.to_string()))?;
            let database_path = app_data_dir.join("cloakforge.sqlite3");
            let connection = init_database(&database_path)?;
            let reset_count = crate::db::reset_stale_running_profiles(&connection)?;
            if reset_count > 0 {
                log_warn!(
                    "CloakForge: reset {reset_count} stale running profile(s) after restart"
                );
            }

            // —— Milestone 1：数据库单写队列 + 本地 IPC 服务 ——
            let database = Arc::new(Mutex::new(connection));
            let db_queue = Arc::new(DbWriteQueue::new(database.clone())?);
            let local_ipc = crate::local_ipc::start_local_ipc(app.handle().clone(), db_queue.clone())?;
            log_info!("CloakForge: local ipc server listening at {}", local_ipc.base_url);

            app.manage(AppState {
                database,
                keep_runtime_on_exit: Arc::new(AtomicBool::new(false)),
                db_queue,
                local_ipc,
            });
            app.manage(BrowserManager::default());
            app.manage(RpaSessionManager::default());

            if let Some(window) = app.get_webview_window("main") {
                if let Err(error) = webview::disable_default_browser_ui(&window) {
                    log_warn!("CloakForge: webview hardening skipped: {error}");
                }
                // 运行时注入 256 RGBA，避免 exe 内嵌旧 ICO/BMP 在任务栏发糊
                const ICON_RGBA: &[u8] = include_bytes!("../icons/icon_256.rgba");
                const ICON_SIZE: u32 = 256;
                if ICON_RGBA.len() == (ICON_SIZE * ICON_SIZE * 4) as usize {
                    let icon = tauri::image::Image::new_owned(
                        ICON_RGBA.to_vec(),
                        ICON_SIZE,
                        ICON_SIZE,
                    );
                    if let Err(error) = window.set_icon(icon) {
                        log_warn!("CloakForge: set window icon skipped: {error}");
                    }
                } else {
                    log_warn!(
                        "CloakForge: icon_256.rgba size mismatch: {}",
                        ICON_RGBA.len()
                    );
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_profiles,
            lookup_profiles_ip_geo,
            get_settings,
            update_setting,
            get_proxies,
            add_proxy,
            batch_add_proxies,
            batch_delete_proxies,
            create_profile,
            batch_create_profiles,
            update_profile,
            set_profile_interactive_extract,
            set_profile_agent_panorama,
            get_profile_interactive_extract,
            request_profile_interactive_extract,
            delete_profile,
            batch_delete_profiles,
            purge_automation_cache,
            test_proxy_connection,
            add_dynamic_api_proxy,
            start_profile,
            stop_profile,
            stop_all_profiles,
            get_running_profile_ids,
            focus_profile_browser,
            preview_ai_fill,
            run_ai_fill,
            run_direct_fill,
            run_smart_fill,
            start_rpa_session,
            stop_rpa_session,
            run_rpa_fill,
            resume_rpa_fill,
            rescan_rpa_page,
            pause_rpa_fill,
            get_profile_page_url,
            start_autonomous_agent,
            confirm_agent_action,
            cancel_agent_action,
            reply_agent_ask,
            continue_agent_handover,
            abort_autonomous_agent,
            bring_profile_to_front,
            replay_agent_trajectory,
            plan_batch_replay_data,
            mock_sandbox_fields,
            save_template,
            get_templates_by_domain,
            delete_template,
            toggle_template_auto_apply,
            save_agent_trajectory,
            list_agent_trajectories,
            delete_agent_trajectory,
            upsert_agent_control_memory,
            list_agent_control_memory,
            clear_agent_control_memory,
            ai_chat,
            test_ai_connection,
            test_cloak_path,
            detect_cloak_path,
            verify_cloak_license,
            get_cloak_binary_status,
            download_cloak_binary,
            update_cloak_binary,
            cleanup_cloak_binary,
            diagnose_cloak_binary,
            export_profile_cookies,
            import_profile_cookies,
            pick_key_file,
            import_key_file,
            test_key_file,
            set_cloak_license_key,
            clear_cloak_license_key,
            check_license_entitlement,
            pick_directory,
            open_path_in_os,
            export_text_to_download_dir,
            prepare_console_exit
        ])
        .build(tauri::generate_context!());

    match result {
        Ok(app) => {
            app.run(|app_handle, event| match event {
                // 最终兜底：进程真正退出前同步清进程树（不可取消）。
                // 注意：CloseRequested 由前端 useAppCloseGuard 弹「退出确认框」处理，
                // Rust 侧不得在此抢跑 exit，否则确认弹窗会被吞掉。
                RunEvent::ExitRequested { .. } => {
                    shutdown_all_runtimes(app_handle);
                }
                RunEvent::Exit => {
                    shutdown_all_runtimes(app_handle);
                }
                _ => {}
            });
        }
        Err(error) => {
            log_error!("CloakForge failed to start: {error}");
        }
    }
}
