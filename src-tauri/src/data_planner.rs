//! AI 多环境数据规划师 / 沙盘字段造数 — 调用 sidecar/dist/data_planner_cli.js（无需浏览器）

use std::process::Command;

use serde::Deserialize;
use serde_json::{json, Value};
use tauri::State;

use crate::db;
use crate::error::AppError;
use crate::process_win::prepare_sidecar_command;
use crate::profile_id::parse_profile_id;
use crate::proxy;
use crate::sidecar_paths::{resolve_sidecar_dist, sidecar_working_dir};
use crate::AppState;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxMockFieldInput {
    pub key: String,
    pub label: String,
    #[serde(default)]
    pub current_value: String,
}

fn extract_cli_result(stdout: &str, expect_type: &str) -> Result<Value, AppError> {
    for line in stdout.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };

        if value.get("type").and_then(|entry| entry.as_str()) == Some(expect_type) {
            return Ok(value);
        }

        if value.get("type").and_then(|entry| entry.as_str()) == Some("error") {
            let message = value
                .get("message")
                .and_then(|entry| entry.as_str())
                .unwrap_or("data planner failed");
            return Err(AppError::Llm(message.to_owned()));
        }

        if value.get("message").and_then(|entry| entry.as_str()) == Some("data_planner_failed") {
            let message = value
                .get("data")
                .and_then(|entry| entry.get("error"))
                .and_then(|entry| entry.as_str())
                .unwrap_or("data planner failed");
            return Err(AppError::Llm(message.to_owned()));
        }
    }

    Err(AppError::Llm(
        "data planner sidecar finished without result".to_owned(),
    ))
}

async fn invoke_data_planner_cli(config: &Value, expect_type: &str) -> Result<Value, AppError> {
    let entry = resolve_sidecar_dist("data_planner_cli.js")?;
    let sidecar_dir = sidecar_working_dir(&entry);

    let config_file = std::env::temp_dir().join(format!(
        "cloakforge-data-planner-{}-{}.json",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or(0)
    ));
    std::fs::write(&config_file, config.to_string())
        .map_err(|error| AppError::Sidecar(format!("failed to write planner config: {error}")))?;

    let mut command = Command::new("node");
    command
        .arg(&entry)
        .arg(format!("--config-file={}", config_file.display()));
    prepare_sidecar_command(&mut command);

    if let Some(dir) = sidecar_dir {
        command.current_dir(dir);
    }

    let output = tauri::async_runtime::spawn_blocking(move || command.output())
        .await
        .map_err(|error| AppError::Sidecar(error.to_string()))?
        .map_err(|error| AppError::Sidecar(format!("failed to spawn data planner: {error}")))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    if let Ok(result) = extract_cli_result(&stdout, expect_type) {
        return Ok(result);
    }

    let stderr = String::from_utf8_lossy(&output.stderr);
    if !stderr.trim().is_empty() {
        return Err(AppError::Llm(format!(
            "data planner stderr: {}",
            stderr.trim()
        )));
    }

    Err(AppError::Llm(format!(
        "data planner exited with status {}: {}",
        output.status,
        stdout.trim()
    )))
}

fn load_ai_settings_json(connection: &rusqlite::Connection) -> Result<Value, AppError> {
    let base_url = db::get_setting(connection, "deepseek_base_url")?
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "https://api.deepseek.com".to_owned());
    let agent_model = crate::fill_sidecar::resolve_stored_ai_agent_model(connection, &base_url)?;
    let chat_model = crate::fill_sidecar::resolve_stored_ai_text_model(connection, &base_url)?;
    let vision_model =
        crate::fill_sidecar::resolve_stored_ai_vision_model_setting(connection, &base_url)?;
    let api_key = crate::fill_sidecar::resolve_stored_ai_api_key(connection, &base_url)?
        .or_else(|| std::env::var("ZAI_API_KEY").ok())
        .or_else(|| std::env::var("DEEPSEEK_API_KEY").ok())
        .or_else(|| std::env::var("OPENAI_API_KEY").ok())
        .filter(|key| !key.trim().is_empty())
        .ok_or_else(|| {
            AppError::Validation("AI API key is not configured in global settings".to_owned())
        })?;

    Ok(json!({
        "apiKey": api_key,
        "apiBaseUrl": base_url,
        "textModel": agent_model,
        "agentModel": agent_model,
        "chatModel": chat_model,
        "visionModel": vision_model,
    }))
}

