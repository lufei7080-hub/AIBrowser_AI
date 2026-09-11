use std::process::Command;

use serde_json::{json, Value};
use tauri::{AppHandle, State};

use crate::browser_manager::BrowserManager;
use crate::db;
use crate::error::AppError;
use crate::process_win::hide_console_window;
use crate::profile_id::parse_profile_id;
use crate::rpa_session::RpaSessionManager;
use crate::sidecar_paths::{resolve_sidecar_dist, sidecar_working_dir};
use crate::AppState;

fn trim_command_punctuation(message: &str) -> &str {
    message.trim().trim_end_matches(['。', '.', '!', '！', '?', '？', '~', '～'])
}

fn has_explicit_navigate_intent(message: &str) -> bool {
    let compact = trim_command_punctuation(message);
    // 纯「打开/访问」或「打开浏览器」属于启动，不是打开网页
    if compact.is_empty()
        || compact == "打开"
        || compact == "访问"
        || compact.eq_ignore_ascii_case("open")
        || compact.eq_ignore_ascii_case("visit")
    {
        return false;
    }
    if compact.starts_with("打开浏览器")
        || compact.starts_with("打开环境")
        || compact.starts_with("打开窗口")
        || compact.eq_ignore_ascii_case("open browser")
    {
        return false;
    }
    compact.starts_with("打开")
        || compact.starts_with("访问")
        || compact.starts_with("去一下")
        || compact.starts_with("直接搜索")
        || compact.starts_with("搜索")
        || compact.starts_with("搜一下")
        || compact.to_ascii_lowercase().starts_with("open ")
        || compact.to_ascii_lowercase().starts_with("visit ")
}

fn extract_profile_id_from_message(message: &str) -> Option<String> {
    let compact = trim_command_punctuation(message);
    for prefix in [
        "启动环境#",
        "启动环境",
        "开启环境#",
        "开启环境",
        "运行环境#",
        "运行环境",
        "启动#",
        "开启#",
        "运行#",
        "停止环境#",
        "停止环境",
        "关闭环境#",
        "关闭环境",
        "退出环境#",
        "退出环境",
        "环境#",
    ] {
        if let Some(rest) = compact.strip_prefix(prefix) {
            let digits: String = rest
                .chars()
                .skip_while(|ch| *ch == ' ' || *ch == '#')
                .take_while(|ch| ch.is_ascii_digit())
                .collect();
            if !digits.is_empty() {
                return Some(digits);
            }
        }
    }
    None
}

fn resolve_chat_profile_id(message: &str, profile_id: Option<&str>) -> Option<String> {
    profile_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .or_else(|| extract_profile_id_from_message(message))
}

fn is_start_browser_command(message: &str) -> bool {
    let compact = trim_command_punctuation(message);
    if compact.is_empty() || has_explicit_navigate_intent(compact) {
        return false;
    }

    let start_prefixes = ["启动", "开启", "运行", "打开"];
    let start_targets = ["", "浏览器", "环境", "窗口", "browser", "profile"];

    for prefix in start_prefixes {
        for target in start_targets {
            if compact.eq_ignore_ascii_case(&format!("{prefix}{target}")) {
                return true;
            }
        }
    }

    compact.eq_ignore_ascii_case("start")
        || compact.eq_ignore_ascii_case("start browser")
        || compact.eq_ignore_ascii_case("start profile")
        || compact.starts_with("启动环境")
        || compact.starts_with("开启环境")
        || compact.starts_with("运行环境")
}

