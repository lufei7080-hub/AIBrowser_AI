use std::process::{Command, Stdio};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::AppError;
use crate::process_win::hide_console_window;
use crate::sidecar_paths::{resolve_sidecar_dist, sidecar_working_dir};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct CloakBinaryStatus {
    pub installed: bool,
    pub version: Option<String>,
    pub bundled_version: Option<String>,
    pub tier: Option<String>,
    pub platform: Option<String>,
    pub binary_path: Option<String>,
    pub cache_dir: Option<String>,
    pub cache_root: Option<String>,
    pub chromium_dirs: Vec<String>,
    pub unused_count: u32,
    pub has_license: bool,
    pub release_channel: Option<String>,
    pub wrapper_version: Option<String>,
    pub browser_version_pin: Option<String>,
    pub license_valid: Option<bool>,
    pub license_plan: Option<String>,
    pub pro_latest_version: Option<String>,
    pub pro_resolved_channel: Option<String>,
    pub pro_channel_fallback: Option<bool>,
    pub session_seats_active: Option<u32>,
    pub session_seats_limit: Option<u32>,
    pub session_seats_state: Option<String>,
    pub license_key_source: Option<String>,
    pub updated: Option<bool>,
    pub updated_to: Option<String>,
    pub removed_count: Option<u32>,
    pub message: Option<String>,
    pub license_fallback_reason: Option<String>,
    pub diagnostic_ok: Option<bool>,
    pub diagnostic_summary: Option<String>,
    pub checks: Option<Vec<CloakDiagnosticCheck>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct CloakDiagnosticCheck {
    pub id: String,
    pub ok: bool,
    pub title: String,
    pub detail: String,
}

fn parse_binary_cli_output(stdout: &str, stderr: &str) -> Result<CloakBinaryStatus, AppError> {
    for line in stdout.lines().rev() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };

        let ok = value.get("ok").and_then(|entry| entry.as_bool()).unwrap_or(false);
        let data = value.get("data").cloned().unwrap_or_else(|| Value::Object(Default::default()));

        if !ok {
            let error = data
                .get("error")
                .and_then(|entry| entry.as_str())
                .or_else(|| value.get("message").and_then(|entry| entry.as_str()))
                .unwrap_or("binary_cli failed");
            return Err(AppError::Launcher(error.to_owned()));
        }

        let mut status: CloakBinaryStatus = serde_json::from_value(data.clone()).map_err(|error| {
            AppError::Launcher(format!(
                "binary_cli 响应解析失败: {error}; raw={data}"
            ))
        })?;
        if status.binary_path.as_ref().map(|value| value.trim().is_empty()) == Some(true) {
            status.binary_path = None;
        }
        status.message = value
            .get("message")
            .and_then(|entry| entry.as_str())
            .map(str::to_owned);
        return Ok(status);
    }

    let detail = if stderr.trim().is_empty() {
        stdout.trim().to_owned()
    } else {
        stderr.trim().to_owned()
    };
    Err(AppError::Launcher(format!(
        "binary_cli 无有效输出: {detail}"
    )))
}

fn run_binary_cli(
    action: &str,
    license_key: Option<&str>,
    browser_version: Option<&str>,
) -> Result<CloakBinaryStatus, AppError> {
    let entry = resolve_sidecar_dist("binary_cli.js").map_err(|error| match error {
        AppError::Sidecar(message) => AppError::Launcher(message),
        other => other,
    })?;
    let workdir = sidecar_working_dir(&entry);

    let mut command = Command::new("node");
    command
        .arg(&entry)
        .arg(format!("--action={action}"))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    if let Some(key) = license_key.map(str::trim).filter(|value| !value.is_empty()) {
        command.env("CLOAKBROWSER_LICENSE_KEY", key);
    } else {
        command.env_remove("CLOAKBROWSER_LICENSE_KEY");
    }

    if let Some(version) = browser_version.map(str::trim).filter(|value| !value.is_empty()) {
        command.arg(format!("--browser-version={version}"));
    }

    if let Some(dir) = workdir {
        command.current_dir(dir);
    }
    hide_console_window(&mut command);

    let output = command.output().map_err(|error| {
        AppError::Launcher(format!(
            "无法启动内核管理脚本（请确认已安装 Node.js）: {error}"
        ))
    })?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    parse_binary_cli_output(&stdout, &stderr)
}

pub fn fetch_cloak_binary_status(
    license_key: Option<String>,
    browser_version: Option<String>,
) -> Result<CloakBinaryStatus, AppError> {
    run_binary_cli(
        "status",
        license_key.as_deref(),
        browser_version.as_deref(),
    )
}

#[tauri::command]
pub async fn get_cloak_binary_status(
    license_key: Option<String>,
    browser_version: Option<String>,
) -> Result<CloakBinaryStatus, AppError> {
    tauri::async_runtime::spawn_blocking(move || {
        fetch_cloak_binary_status(license_key, browser_version)
    })
    .await
    .map_err(|error| AppError::Launcher(error.to_string()))?
}

#[tauri::command]
pub async fn download_cloak_binary(
    license_key: Option<String>,
    browser_version: Option<String>,
) -> Result<CloakBinaryStatus, AppError> {
    tauri::async_runtime::spawn_blocking(move || {
        run_binary_cli(
            "download",
            license_key.as_deref(),
            browser_version.as_deref(),
        )
    })
    .await
    .map_err(|error| AppError::Launcher(error.to_string()))?
}

#[tauri::command]
pub async fn update_cloak_binary(
    license_key: Option<String>,
    browser_version: Option<String>,
) -> Result<CloakBinaryStatus, AppError> {
    tauri::async_runtime::spawn_blocking(move || {
        run_binary_cli(
            "update",
            license_key.as_deref(),
            browser_version.as_deref(),
        )
    })
    .await
    .map_err(|error| AppError::Launcher(error.to_string()))?
}

#[tauri::command]
pub async fn cleanup_cloak_binary(
    license_key: Option<String>,
    browser_version: Option<String>,
) -> Result<CloakBinaryStatus, AppError> {
    tauri::async_runtime::spawn_blocking(move || {
        run_binary_cli(
            "cleanup",
            license_key.as_deref(),
            browser_version.as_deref(),
        )
    })
    .await
    .map_err(|error| AppError::Launcher(error.to_string()))?
}

#[tauri::command]
pub async fn diagnose_cloak_binary(
    license_key: Option<String>,
    browser_version: Option<String>,
) -> Result<CloakBinaryStatus, AppError> {
    tauri::async_runtime::spawn_blocking(move || {
        run_binary_cli(
            "diagnose",
            license_key.as_deref(),
            browser_version.as_deref(),
        )
    })
    .await
    .map_err(|error| AppError::Launcher(error.to_string()))?
}