async fn resolve_env_geo_persona(
    state: &AppState,
    env_id: &str,
    geo_hint: Option<Value>,
) -> Result<(Value, Value), AppError> {
    let numeric_id = parse_profile_id(env_id)?;
    let (persona_raw, proxy_input) = {
        let connection = state
            .database
            .lock()
            .map_err(|_| AppError::State("database lock poisoned".to_owned()))?;
        let profile = db::get_profile(&connection, numeric_id)?;
        let persona = profile
            .persona_data
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
            .unwrap_or(Value::Null);
        let proxy_input = proxy::proxy_resolution_input_from_profile(&connection, &profile)?;
        (persona, proxy_input)
    };

    if let Some(hint) = geo_hint.filter(|value| value.is_object()) {
        return Ok((hint, persona_raw));
    }

    if let Some(input) = proxy_input {
        if let Ok(resolved) = proxy::resolve_profile_proxy_input(input).await {
            if let Ok(env) = crate::ip_geo::resolve_proxy_egress_env(&resolved).await {
                return Ok((
                    json!({
                        "exitIp": env.exit_ip,
                        "timezone": env.timezone,
                        "locale": env.locale,
                        "latitude": env.latitude,
                        "longitude": env.longitude,
                        "countryCode": env.country_code,
                        "country": env.country,
                        "region": env.region,
                        "city": env.city,
                    }),
                    persona_raw,
                ));
            }
        }
    }

    Ok((Value::Null, persona_raw))
}

/// 多环境轨迹数据分配规划（LLM）— 返回 { summary, planMatrix }
#[tauri::command]
pub async fn plan_batch_replay_data(
    state: State<'_, AppState>,
    selectors: Vec<String>,
    env_ids: Vec<String>,
    user_prompt: String,
    file_data: Option<String>,
) -> Result<Value, AppError> {
    if selectors.is_empty() {
        return Err(AppError::Validation(
            "selectors 为空：轨迹中没有可分配的填表字段".to_owned(),
        ));
    }
    if env_ids.is_empty() {
        return Err(AppError::Validation(
            "请至少选择一个环境".to_owned(),
        ));
    }
    for env_id in &env_ids {
        parse_profile_id(env_id)?;
    }

    let ai_settings = {
        let connection = state
            .database
            .lock()
            .map_err(|_| AppError::State("database lock poisoned".to_owned()))?;
        load_ai_settings_json(&connection)?
    };

    let file_trimmed = file_data
        .map(|value| value.chars().take(120_000).collect::<String>())
        .filter(|value| !value.trim().is_empty());

    let config = json!({
        "mode": "plan_batch",
        "selectors": selectors,
        "envIds": env_ids,
        "userPrompt": user_prompt,
        "fileData": file_trimmed,
        "aiSettings": ai_settings,
    });

    let raw = invoke_data_planner_cli(&config, "data_planner_result").await?;
    Ok(json!({
        "summary": raw.get("summary").cloned().unwrap_or_else(|| json!("")),
        "planMatrix": raw.get("planMatrix").cloned().unwrap_or_else(|| json!([])),
    }))
}

/// 沙盘字段级 AI 造数（单环境，可单字段或整表）— 强制 sidecar fast_text
#[tauri::command]
pub async fn mock_sandbox_fields(
    state: State<'_, AppState>,
    env_id: String,
    fields: Vec<SandboxMockFieldInput>,
    only_keys: Option<Vec<String>>,
    geo_hint: Option<Value>,
) -> Result<Value, AppError> {
    parse_profile_id(&env_id)?;
    if fields.is_empty() {
        return Err(AppError::Validation("fields 为空".to_owned()));
    }

    let ai_settings = {
        let connection = state
            .database
            .lock()
            .map_err(|_| AppError::State("database lock poisoned".to_owned()))?;
        load_ai_settings_json(&connection)?
    };

    let (geo, persona) = resolve_env_geo_persona(&state, &env_id, geo_hint).await?;

    let field_json: Vec<Value> = fields
        .into_iter()
        .map(|field| {
            json!({
                "key": field.key,
                "label": field.label,
                "currentValue": field.current_value,
            })
        })
        .collect();

    let config = json!({
        "mode": "mock_fields",
        "envId": env_id,
        "fields": field_json,
        "onlyKeys": only_keys,
        "geo": geo,
        "persona": persona,
        "aiSettings": ai_settings,
    });

    let raw = invoke_data_planner_cli(&config, "field_mock_result").await?;
    Ok(json!({
        "envId": raw.get("envId").cloned().unwrap_or_else(|| json!(env_id)),
        "valueOverrides": raw.get("valueOverrides").cloned().unwrap_or_else(|| json!({})),
        "summary": raw.get("summary").cloned().unwrap_or_else(|| json!("")),
    }))
}