fn is_close_tab_command(message: &str) -> bool {
    let trimmed = message.trim();
    if trimmed.is_empty() {
        return false;
    }
    let lower = trimmed.to_ascii_lowercase();
    if lower == "close tab" || lower == "close page" {
        return true;
    }
    // 必须是「关闭/关掉 + 标签/页面/网页」，禁止仅凭包含「网页」误判（否则「打开网页」会被当成关标签）
    let compact = trim_command_punctuation(trimmed);
    compact.starts_with("关闭标签")
        || compact.starts_with("关闭标签页")
        || compact.starts_with("关闭页面")
        || compact.starts_with("关闭网页")
        || compact.starts_with("关掉标签")
        || compact.starts_with("关掉标签页")
        || compact.starts_with("关掉页面")
        || compact.starts_with("关掉网页")
        || compact.starts_with("关闭当前标签")
        || compact.starts_with("关闭当前页面")
        || compact.starts_with("关闭当前网页")
        || compact.starts_with("关掉当前标签")
        || compact.starts_with("关掉当前页面")
        || compact.starts_with("关掉当前网页")
}

fn is_stop_browser_command(message: &str) -> bool {
    let trimmed = message.trim();
    if trimmed.is_empty() || is_close_tab_command(trimmed) {
        return false;
    }

    let compact = trim_command_punctuation(message);
    if compact.is_empty() || is_close_tab_command(trimmed) {
        return false;
    }

    let stop_prefixes = ["停止", "关闭", "退出", "关掉", "结束"];
    let stop_targets = ["", "浏览器", "环境", "窗口", "browser", "profile"];

    for prefix in stop_prefixes {
        for target in stop_targets {
            if compact.eq_ignore_ascii_case(&format!("{prefix}{target}")) {
                return true;
            }
        }
    }

    compact.eq_ignore_ascii_case("stop")
        || compact.eq_ignore_ascii_case("stop browser")
        || compact.eq_ignore_ascii_case("stop profile")
}

async fn try_handle_start_browser_command(
    app: &AppHandle,
    state: &AppState,
    manager: &BrowserManager,
    message: &str,
    profile_id: Option<&str>,
) -> Result<Option<String>, AppError> {
    let profile_id = resolve_chat_profile_id(message, profile_id);
    let Some(profile_id) = profile_id else {
        return Ok(Some(
            "请先在左侧选择一个环境，或说「启动环境3」指定编号。".to_owned(),
        ));
    };

    let numeric_id = parse_profile_id(&profile_id)?;
    let (name, running, cdp_port) = {
        let connection = state
            .database
            .lock()
            .map_err(|_| AppError::State("database lock poisoned".to_owned()))?;
        let profile = db::get_profile(&connection, numeric_id)?;
        (
            profile.name.clone(),
            profile.status == "running",
            profile.cdp_port.map(|port| port as u16),
        )
    };

    if running {
        let cdp_hint = cdp_port
            .map(|port| format!("，CDP :{port}"))
            .unwrap_or_default();
        return Ok(Some(format!(
            "环境 #{profile_id}（{name}）已在运行{cdp_hint}。"
        )));
    }

    let result = manager
        .start_profile(app, state, profile_id.clone())
        .await?;

    let mut reply = format!(
        "好的，已启动环境 #{profile_id}（{name}），CDP :{}。",
        result.cdp_port
    );
    if let Some(geo) = result.ip_geo {
        if let Some(ip) = geo.ip.filter(|value| !value.trim().is_empty()) {
            reply.push_str(&format!("\n出口 IP：{ip}"));
            if let Some(country) = geo.country.filter(|value| !value.trim().is_empty()) {
                reply.push_str(&format!(" · {country}"));
            }
        }
    }
    reply.push_str("\n需要我继续打开页面或填表，直接告诉我。");
    Ok(Some(reply))
}

