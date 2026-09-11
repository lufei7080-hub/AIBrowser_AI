use std::path::Path;

use crate::browser_manager;
use crate::cloak_binary;
use crate::error::AppError;

fn normalize_base_url(base_url: &str) -> Result<String, AppError> {
    let trimmed = base_url.trim();
    if trimmed.is_empty() {
        return Err(AppError::Validation("API base URL cannot be empty".to_owned()));
    }
    Ok(trimmed.trim_end_matches('/').to_owned())
}

#[tauri::command]
pub async fn test_ai_connection(base_url: String, api_key: String) -> Result<(), AppError> {
    let base_url = normalize_base_url(&base_url)?;
    let api_key = api_key.trim();
    if api_key.is_empty() {
        return Err(AppError::Validation("API key cannot be empty".to_owned()));
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|error| AppError::Llm(error.to_string()))?;

    let response = client
        .get(format!("{base_url}/models"))
        .bearer_auth(api_key)
        .send()
        .await
        .map_err(|error| AppError::Llm(format!("AI connection request failed: {error}")))?;

    if response.status().is_success() {
        return Ok(());
    }

    let status = response.status();
    let body = response
        .text()
        .await
        .unwrap_or_else(|_| "unable to read response body".to_owned());
    Err(AppError::Llm(format!(
        "AI connection test failed ({status}): {body}"
    )))
}

#[tauri::command]
pub fn test_cloak_path(path: String) -> Result<(), AppError> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err(AppError::Validation("CloakBrowser path cannot be empty".to_owned()));
    }

    let file_path = Path::new(trimmed);
    if !file_path.exists() {
        return Err(AppError::Validation(format!(
            "path does not exist: {trimmed}"
        )));
    }
    if !file_path.is_file() {
        return Err(AppError::Validation(format!(
            "path is not a file: {trimmed}"
        )));
    }

    #[cfg(windows)]
    {
        let extension = file_path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .eq_ignore_ascii_case("exe");
        if !extension {
            return Err(AppError::Validation(
                "Windows CloakBrowser path must point to a .exe file".to_owned(),
            ));
        }
    }

    Ok(())
}

#[tauri::command]
pub fn detect_cloak_path() -> Result<String, AppError> {
    let path = browser_manager::detect_browser_path()?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn verify_cloak_license(key: String, path: String) -> Result<(), AppError> {
    test_cloak_path(path)?;
    let license = key.trim();
    if license.is_empty() {
        return Err(AppError::Validation("license key cannot be empty".to_owned()));
    }

    let status = cloak_binary::fetch_cloak_binary_status(Some(license.to_owned()), None)?;
    if status.license_valid.unwrap_or(false) {
        return Ok(());
    }

    let detail = status
        .message
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "invalid license key or license service unreachable".to_owned());

    Err(AppError::Validation(format!("license verification failed: {detail}")))
}
