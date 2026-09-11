//! Dual-kernel AI gate: free Key + 151-pro pin → fingerprint only (no AI).

use crate::error::AppError;
use std::path::PathBuf;

pub const FREE_CHROMIUM_VERSION: &str = "146.0.7680.177.5";
pub const BUNDLED_PRO_CHROMIUM_VERSION: &str = "151.0.7922.108.3";

pub fn is_fingerprint_only_kernel_pin(browser_version: &str) -> bool {
    let v = browser_version.trim();
    !v.is_empty()
        && (v == BUNDLED_PRO_CHROMIUM_VERSION || v.starts_with(BUNDLED_PRO_CHROMIUM_VERSION))
}

pub fn ai_blocked_kernel_message(browser_version: &str) -> String {
    let pin = if browser_version.trim().is_empty() {
        BUNDLED_PRO_CHROMIUM_VERSION
    } else {
        browser_version.trim()
    };
    format!(
        "免费 License 下内核 {pin} 仅允许指纹浏览，不可进行 AI / Agent / 智能填表。请改为免费核（{FREE_CHROMIUM_VERSION}）或升级 Pro。打开浏览器数量不受限制。"
    )
}

/// Resolve Browse/ next to exe (portable) or cwd (dev).
pub fn resolve_bundled_browse_root() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("Browse"));
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("Browse"));
        if let Ok(canon) = cwd.join("..").join("Browse").canonicalize() {
            candidates.push(canon);
        } else {
            candidates.push(cwd.join("..").join("Browse"));
        }
    }
    for root in candidates {
        let chrome = root
            .join(format!("chromium-{BUNDLED_PRO_CHROMIUM_VERSION}-pro"))
            .join("chrome.exe");
        if chrome.is_file() {
            return Some(root);
        }
    }
    None
}

pub fn assert_ai_allowed_for_browser_version(
    is_pro_license: bool,
    browser_version: &str,
) -> Result<(), AppError> {
    if is_pro_license {
        return Ok(());
    }
    if is_fingerprint_only_kernel_pin(browser_version) {
        return Err(AppError::Validation(ai_blocked_kernel_message(
            browser_version,
        )));
    }
    Ok(())
}