async fn try_handle_stop_browser_command(
    app: &AppHandle,
    state: &AppState,
    manager: &BrowserManager,
    rpa_manager: &RpaSessionManager,
    message: &str,
    profile_id: Option<&str>,
) -> Result<Option<String>, AppError> {
    let profile_id = resolve_chat_profile_id(message, profile_id);
    let Some(profile_id) = profile_id else {
        return Ok(Some(
            "请先在左侧选择一个环境，或说「停止环境3」指定编号。".to_owned(),
        ));
    };

    let numeric_id = parse_profile_id(&profile_id)?;
    let running = {
        let connection = state
            .database
            .lock()
            .map_err(|_| AppError::State("database lock poisoned".to_owned()))?;
        let profile = db::get_profile(&connection, numeric_id)?;
        profile.status == "running"
    };

    let _ = rpa_manager.stop_session(&profile_id);

    if !running {
        return Ok(Some(format!(
            "环境 #{profile_id} 当前未运行，无需停止。"
        )));
    }

    manager.stop_profile(app, state, profile_id.clone())?;
    Ok(Some(format!(
        "好的，已停止环境 #{profile_id} 的浏览器。需要时再叫我。"
    )))
}

#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
pub struct ChatHistoryMessage {
    pub role: String,
    pub content: String,
}

fn local_chat_reply(message: &str, profile_id: Option<&str>) -> String {
    let profile_hint = profile_id
        .map(|id| format!("\n当前环境: #{id}"))
        .unwrap_or_default();

    format!(
        "【本地模式】未配置 DEEPSEEK_API_KEY，以下为离线回复。{profile_hint}\n\n\
         收到: 「{message}」\n\n\
         可在「全局设置 → AI 设置」中配置 DEEPSEEK_API_KEY 后启用真实 AI 对话；\
         也可询问填表策略、风控分数含义或原始填表数据解析。"
    )
}

fn extract_chat_reply(stdout: &str) -> Result<String, AppError> {
    for line in stdout.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };

        if value.get("type").and_then(|entry| entry.as_str()) == Some("chat_reply") {
            if let Some(reply) = value.get("reply").and_then(|entry| entry.as_str()) {
                if !reply.trim().is_empty() {
                    return Ok(reply.to_owned());
                }
            }
        }

        if value.get("message").and_then(|entry| entry.as_str()) == Some("chat_complete") {
            if let Some(reply) = value
                .get("data")
                .and_then(|entry| entry.get("reply"))
                .and_then(|entry| entry.as_str())
            {
                if !reply.trim().is_empty() {
                    return Ok(reply.to_owned());
                }
            }
        }

        if value.get("type").and_then(|entry| entry.as_str()) == Some("error") {
            let code = value
                .get("code")
                .and_then(|entry| entry.as_str())
                .unwrap_or("CHAT_FAILED");
            let message = value
                .get("message")
                .and_then(|entry| entry.as_str())
                .unwrap_or("unknown chat error");
            return Err(AppError::Llm(format!("{code}: {message}")));
        }

        if value.get("message").and_then(|entry| entry.as_str()) == Some("chat_failed") {
            let message = value
                .get("data")
                .and_then(|entry| entry.get("error"))
                .and_then(|entry| entry.as_str())
                .unwrap_or("chat sidecar failed");
            return Err(AppError::Llm(message.to_owned()));
        }
    }

    Err(AppError::Llm(
        "chat sidecar finished without chat_reply".to_owned(),
    ))
}

async fn invoke_sidecar_chat(config: &Value) -> Result<String, AppError> {
    let chat_entry = resolve_sidecar_dist("chat.js")?;
    let sidecar_dir = sidecar_working_dir(&chat_entry);

    let config_file = std::env::temp_dir().join(format!(
        "cloakforge-chat-{}.json",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|value| value.as_millis())
            .unwrap_or(0)
    ));
    std::fs::write(&config_file, config.to_string())
        .map_err(|error| AppError::Sidecar(format!("failed to write chat config: {error}")))?;

    let mut command = Command::new("node");
    command
        .arg(&chat_entry)
        .arg(format!("--config-file={}", config_file.display()));
    hide_console_window(&mut command);

    if let Some(dir) = sidecar_dir {
        command.current_dir(dir);
    }

    let output = tauri::async_runtime::spawn_blocking(move || command.output())
        .await
        .map_err(|error| AppError::Sidecar(error.to_string()))?
        .map_err(|error| AppError::Sidecar(format!("failed to spawn chat sidecar: {error}")))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    if let Ok(reply) = extract_chat_reply(&stdout) {
        return Ok(reply);
    }

    let stderr = String::from_utf8_lossy(&output.stderr);
    if !stderr.trim().is_empty() {
        return Err(AppError::Llm(format!("chat sidecar stderr: {}", stderr.trim())));
    }

    Err(AppError::Llm(format!(
        "chat sidecar exited with status {}: {}",
        output.status,
        stdout.trim()
    )))
}

