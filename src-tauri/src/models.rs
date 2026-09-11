use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Profile {
    pub id: i64,
    pub name: String,
    pub proxy_id: Option<i64>,
    pub custom_proxy: Option<String>,
    pub cdp_port: Option<i64>,
    pub status: String,
    pub fraud_score: i64,
    pub fraud_details: Option<String>,
    pub theme_color: String,
    pub created_at: String,
    #[serde(default = "default_true")]
    pub use_geoip: bool,
    #[serde(default = "default_true")]
    pub humanize: bool,
    #[serde(default)]
    pub fingerprint_seed: String,
    #[serde(default = "default_stealth_preset")]
    pub stealth_preset: String,
    #[serde(default)]
    pub interactive_element_extract_enabled: bool,
    /// Agent 观察是否附带多帧低质量视口截图（关=零截图）
    #[serde(default)]
    pub agent_panorama_enabled: bool,
    #[serde(default = "default_webgl_mode")]
    pub webgl_mode: String,
    #[serde(default)]
    pub browser_version: String,
    /// Milestone 3：环境核心人设 JSON（姓名/生日/性别等），由 Agent 首次生成后落盘复用
    #[serde(default)]
    pub persona_data: Option<String>,
    /// 启动时额外打开的网站 JSON 数组（首位永远由引擎强制 BrowserScan）
    #[serde(default)]
    pub startup_urls: String,
}

fn default_true() -> bool {
    true
}

fn default_stealth_preset() -> String {
    "default".to_owned()
}

fn default_webgl_mode() -> String {
    "local".to_owned()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StartProfileResult {
    pub profile_id: String,
    pub cdp_port: u16,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ip_geo: Option<ProfileIpGeo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Proxy {
    pub id: i64,
    #[serde(rename = "type")]
    pub proxy_type: String,
    pub host: String,
    pub port: i64,
    pub username: Option<String>,
    pub password: Option<String>,
    pub api_config: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AddProxyInput {
    #[serde(rename = "type")]
    pub proxy_type: String,
    pub host: String,
    pub port: i64,
    pub username: Option<String>,
    pub password: Option<String>,
    pub api_config: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DynamicApiProxyInput {
    pub api_url: String,
    pub protocol: String,
    pub region: String,
    pub label: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateProfileInput {
    pub name: String,
    pub theme_color: Option<String>,
    pub proxy_id: Option<i64>,
    pub custom_proxy: Option<String>,
    #[serde(default = "default_true")]
    pub use_geoip: bool,
    #[serde(default = "default_true")]
    pub humanize: bool,
    pub fingerprint_seed: Option<String>,
    #[serde(default = "default_stealth_preset")]
    pub stealth_preset: String,
    #[serde(default = "default_webgl_mode")]
    pub webgl_mode: String,
    #[serde(default)]
    pub browser_version: Option<String>,
    /// 额外启动网址 JSON 数组字符串，如 `["https://a.com","https://b.com"]`
    #[serde(default)]
    pub startup_urls: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BatchCreateProfilesInput {
    pub prefix: String,
    pub count: u32,
    pub theme_color: Option<String>,
    #[serde(default)]
    pub proxy_strategy: Option<String>,
    pub proxy_id: Option<i64>,
    pub sequential_host: Option<String>,
    pub sequential_start_port: Option<u32>,
    pub sequential_proxy_type: Option<String>,
    #[serde(default = "default_webgl_mode")]
    pub webgl_mode: String,
    #[serde(default = "default_stealth_preset")]
    pub stealth_preset: String,
    #[serde(default)]
    pub startup_urls: Option<String>,
    #[serde(default)]
    pub browser_version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateProfileInput {
    pub id: i64,
    pub name: String,
    pub theme_color: Option<String>,
    pub proxy_id: Option<i64>,
    pub custom_proxy: Option<String>,
    #[serde(default = "default_true")]
    pub use_geoip: bool,
    #[serde(default = "default_true")]
    pub humanize: bool,
    pub fingerprint_seed: Option<String>,
    #[serde(default = "default_stealth_preset")]
    pub stealth_preset: String,
    #[serde(default = "default_webgl_mode")]
    pub webgl_mode: String,
    #[serde(default)]
    pub browser_version: Option<String>,
    #[serde(default)]
    pub startup_urls: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProfileIpGeo {
    pub profile_id: String,
    pub ip: Option<String>,
    pub country: Option<String>,
    pub country_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub region: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub city: Option<String>,
    pub status: String,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BatchDeleteResult {
    pub deleted_ids: Vec<String>,
    pub skipped_running_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProxyTestResult {
    pub ok: bool,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FormTemplate {
    pub id: i64,
    pub domain: String,
    pub template_name: String,
    pub actions: String,
    pub auto_apply: bool,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentTrajectory {
    pub id: i64,
    pub domain: String,
    pub title: String,
    pub goal: String,
    pub start_url: String,
    pub actions: String,
    pub created_at: String,
    /// 文件落盘绝对路径（file 源）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub step_count: Option<u32>,
    /// "file" | "db"
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

/// 同站控件跨任务记忆（脱敏：仅 selector + 意图，无填表值）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentControlMemory {
    pub id: i64,
    pub domain: String,
    pub intent: String,
    pub intent_key: String,
    pub kind: String,
    pub selector: String,
    pub text_hint: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub x_percent: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub y_percent: Option<f64>,
    pub hit_count: i64,
    pub updated_at: String,
}