#[tauri::command]
pub async fn ai_chat(
    app: AppHandle,
    state: State<'_, AppState>,
    manager: State<'_, BrowserManager>,
    rpa_manager: State<'_, RpaSessionManager>,
    message: String,
    profile_id: Option<String>,
    history: Option<Vec<ChatHistoryMessage>>,
) -> Result<String, AppError> {
    let trimmed = message.trim();
    if trimmed.is_empty() {
        return Err(AppError::Validation("chat message cannot be empty".to_owned()));
    }

    if is_start_browser_command(trimmed) {
        if let Some(reply) = try_handle_start_browser_command(
            &app,
            &state,
            &manager,
            trimmed,
            profile_id.as_deref(),
        )
        .await?
        {
            return Ok(reply);
        }
    }

    if is_stop_browser_command(trimmed) {
        if let Some(reply) = try_handle_stop_browser_command(
            &app,
            &state,
            &manager,
            &rpa_manager,
            trimmed,
            profile_id.as_deref(),
        )
        .await?
        {
            return Ok(reply);
        }
    }

    let (api_key, base_url, model, vision_model, cdp_port, user_data_dir) = {
        let connection = state
            .database
            .lock()
            .map_err(|_| AppError::State("database lock poisoned".to_owned()))?;

        let base_url = db::get_setting(&connection, "deepseek_base_url")?
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| "https://api.deepseek.com".to_owned());
        let model = crate::fill_sidecar::resolve_stored_ai_text_model(&connection, &base_url)?;
        let vision_model =
            crate::fill_sidecar::resolve_stored_ai_vision_model_setting(&connection, &base_url)?;
        let api_key = crate::fill_sidecar::resolve_stored_ai_api_key(&connection, &base_url)?
            .or_else(|| std::env::var("ZAI_API_KEY").ok())
            .or_else(|| std::env::var("DEEPSEEK_API_KEY").ok())
            .or_else(|| std::env::var("OPENAI_API_KEY").ok());

        let cdp_port = if let Some(ref profile_id) = profile_id {
            let numeric_id = parse_profile_id(profile_id)?;
            let profile = db::get_profile(&connection, numeric_id)?;
            if profile.status == "running" {
                profile.cdp_port.map(|port| port as u16)
            } else {
                None
            }
        } else {
            None
        };

        let user_data_dir = if let Some(ref profile_id) = profile_id {
            crate::fill_sidecar::resolve_profile_user_data_dir(&app, profile_id)
                .ok()
                .map(|path| path.to_string_lossy().to_string())
        } else {
            None
        };

        (api_key, base_url, model, vision_model, cdp_port, user_data_dir)
    };

    let Some(api_key) = api_key.filter(|key| !key.trim().is_empty()) else {
        return Ok(local_chat_reply(trimmed, profile_id.as_deref()));
    };

    let chat_config = json!({
        "message": trimmed,
        "history": history.unwrap_or_default(),
        "profileId": profile_id,
        "cdpPort": cdp_port,
        "userDataDir": user_data_dir,
        "aiSettings": {
            "apiKey": api_key,
            "apiBaseUrl": base_url,
            "textModel": model,
            "visionModel": vision_model,
        }
    });

    invoke_sidecar_chat(&chat_config).await
}
