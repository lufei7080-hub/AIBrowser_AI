use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension};

use std::collections::HashSet;
use std::net::TcpListener;

use rand::Rng;

use crate::error::AppError;
use crate::log_info;
use crate::models::{BatchCreateProfilesInput, Profile, Proxy};
use crate::proxy::{self, parse_custom_proxy_json, parse_dynamic_api_config, apply_region_to_api_url};

const CDP_PORT_START: u16 = 9222;
const CDP_PORT_END: u16 = 9322;

const SCHEMA: &str = r#"
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS proxies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    "type" TEXT NOT NULL CHECK ("type" IN ('HTTP', 'SOCKS5')),
    host TEXT NOT NULL,
    port INTEGER NOT NULL CHECK (port BETWEEN 1 AND 65535),
    username TEXT,
    password TEXT
);

CREATE TABLE IF NOT EXISTS profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    proxy_id INTEGER REFERENCES proxies(id) ON DELETE SET NULL,
    cdp_port INTEGER CHECK (cdp_port IS NULL OR cdp_port BETWEEN 1 AND 65535),
    status TEXT NOT NULL DEFAULT 'stopped',
    fraud_score INTEGER NOT NULL DEFAULT -1,
    fraud_details TEXT,
    theme_color TEXT NOT NULL DEFAULT '#6366f1',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS global_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_profiles_proxy_id ON profiles(proxy_id);
CREATE INDEX IF NOT EXISTS idx_profiles_status ON profiles(status);
"#;

const PROFILE_COLUMNS: &str =
    "id, name, proxy_id, cdp_port, status, fraud_score, fraud_details, theme_color, created_at, custom_proxy, use_geoip, humanize, fingerprint_seed, stealth_preset, interactive_element_extract_enabled, webgl_mode, browser_version, persona_data, startup_urls, agent_panorama_enabled";

pub fn random_fingerprint_seed() -> String {
    rand::rng().random_range(10_000..=99_999).to_string()
}

fn normalize_webgl_mode(raw: &str) -> Result<String, AppError> {
    match raw.trim().to_lowercase().as_str() {
        "local" => Ok("local".to_owned()),
        "random" => Ok("random".to_owned()),
        other => Err(AppError::Validation(format!(
            "webgl_mode must be local or random, got: {other}"
        ))),
    }
}

fn normalize_stealth_preset(raw: &str) -> Result<String, AppError> {
    match raw.trim() {
        "default" | "" => Ok("default".to_owned()),
        "fpjs_bypass" => Ok("fpjs_bypass".to_owned()),
        other => Err(AppError::Validation(format!(
            "unsupported stealth preset: {other}"
        ))),
    }
}

fn normalize_fingerprint_seed(raw: Option<&str>) -> Result<String, AppError> {
    let seed = raw
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(random_fingerprint_seed);

    if seed.parse::<u32>().ok().is_some_and(|value| (10_000..=99_999).contains(&value)) {
        return Ok(seed);
    }

    Err(AppError::Validation(
        "fingerprint seed must be a number between 10000 and 99999".to_owned(),
    ))
}

fn bool_from_sql(value: i64) -> bool {
    value != 0
}

fn bool_to_sql(value: bool) -> i64 {
    if value {
        1
    } else {
        0
    }
}

pub fn init_database(db_path: &Path) -> Result<Connection, AppError> {
    if let Some(parent) = db_path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)?;
        }
    }

    let connection = Connection::open(db_path)?;

    // —— Milestone 1：强制 WAL，解决多开并发写导致的 "database is locked" ——
    // WAL 允许读写并行：多个环境并发上报时，读不阻塞写、写不阻塞读。
    let journal_mode: String = connection
        .query_row("PRAGMA journal_mode=WAL", [], |row| row.get(0))?;
    if !journal_mode.eq_ignore_ascii_case("wal") {
        return Err(AppError::Database(format!(
            "failed to enable WAL journal mode, got: {journal_mode}"
        )));
    }
    // synchronous=NORMAL：WAL 下安全且大幅降低写放大；
    // busy_timeout：遇到瞬时写锁时等待重试，而非立刻报锁错误。
    connection.execute_batch("PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;")?;

    connection.execute_batch(SCHEMA)?;
    migrate_schema(&connection)?;
    seed_default_settings(&connection)?;
    seed_demo_profiles(&connection)?;
    Ok(connection)
}

fn column_exists(connection: &Connection, table: &str, column: &str) -> Result<bool, AppError> {
    let sql = format!("PRAGMA table_info({table})");
    let mut statement = connection.prepare(&sql)?;
    let mut rows = statement.query([])?;
    while let Some(row) = rows.next()? {
        let name: String = row.get(1)?;
        if name == column {
            return Ok(true);
        }
    }
    Ok(false)
}

fn table_exists(connection: &Connection, table: &str) -> Result<bool, AppError> {
    let mut statement = connection.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?1",
    )?;
    let mut rows = statement.query(params![table])?;
    Ok(rows.next()?.is_some())
}

/// 旧版 DB 在 profiles 中存了 user_agent/timezone/locale/canvas/webgl 等字段（NOT NULL 无 DEFAULT），
/// 与当前 CloakBrowser 启动链冲突且导致 INSERT 失败。检测到 legacy 列时重建为标准 schema。
fn rebuild_legacy_profiles_table(connection: &Connection) -> Result<(), AppError> {
    if !table_exists(connection, "profiles")? {
        return Ok(());
    }
    if !column_exists(connection, "profiles", "user_agent")? {
        return Ok(());
    }

    connection.execute_batch(
        r#"
        CREATE TABLE profiles_canonical (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            proxy_id INTEGER REFERENCES proxies(id) ON DELETE SET NULL,
            cdp_port INTEGER CHECK (cdp_port IS NULL OR cdp_port BETWEEN 1 AND 65535),
            status TEXT NOT NULL DEFAULT 'stopped',
            fraud_score INTEGER NOT NULL DEFAULT -1,
            fraud_details TEXT,
            theme_color TEXT NOT NULL DEFAULT '#6366f1',
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            custom_proxy TEXT,
            use_geoip INTEGER NOT NULL DEFAULT 1,
            humanize INTEGER NOT NULL DEFAULT 1,
            fingerprint_seed TEXT NOT NULL DEFAULT '',
            stealth_preset TEXT NOT NULL DEFAULT 'default',
            interactive_element_extract_enabled INTEGER NOT NULL DEFAULT 0,
            webgl_mode TEXT NOT NULL DEFAULT 'local',
            browser_version TEXT NOT NULL DEFAULT ''
        );

        INSERT INTO profiles_canonical (
            id, name, proxy_id, cdp_port, status, fraud_score, fraud_details, theme_color, created_at,
            custom_proxy, use_geoip, humanize, fingerprint_seed, stealth_preset,
            interactive_element_extract_enabled, webgl_mode, browser_version
        )
        SELECT
            id, name, proxy_id, cdp_port, status, fraud_score, fraud_details, theme_color, created_at,
            custom_proxy, use_geoip, humanize, fingerprint_seed, stealth_preset,
            interactive_element_extract_enabled,
            COALESCE(webgl_mode, 'local'),
            COALESCE(browser_version, '')
        FROM profiles;

        DROP TABLE profiles;
        ALTER TABLE profiles_canonical RENAME TO profiles;

        CREATE INDEX IF NOT EXISTS idx_profiles_proxy_id ON profiles(proxy_id);
        CREATE INDEX IF NOT EXISTS idx_profiles_status ON profiles(status);
        "#,
    )?;

    log_info!(
        "CloakForge: rebuilt legacy profiles table (removed user_agent/timezone/locale/canvas/webgl columns)"
    );
    Ok(())
}

fn migrate_schema(connection: &Connection) -> Result<(), AppError> {
    if table_exists(connection, "profiles")? {
        if !column_exists(connection, "profiles", "cdp_port")? {
            connection.execute(
                "ALTER TABLE profiles ADD COLUMN cdp_port INTEGER CHECK (cdp_port IS NULL OR cdp_port BETWEEN 1 AND 65535)",
                [],
            )?;
        }
        if !column_exists(connection, "profiles", "fraud_score")? {
            connection.execute(
                "ALTER TABLE profiles ADD COLUMN fraud_score INTEGER NOT NULL DEFAULT -1",
                [],
            )?;
        }
        if !column_exists(connection, "profiles", "fraud_details")? {
            connection.execute("ALTER TABLE profiles ADD COLUMN fraud_details TEXT", [])?;
        }
        if !column_exists(connection, "profiles", "created_at")? {
            connection.execute(
                "ALTER TABLE profiles ADD COLUMN created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP",
                [],
            )?;
        }
        if !column_exists(connection, "profiles", "theme_color")? {
            connection.execute(
                "ALTER TABLE profiles ADD COLUMN theme_color TEXT NOT NULL DEFAULT '#6366f1'",
                [],
            )?;
        }
        if !column_exists(connection, "profiles", "custom_proxy")? {
            connection.execute("ALTER TABLE profiles ADD COLUMN custom_proxy TEXT", [])?;
        }
        if !column_exists(connection, "profiles", "use_geoip")? {
            connection.execute(
                "ALTER TABLE profiles ADD COLUMN use_geoip INTEGER NOT NULL DEFAULT 1",
                [],
            )?;
        }
        if !column_exists(connection, "profiles", "humanize")? {
            connection.execute(
                "ALTER TABLE profiles ADD COLUMN humanize INTEGER NOT NULL DEFAULT 1",
                [],
            )?;
        }
        if !column_exists(connection, "profiles", "fingerprint_seed")? {
            connection.execute(
                "ALTER TABLE profiles ADD COLUMN fingerprint_seed TEXT NOT NULL DEFAULT ''",
                [],
            )?;
        }
        if !column_exists(connection, "profiles", "stealth_preset")? {
            connection.execute(
                "ALTER TABLE profiles ADD COLUMN stealth_preset TEXT NOT NULL DEFAULT 'default'",
                [],
            )?;
        }
        if !column_exists(connection, "profiles", "interactive_element_extract_enabled")? {
            connection.execute(
                "ALTER TABLE profiles ADD COLUMN interactive_element_extract_enabled INTEGER NOT NULL DEFAULT 0",
                [],
            )?;
            if let Ok(Some(value)) = get_setting(connection, "interactive_element_extract_enabled") {
                if value.trim().eq_ignore_ascii_case("true") {
                    connection.execute(
                        "UPDATE profiles SET interactive_element_extract_enabled = 1",
                        [],
                    )?;
                }
            }
        }
        if !column_exists(connection, "profiles", "agent_panorama_enabled")? {
            connection.execute(
                "ALTER TABLE profiles ADD COLUMN agent_panorama_enabled INTEGER NOT NULL DEFAULT 0",
                [],
            )?;
        }
        if !column_exists(connection, "profiles", "webgl_mode")? {
            connection.execute(
                "ALTER TABLE profiles ADD COLUMN webgl_mode TEXT NOT NULL DEFAULT 'local'",
                [],
            )?;
        }
        if !column_exists(connection, "profiles", "browser_version")? {
            connection.execute(
                "ALTER TABLE profiles ADD COLUMN browser_version TEXT NOT NULL DEFAULT ''",
                [],
            )?;
        } else {
            connection.execute(
                "UPDATE profiles SET browser_version = '' WHERE browser_version IS NULL",
                [],
            )?;
        }
        // 清理历史脏数据（如误存「CloakBrowser」），避免启动时报 Invalid browser version pin
        sanitize_invalid_browser_versions(connection)?;
        rebuild_legacy_profiles_table(connection)?;
        // Milestone 3：人设列必须在 legacy rebuild 之后添加，避免重建表时被丢掉
        if !column_exists(connection, "profiles", "persona_data")? {
            connection.execute("ALTER TABLE profiles ADD COLUMN persona_data TEXT", [])?;
        }
        if !column_exists(connection, "profiles", "startup_urls")? {
            connection.execute(
                "ALTER TABLE profiles ADD COLUMN startup_urls TEXT NOT NULL DEFAULT '[]'",
                [],
            )?;
        }
        backfill_profile_fingerprint_seeds(connection)?;
    }

    migrate_proxies_for_dynamic_api(connection)?;

    if !table_exists(connection, "form_templates")? {
        connection.execute_batch(
            "CREATE TABLE form_templates (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                domain TEXT NOT NULL,
                template_name TEXT NOT NULL,
                actions TEXT NOT NULL,
                auto_apply INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS idx_form_templates_domain ON form_templates(domain);",
        )?;
    }

    if !table_exists(connection, "agent_trajectories")? {
        connection.execute_batch(
            "CREATE TABLE agent_trajectories (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                domain TEXT NOT NULL,
                title TEXT NOT NULL,
                goal TEXT NOT NULL DEFAULT '',
                start_url TEXT NOT NULL DEFAULT '',
                actions TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS idx_agent_trajectories_domain ON agent_trajectories(domain);",
        )?;
    }

    // 同站控件 LRU 持久化：仅存脱敏 selector + 意图描述，禁止填表值/密码
    if !table_exists(connection, "agent_control_memory")? {
        connection.execute_batch(
            "CREATE TABLE agent_control_memory (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                domain TEXT NOT NULL,
                intent TEXT NOT NULL,
                intent_key TEXT NOT NULL,
                kind TEXT NOT NULL DEFAULT 'click',
                selector TEXT NOT NULL DEFAULT '',
                text_hint TEXT NOT NULL DEFAULT '',
                x_percent REAL,
                y_percent REAL,
                hit_count INTEGER NOT NULL DEFAULT 1,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(domain, intent_key)
            );
            CREATE INDEX IF NOT EXISTS idx_agent_control_memory_domain
                ON agent_control_memory(domain);",
        )?;
    }

    if !table_exists(connection, "global_settings")? {
        connection.execute_batch(
            "CREATE TABLE global_settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL DEFAULT ''
            );",
        )?;
        if table_exists(connection, "settings")? {
            connection.execute(
                "INSERT OR IGNORE INTO global_settings (key, value) SELECT key, value FROM settings",
                [],
            )?;
        }
        seed_default_settings(connection)?;
    }

    if table_exists(connection, "proxies")? && !column_exists(connection, "proxies", "type")? {
        if column_exists(connection, "proxies", "protocol")? {
            connection.execute(
                "ALTER TABLE proxies ADD COLUMN \"type\" TEXT NOT NULL DEFAULT 'HTTP'",
                [],
            )?;
            connection.execute(
                "UPDATE proxies SET \"type\" = UPPER(CASE WHEN protocol = 'socks5' THEN 'SOCKS5' ELSE 'HTTP' END)",
                [],
            )?;
        }
    }

    Ok(())
}

fn backfill_profile_fingerprint_seeds(connection: &Connection) -> Result<(), AppError> {
    let mut statement =
        connection.prepare("SELECT id FROM profiles WHERE fingerprint_seed IS NULL OR fingerprint_seed = ''")?;
    let ids = statement
        .query_map([], |row| row.get::<_, i64>(0))?
        .collect::<Result<Vec<_>, _>>()?;

    for id in ids {
        connection.execute(
            "UPDATE profiles SET fingerprint_seed = ?1 WHERE id = ?2",
            params![random_fingerprint_seed(), id],
        )?;
    }
    Ok(())
}

fn migrate_proxies_for_dynamic_api(connection: &Connection) -> Result<(), AppError> {
    if !table_exists(connection, "proxies")? {
        return Ok(());
    }
    if column_exists(connection, "proxies", "api_config")? {
        return Ok(());
    }

    connection.execute_batch(
        "CREATE TABLE proxies_migrated (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            \"type\" TEXT NOT NULL,
            host TEXT NOT NULL,
            port INTEGER NOT NULL CHECK (port BETWEEN 0 AND 65535),
            username TEXT,
            password TEXT,
            api_config TEXT
        );
        INSERT INTO proxies_migrated (id, \"type\", host, port, username, password, api_config)
            SELECT id, \"type\", host, port, username, password, NULL FROM proxies;
        DROP TABLE proxies;
        ALTER TABLE proxies_migrated RENAME TO proxies;",
    )?;
    Ok(())
}

pub fn seed_demo_profiles(connection: &Connection) -> Result<(), AppError> {
    let count: i64 = connection.query_row("SELECT COUNT(*) FROM profiles", [], |row| row.get(0))?;
    if count > 0 {
        return Ok(());
    }

    connection.execute(
        "INSERT INTO proxies (\"type\", host, port, username, password) VALUES ('HTTP', '127.0.0.1', 7890, NULL, NULL)",
        [],
    )?;
    let proxy_id = connection.last_insert_rowid();

    let demo_profiles: [(&str, Option<i64>); 3] = [
        ("Checkout-US-01", Some(proxy_id)),
        ("Social-EU-02", Some(proxy_id)),
        ("Ads-APAC-03", None),
    ];

    for (name, proxy) in demo_profiles {
        connection.execute(
            "INSERT INTO profiles (name, proxy_id, status, fraud_score, browser_version) VALUES (?1, ?2, 'stopped', -1, '')",
            params![name, proxy],
        )?;
    }

    Ok(())
}

fn profile_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Profile> {
    Ok(Profile {
        id: row.get(0)?,
        name: row.get(1)?,
        proxy_id: row.get(2)?,
        cdp_port: row.get(3)?,
        status: row.get(4)?,
        fraud_score: row.get(5)?,
        fraud_details: row.get(6)?,
        theme_color: row.get(7)?,
        created_at: row.get(8)?,
        custom_proxy: row.get(9)?,
        use_geoip: bool_from_sql(row.get(10)?),
        humanize: bool_from_sql(row.get(11)?),
        fingerprint_seed: row.get(12)?,
        stealth_preset: row.get(13)?,
        interactive_element_extract_enabled: bool_from_sql(row.get(14)?),
        webgl_mode: row.get(15)?,
        browser_version: row
            .get::<_, Option<String>>(16)?
            .unwrap_or_default(),
        persona_data: row.get::<_, Option<String>>(17).ok().flatten(),
        startup_urls: row
            .get::<_, Option<String>>(18)?
            .unwrap_or_else(|| "[]".to_owned()),
        agent_panorama_enabled: bool_from_sql(row.get::<_, i64>(19).unwrap_or(0)),
    })
}

pub fn list_profiles(connection: &Connection) -> Result<Vec<Profile>, AppError> {
    let sql = format!("SELECT {PROFILE_COLUMNS} FROM profiles ORDER BY id DESC");
    let mut statement = connection.prepare(&sql)?;
    let rows = statement.query_map([], profile_from_row)?;

    let mut profiles = Vec::new();
    for row in rows {
        profiles.push(row?);
    }
    Ok(profiles)
}

pub fn get_profile(connection: &Connection, id: i64) -> Result<Profile, AppError> {
    let sql = format!("SELECT {PROFILE_COLUMNS} FROM profiles WHERE id = ?1");
    connection
        .query_row(&sql, params![id], profile_from_row)
        .optional()?
        .ok_or_else(|| AppError::NotFound(format!("profile {id}")))
}

fn proxy_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Proxy> {
    Ok(Proxy {
        id: row.get(0)?,
        proxy_type: row.get(1)?,
        host: row.get(2)?,
        port: row.get(3)?,
        username: row.get(4)?,
        password: row.get(5)?,
        api_config: row.get(6)?,
    })
}

const PROXY_COLUMNS: &str = "id, \"type\", host, port, username, password, api_config";

pub fn get_proxy(connection: &Connection, id: i64) -> Result<Proxy, AppError> {
    let sql = format!("SELECT {PROXY_COLUMNS} FROM proxies WHERE id = ?1");
    connection
        .query_row(&sql, params![id], proxy_from_row)
        .optional()?
        .ok_or_else(|| AppError::NotFound(format!("proxy {id}")))
}

fn occupied_cdp_ports(connection: &Connection) -> Result<HashSet<u16>, AppError> {
    let mut statement =
        connection.prepare("SELECT cdp_port FROM profiles WHERE cdp_port IS NOT NULL")?;
    let rows = statement.query_map([], |row| row.get::<_, i64>(0))?;

    let mut occupied = HashSet::new();
    for row in rows {
        let port = row?;
        if (CDP_PORT_START as i64..=CDP_PORT_END as i64).contains(&port) {
            occupied.insert(port as u16);
        }
    }
    Ok(occupied)
}

fn is_port_available(port: u16) -> bool {
    TcpListener::bind(("127.0.0.1", port)).is_ok()
}

pub fn allocate_cdp_port(connection: &Connection) -> Result<u16, AppError> {
    let occupied = occupied_cdp_ports(connection)?;

    for port in CDP_PORT_START..=CDP_PORT_END {
        if !occupied.contains(&port) && is_port_available(port) {
            return Ok(port);
        }
    }

    Err(AppError::CdpPortsExhausted {
        start: CDP_PORT_START,
        end: CDP_PORT_END,
    })
}

/// 分配 CDP 端口并立刻写入 SQLite，防止并发 `start_profile` 在 `set_profile_running`
/// 之前互相抢到同一端口（会导致连错浏览器 / 代理表现交叉污染）。
pub fn allocate_and_reserve_cdp_port(
    connection: &Connection,
    profile_id: i64,
) -> Result<u16, AppError> {
    let port = allocate_cdp_port(connection)?;
    let affected = connection.execute(
        "UPDATE profiles SET cdp_port = ?1 WHERE id = ?2",
        params![port as i64, profile_id],
    )?;
    if affected == 0 {
        return Err(AppError::NotFound(format!("profile {profile_id}")));
    }
    Ok(port)
}

/// 启动失败时释放尚未标记为 running 的端口预留。
pub fn release_cdp_port_reservation(
    connection: &Connection,
    profile_id: i64,
) -> Result<(), AppError> {
    connection.execute(
        "UPDATE profiles SET cdp_port = NULL WHERE id = ?1 AND status != 'running'",
        params![profile_id],
    )?;
    Ok(())
}

pub fn set_profile_running(
    connection: &Connection,
    id: i64,
    cdp_port: u16,
) -> Result<Profile, AppError> {
    let affected = connection.execute(
        "UPDATE profiles SET cdp_port = ?1, status = 'running' WHERE id = ?2",
        params![cdp_port as i64, id],
    )?;
    if affected == 0 {
        return Err(AppError::NotFound(format!("profile {id}")));
    }
    get_profile(connection, id)
}

pub fn set_profile_stopped(connection: &Connection, id: i64) -> Result<Profile, AppError> {
    let affected = connection.execute(
        "UPDATE profiles SET status = 'stopped', cdp_port = NULL WHERE id = ?1",
        params![id],
    )?;
    if affected == 0 {
        return Err(AppError::NotFound(format!("profile {id}")));
    }
    get_profile(connection, id)
}

/// 应用重启后 DashMap 为空，SQLite 中残留的 running 状态与实际进程不一致，需重置。
/// 同时清理「启动中崩溃」留下的 cdp_port 预留（status 仍为 stopped）。
pub fn reset_stale_running_profiles(connection: &Connection) -> Result<u64, AppError> {
    let affected_running = connection.execute(
        "UPDATE profiles SET status = 'stopped', cdp_port = NULL WHERE status = 'running'",
        [],
    )?;
    let affected_orphan = connection.execute(
        "UPDATE profiles SET cdp_port = NULL WHERE status != 'running' AND cdp_port IS NOT NULL",
        [],
    )?;
    Ok(affected_running as u64 + affected_orphan as u64)
}

pub fn list_proxies(connection: &Connection) -> Result<Vec<Proxy>, AppError> {
    let sql = format!("SELECT {PROXY_COLUMNS} FROM proxies ORDER BY id DESC");
    let mut statement = connection.prepare(&sql)?;
    let rows = statement.query_map([], proxy_from_row)?;
    let mut proxies = Vec::new();
    for row in rows {
        proxies.push(row?);
    }
    Ok(proxies)
}

pub fn insert_proxy(
    connection: &Connection,
    proxy_type: &str,
    host: &str,
    port: i64,
    username: Option<&str>,
    password: Option<&str>,
    api_config: Option<&str>,
) -> Result<Proxy, AppError> {
    let normalized = proxy::normalize_proxy_type(proxy_type);
    if normalized == "DYNAMIC_API" {
        let config = api_config.ok_or_else(|| {
            AppError::Validation("dynamic API proxy requires api_config".to_owned())
        })?;
        parse_dynamic_api_config(config)?;
        connection.execute(
            "INSERT INTO proxies (\"type\", host, port, username, password, api_config) VALUES ('DYNAMIC_API', 'api', 1, NULL, NULL, ?1)",
            params![config],
        )?;
        return get_proxy(connection, connection.last_insert_rowid());
    }

    if host.trim().is_empty() {
        return Err(AppError::Validation("proxy host cannot be empty".to_owned()));
    }
    if !(1..=65535).contains(&port) {
        return Err(AppError::Validation("proxy port out of range".to_owned()));
    }

    connection.execute(
        "INSERT INTO proxies (\"type\", host, port, username, password, api_config) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![normalized, host.trim(), port, username, password, api_config],
    )?;
    get_proxy(connection, connection.last_insert_rowid())
}

pub fn insert_dynamic_api_proxy(
    connection: &Connection,
    api_url: &str,
    protocol: &str,
    region: &str,
    label: Option<&str>,
) -> Result<Proxy, AppError> {
    let api_url = apply_region_to_api_url(api_url, region);
    let config = serde_json::json!({
        "api_url": api_url,
        "protocol": proxy::normalize_proxy_type(protocol),
        "region": region.trim().to_ascii_lowercase(),
        "label": label.unwrap_or("API 动态提取"),
    });
    let config_text = serde_json::to_string(&config)
        .map_err(|error| AppError::Validation(error.to_string()))?;
    insert_proxy(
        connection,
        "DYNAMIC_API",
        "api",
        1,
        None,
        None,
        Some(&config_text),
    )
}

fn normalize_profile_proxy_fields(
    proxy_id: Option<i64>,
    custom_proxy: Option<&str>,
    connection: &Connection,
) -> Result<(Option<i64>, Option<String>), AppError> {
    let custom = custom_proxy.map(str::trim).filter(|value| !value.is_empty());
    if let Some(raw) = custom {
        let resolved = parse_custom_proxy_json(raw)?;
        let stored = resolved.to_custom_json()?;
        if let Some(id) = proxy_id {
            get_proxy(connection, id)?;
        }
        return Ok((None, Some(stored)));
    }

    if let Some(id) = proxy_id {
        get_proxy(connection, id)?;
        return Ok((Some(id), None));
    }

    Ok((None, None))
}

/// CloakBrowser VERSION_PIN_RE: /^[0-9]+(?:\.[0-9]+){3,4}$/
pub(crate) fn is_valid_browser_version_pin(value: &str) -> bool {
    let parts: Vec<&str> = value.split('.').collect();
    if !(4..=5).contains(&parts.len()) {
        return false;
    }
    parts
        .iter()
        .all(|part| !part.is_empty() && part.chars().all(|ch| ch.is_ascii_digit()))
}

fn sanitize_invalid_browser_versions(connection: &Connection) -> Result<(), AppError> {
    if !column_exists(connection, "profiles", "browser_version")? {
        return Ok(());
    }
    let mut statement = connection.prepare("SELECT id, browser_version FROM profiles")?;
    let rows = statement.query_map([], |row| {
        Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
    })?;
    let mut invalid_ids: Vec<i64> = Vec::new();
    for row in rows {
        let (id, version) = row?;
        let trimmed = version.trim();
        if !trimmed.is_empty() && !is_valid_browser_version_pin(trimmed) {
            invalid_ids.push(id);
        }
    }
    for id in invalid_ids {
        connection.execute(
            "UPDATE profiles SET browser_version = '' WHERE id = ?1",
            params![id],
        )?;
    }
    Ok(())
}

fn normalize_browser_version(raw: Option<&str>) -> Result<String, AppError> {
    let trimmed = raw.unwrap_or("").trim();
    if trimmed.is_empty() {
        return Ok(String::new());
    }
    if trimmed.len() > 32 {
        return Err(AppError::Validation(
            "browser_version must be at most 32 characters".to_owned(),
        ));
    }
    if !is_valid_browser_version_pin(trimmed) {
        return Err(AppError::Validation(
            "browser_version must be a full Chromium pin (4~5 numeric segments), e.g. 146.0.7680.177.5"
                .to_owned(),
        ));
    }
    Ok(trimmed.to_owned())
}

/// 规范化额外启动网址 JSON：过滤空项、补 https、去重、上限 20；不含强制首位 BrowserScan。
pub fn normalize_startup_urls_json(raw: Option<&str>) -> Result<String, AppError> {
    const MAX: usize = 20;
    let text = raw.map(str::trim).filter(|v| !v.is_empty()).unwrap_or("[]");
    let parsed: serde_json::Value = serde_json::from_str(text).map_err(|_| {
        AppError::Validation("startup_urls must be a JSON array of URLs".to_owned())
    })?;
    let Some(items) = parsed.as_array() else {
        return Err(AppError::Validation(
            "startup_urls must be a JSON array of URLs".to_owned(),
        ));
    };

    let forced = "https://www.browserscan.net/zh";
    let mut out: Vec<String> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    seen.insert(forced.to_ascii_lowercase());

    for item in items {
        let candidate = match item {
            serde_json::Value::String(s) => s.trim().to_owned(),
            other => other.to_string().trim_matches('"').trim().to_owned(),
        };
        if candidate.is_empty() {
            continue;
        }
        let normalized = normalize_startup_url_item(&candidate)?;
        let key = normalized.to_ascii_lowercase();
        if seen.contains(&key) {
            continue;
        }
        seen.insert(key);
        out.push(normalized);
        if out.len() >= MAX {
            break;
        }
    }

    serde_json::to_string(&out).map_err(|error| {
        AppError::Validation(format!("failed to serialize startup_urls: {error}"))
    })
}

fn normalize_startup_url_item(raw: &str) -> Result<String, AppError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(AppError::Validation("startup url cannot be empty".to_owned()));
    }
    if trimmed.len() > 2048 {
        return Err(AppError::Validation(
            "startup url is too long (max 2048)".to_owned(),
        ));
    }
    if trimmed.chars().any(char::is_whitespace) {
        return Err(AppError::Validation(format!(
            "invalid startup url (contains whitespace): {trimmed}"
        )));
    }
    let with_scheme = if trimmed.contains("://") {
        trimmed.to_owned()
    } else {
        format!("https://{trimmed}")
    };
    let lower = with_scheme.to_ascii_lowercase();
    if !lower.starts_with("http://") && !lower.starts_with("https://") {
        return Err(AppError::Validation(
            "startup url must be http or https".to_owned(),
        ));
    }
    // 粗校验：scheme 后至少有主机字符
    let rest = with_scheme
        .split_once("://")
        .map(|(_, host)| host)
        .unwrap_or("");
    if rest.is_empty() || rest.starts_with('/') {
        return Err(AppError::Validation(format!(
            "invalid startup url: {trimmed}"
        )));
    }
    Ok(with_scheme)
}

pub fn create_profile(
    connection: &Connection,
    name: &str,
    theme_color: &str,
    proxy_id: Option<i64>,
    custom_proxy: Option<&str>,
    use_geoip: bool,
    humanize: bool,
    fingerprint_seed: Option<&str>,
    stealth_preset: &str,
    webgl_mode: &str,
    browser_version: Option<&str>,
    startup_urls: Option<&str>,
) -> Result<Profile, AppError> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(AppError::Validation("profile name cannot be empty".to_owned()));
    }

    let (proxy_id, custom_proxy) =
        normalize_profile_proxy_fields(proxy_id, custom_proxy, connection)?;
    let fingerprint_seed = normalize_fingerprint_seed(fingerprint_seed)?;
    let stealth_preset = normalize_stealth_preset(stealth_preset)?;
    let webgl_mode = normalize_webgl_mode(webgl_mode)?;
    let browser_version = normalize_browser_version(browser_version)?;
    let startup_urls = normalize_startup_urls_json(startup_urls)?;

    connection.execute(
        "INSERT INTO profiles (name, proxy_id, custom_proxy, theme_color, status, fraud_score, use_geoip, humanize, fingerprint_seed, stealth_preset, webgl_mode, browser_version, startup_urls)
         VALUES (?1, ?2, ?3, ?4, 'stopped', -1, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        params![
            trimmed,
            proxy_id,
            custom_proxy,
            theme_color,
            bool_to_sql(use_geoip),
            bool_to_sql(humanize),
            fingerprint_seed,
            stealth_preset,
            webgl_mode,
            browser_version,
            startup_urls,
        ],
    )?;
    get_profile(connection, connection.last_insert_rowid())
}

pub fn batch_create_profiles(
    connection: &Connection,
    input: &BatchCreateProfilesInput,
) -> Result<Vec<Profile>, AppError> {
    let trimmed_prefix = input.prefix.trim();
    if trimmed_prefix.is_empty() {
        return Err(AppError::Validation("batch prefix cannot be empty".to_owned()));
    }
    if input.count == 0 || input.count > 100 {
        return Err(AppError::Validation("batch count must be between 1 and 100".to_owned()));
    }

    let strategy = input
        .proxy_strategy
        .as_deref()
        .unwrap_or_else(|| {
            if input.proxy_id.is_some() {
                "pool_shared"
            } else {
                "none"
            }
        });

    let theme_color = input.theme_color.as_deref().unwrap_or("#6366f1");
    let webgl_mode = normalize_webgl_mode(&input.webgl_mode)?;
    let stealth_preset = normalize_stealth_preset(&input.stealth_preset)?;
    let startup_urls = normalize_startup_urls_json(input.startup_urls.as_deref())?;
    let browser_version = normalize_browser_version(input.browser_version.as_deref())?;
    let pool_proxies = list_proxies(connection)?;
    let mut rng = rand::rng();

    let mut created = Vec::with_capacity(input.count as usize);
    for index in 1..=input.count {
        let name = format!("{trimmed_prefix}-{index:02}");
        let (proxy_id, custom_proxy) = match strategy {
            "none" => (None, None),
            "pool_shared" => {
                let proxy_id = input.proxy_id.ok_or_else(|| {
                    AppError::Validation("pool_shared strategy requires proxy_id".to_owned())
                })?;
                get_proxy(connection, proxy_id)?;
                (Some(proxy_id), None)
            }
            "pool_random" => {
                let mut static_proxies: Vec<Proxy> = pool_proxies
                    .iter()
                    .filter(|proxy| proxy.proxy_type.to_ascii_uppercase() != "DYNAMIC_API")
                    .cloned()
                    .collect();
                if let Some(proxy_id) = input.proxy_id {
                    static_proxies.retain(|proxy| proxy.id == proxy_id);
                }
                if static_proxies.is_empty() {
                    return Err(AppError::Validation(
                        "proxy pool has no static proxies for random assignment".to_owned(),
                    ));
                }
                let picked = &static_proxies[rng.random_range(0..static_proxies.len())];
                (Some(picked.id), None)
            }
            "sequential_ports" => {
                let host = input
                    .sequential_host
                    .as_deref()
                    .filter(|value| !value.trim().is_empty())
                    .unwrap_or("127.0.0.1");
                let start_port = input.sequential_start_port.unwrap_or(5500);
                let port = start_port.saturating_add(index - 1);
                if port > 65535 {
                    return Err(AppError::Validation(
                        "sequential port overflow beyond 65535".to_owned(),
                    ));
                }
                let proxy_type = input
                    .sequential_proxy_type
                    .as_deref()
                    .unwrap_or("HTTP");
                let resolved = proxy::ResolvedProxy {
                    scheme: proxy::normalize_scheme(proxy_type),
                    host: host.to_owned(),
                    port: port as u16,
                    username: None,
                    password: None,
                };
                (None, Some(resolved.to_custom_json()?))
            }
            other => {
                return Err(AppError::Validation(format!(
                    "unsupported proxy strategy: {other}"
                )));
            }
        };

        connection.execute(
            "INSERT INTO profiles (name, proxy_id, custom_proxy, theme_color, status, fraud_score, use_geoip, humanize, fingerprint_seed, stealth_preset, webgl_mode, browser_version, startup_urls)
             VALUES (?1, ?2, ?3, ?4, 'stopped', -1, 1, 1, ?5, ?6, ?7, ?8, ?9)",
            params![
                name,
                proxy_id,
                custom_proxy,
                theme_color,
                random_fingerprint_seed(),
                stealth_preset,
                webgl_mode,
                browser_version,
                startup_urls,
            ],
        )?;
        created.push(get_profile(connection, connection.last_insert_rowid())?);
    }

    Ok(created)
}

pub fn update_profile(
    connection: &Connection,
    id: i64,
    name: &str,
    theme_color: &str,
    proxy_id: Option<i64>,
    custom_proxy: Option<&str>,
    use_geoip: bool,
    humanize: bool,
    fingerprint_seed: Option<&str>,
    stealth_preset: &str,
    webgl_mode: &str,
    browser_version: Option<&str>,
    startup_urls: Option<&str>,
) -> Result<Profile, AppError> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(AppError::Validation("profile name cannot be empty".to_owned()));
    }

    let existing = get_profile(connection, id)?;
    let (proxy_id, custom_proxy) =
        normalize_profile_proxy_fields(proxy_id, custom_proxy, connection)?;
    let fingerprint_seed = normalize_fingerprint_seed(
        fingerprint_seed.or(Some(existing.fingerprint_seed.as_str())),
    )?;
    let stealth_preset = normalize_stealth_preset(stealth_preset)?;
    let webgl_mode = normalize_webgl_mode(webgl_mode)?;
    let browser_version = normalize_browser_version(
        browser_version.or(Some(existing.browser_version.as_str())),
    )?;
    let startup_urls = normalize_startup_urls_json(
        startup_urls.or(Some(existing.startup_urls.as_str())),
    )?;

    let affected = connection.execute(
        "UPDATE profiles SET name = ?1, theme_color = ?2, proxy_id = ?3, custom_proxy = ?4,
         use_geoip = ?5, humanize = ?6, fingerprint_seed = ?7, stealth_preset = ?8, webgl_mode = ?9,
         browser_version = ?10, startup_urls = ?11 WHERE id = ?12",
        params![
            trimmed,
            theme_color,
            proxy_id,
            custom_proxy,
            bool_to_sql(use_geoip),
            bool_to_sql(humanize),
            fingerprint_seed,
            stealth_preset,
            webgl_mode,
            browser_version,
            startup_urls,
            id,
        ],
    )?;
    if affected == 0 {
        return Err(AppError::NotFound(format!("profile {id}")));
    }
    get_profile(connection, id)
}

pub fn set_profile_interactive_extract(
    connection: &Connection,
    id: i64,
    enabled: bool,
) -> Result<Profile, AppError> {
    let affected = connection.execute(
        "UPDATE profiles SET interactive_element_extract_enabled = ?1 WHERE id = ?2",
        params![bool_to_sql(enabled), id],
    )?;
    if affected == 0 {
        return Err(AppError::NotFound(format!("profile {id}")));
    }
    get_profile(connection, id)
}

pub fn set_profile_agent_panorama(
    connection: &Connection,
    id: i64,
    enabled: bool,
) -> Result<Profile, AppError> {
    let affected = connection.execute(
        "UPDATE profiles SET agent_panorama_enabled = ?1 WHERE id = ?2",
        params![bool_to_sql(enabled), id],
    )?;
    if affected == 0 {
        return Err(AppError::NotFound(format!("profile {id}")));
    }
    get_profile(connection, id)
}

pub fn delete_profile(connection: &Connection, id: i64) -> Result<(), AppError> {
    let profile = get_profile(connection, id)?;
    if profile.status == "running" {
        return Err(AppError::Validation(
            "cannot delete a running profile; stop it first".to_owned(),
        ));
    }
    let affected = connection.execute("DELETE FROM profiles WHERE id = ?1", params![id])?;
    if affected == 0 {
        return Err(AppError::NotFound(format!("profile {id}")));
    }
    Ok(())
}

const ALLOWED_SETTING_KEYS: &[&str] = &[
    "deepseek_api_key",
    "zhipu_api_key",
    "custom_api_key",
    "ai_provider",
    "deepseek_base_url",
    "deepseek_chat_model",
    "zhipu_chat_model",
    "custom_chat_model",
    "ai_extra_models",
    "ai_task_models",
    "cloak_path",
    "cloak_license_key",
    "key_file_path",
    "browser_download_dir",
    "scraper_download_dir",
    "license_through_proxy",
    "allow_third_party_cookies",
    "fingerprint_off",
    "agent_sense_mode",
    "default_browser_version",
];

pub fn seed_default_settings(connection: &Connection) -> Result<(), AppError> {
    let defaults = [
        ("deepseek_api_key", ""),
        ("zhipu_api_key", ""),
        ("custom_api_key", ""),
        ("ai_provider", "deepseek"),
        ("deepseek_base_url", "https://api.deepseek.com"),
        ("deepseek_chat_model", "deepseek-v4-flash"),
        ("zhipu_chat_model", "glm-4.7-flash"),
        ("custom_chat_model", ""),
        ("ai_extra_models", "[]"),
        ("ai_task_models", "{}"),
        ("cloak_path", ""),
        ("cloak_license_key", ""),
        ("key_file_path", ""),
        ("browser_download_dir", ""),
        ("scraper_download_dir", ""),
        ("license_through_proxy", "false"),
        ("allow_third_party_cookies", "false"),
        ("fingerprint_off", "false"),
        ("agent_sense_mode", "balanced"),
        ("default_browser_version", ""),
    ];
    for (key, value) in defaults {
        connection.execute(
            "INSERT OR IGNORE INTO global_settings (key, value) VALUES (?1, ?2)",
            params![key, value],
        )?;
    }
    Ok(())
}

pub fn list_settings(connection: &Connection) -> Result<std::collections::HashMap<String, String>, AppError> {
    let mut statement =
        connection.prepare("SELECT key, value FROM global_settings ORDER BY key ASC")?;
    let rows = statement.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    let mut map = std::collections::HashMap::new();
    for row in rows {
        let (key, value) = row?;
        map.insert(key, value);
    }
    Ok(map)
}

pub fn get_setting(connection: &Connection, key: &str) -> Result<Option<String>, AppError> {
    let mut statement = connection.prepare("SELECT value FROM global_settings WHERE key = ?1")?;
    let value = statement
        .query_row(params![key], |row| row.get::<_, String>(0))
        .optional()?;
    Ok(value)
}

/// 读取布尔语义的全局设置（存储为 "true"/"1" 视为开启，其余视为关闭）。
pub fn get_bool_setting(connection: &Connection, key: &str) -> Result<bool, AppError> {
    let value = get_setting(connection, key)?;
    Ok(value
        .map(|raw| {
            let trimmed = raw.trim();
            trimmed == "true" || trimmed == "1" || trimmed.eq_ignore_ascii_case("on")
        })
        .unwrap_or(false))
}

pub fn set_setting(connection: &Connection, key: &str, value: &str) -> Result<(), AppError> {
    if !ALLOWED_SETTING_KEYS.contains(&key) {
        return Err(AppError::Validation(format!("unsupported setting key: {key}")));
    }
    connection.execute(
        "INSERT INTO global_settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

pub fn batch_add_proxies(
    connection: &Connection,
    proxies: &[crate::models::AddProxyInput],
) -> Result<usize, AppError> {
    if proxies.is_empty() {
        return Err(AppError::Validation("proxy batch cannot be empty".to_owned()));
    }

    let transaction = connection.unchecked_transaction()?;
    let mut inserted = 0usize;
    for proxy in proxies {
        insert_proxy(
            &transaction,
            &proxy.proxy_type,
            &proxy.host,
            proxy.port,
            proxy.username.as_deref(),
            proxy.password.as_deref(),
            proxy.api_config.as_deref(),
        )?;
        inserted += 1;
    }
    transaction.commit()?;
    Ok(inserted)
}

pub fn batch_delete_proxies(connection: &Connection, ids: &[i64]) -> Result<usize, AppError> {
    if ids.is_empty() {
        return Err(AppError::Validation(
            "proxy batch delete requires at least one id".to_owned(),
        ));
    }

    let transaction = connection.unchecked_transaction()?;
    let mut deleted = 0usize;
    for id in ids {
        let affected = transaction.execute("DELETE FROM proxies WHERE id = ?1", params![id])?;
        deleted += affected;
    }
    transaction.commit()?;
    Ok(deleted)
}

pub fn save_form_template(
    connection: &Connection,
    domain: &str,
    template_name: &str,
    actions: &str,
    auto_apply: bool,
) -> Result<i64, AppError> {
    let domain = domain.trim();
    let template_name = template_name.trim();
    if domain.is_empty() {
        return Err(AppError::Validation("template domain cannot be empty".to_owned()));
    }
    if template_name.is_empty() {
        return Err(AppError::Validation("template name cannot be empty".to_owned()));
    }
    if actions.trim().is_empty() {
        return Err(AppError::Validation("template actions cannot be empty".to_owned()));
    }

    connection.execute(
        "INSERT INTO form_templates (domain, template_name, actions, auto_apply)
         VALUES (?1, ?2, ?3, ?4)",
        params![domain, template_name, actions, auto_apply as i64],
    )?;
    Ok(connection.last_insert_rowid())
}

pub fn get_form_templates_by_domain(
    connection: &Connection,
    domain: &str,
) -> Result<Vec<crate::models::FormTemplate>, AppError> {
    let domain = domain.trim();
    let mut statement = connection.prepare(
        "SELECT id, domain, template_name, actions, auto_apply, created_at
         FROM form_templates
         WHERE domain = ?1 OR domain LIKE '%' || ?1
         ORDER BY auto_apply DESC, created_at DESC",
    )?;
    let rows = statement
        .query_map(params![domain], |row| {
            Ok(crate::models::FormTemplate {
                id: row.get(0)?,
                domain: row.get(1)?,
                template_name: row.get(2)?,
                actions: row.get(3)?,
                auto_apply: row.get::<_, i64>(4)? != 0,
                created_at: row.get(5)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn list_all_form_templates(
    connection: &Connection,
) -> Result<Vec<crate::models::FormTemplate>, AppError> {
    let mut statement = connection.prepare(
        "SELECT id, domain, template_name, actions, auto_apply, created_at
         FROM form_templates
         ORDER BY created_at DESC",
    )?;
    let rows = statement
        .query_map([], |row| {
            Ok(crate::models::FormTemplate {
                id: row.get(0)?,
                domain: row.get(1)?,
                template_name: row.get(2)?,
                actions: row.get(3)?,
                auto_apply: row.get::<_, i64>(4)? != 0,
                created_at: row.get(5)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn delete_form_template(connection: &Connection, id: i64) -> Result<(), AppError> {
    let affected = connection.execute("DELETE FROM form_templates WHERE id = ?1", params![id])?;
    if affected == 0 {
        return Err(AppError::NotFound(format!("form template {id} not found")));
    }
    Ok(())
}

pub fn toggle_form_template_auto_apply(
    connection: &Connection,
    id: i64,
    auto_apply: bool,
) -> Result<(), AppError> {
    let affected = connection.execute(
        "UPDATE form_templates SET auto_apply = ?1 WHERE id = ?2",
        params![auto_apply as i64, id],
    )?;
    if affected == 0 {
        return Err(AppError::NotFound(format!("form template {id} not found")));
    }
    Ok(())
}

pub fn update_form_template_actions(
    connection: &Connection,
    id: i64,
    actions: &str,
) -> Result<(), AppError> {
    if actions.trim().is_empty() {
        return Err(AppError::Validation("template actions cannot be empty".to_owned()));
    }
    let affected = connection.execute(
        "UPDATE form_templates SET actions = ?1 WHERE id = ?2",
        params![actions, id],
    )?;
    if affected == 0 {
        return Err(AppError::NotFound(format!("form template {id} not found")));
    }
    Ok(())
}

pub fn save_agent_trajectory(
    connection: &Connection,
    domain: &str,
    title: &str,
    goal: &str,
    start_url: &str,
    actions: &str,
) -> Result<i64, AppError> {
    let domain = domain.trim();
    let title = title.trim();
    if domain.is_empty() {
        return Err(AppError::Validation("trajectory domain cannot be empty".to_owned()));
    }
    if title.is_empty() {
        return Err(AppError::Validation("trajectory title cannot be empty".to_owned()));
    }
    if actions.trim().is_empty() {
        return Err(AppError::Validation("trajectory actions cannot be empty".to_owned()));
    }

    connection.execute(
        "INSERT INTO agent_trajectories (domain, title, goal, start_url, actions)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![domain, title, goal, start_url.trim(), actions],
    )?;
    Ok(connection.last_insert_rowid())
}

pub fn list_agent_trajectories(
    connection: &Connection,
    domain: &str,
) -> Result<Vec<crate::models::AgentTrajectory>, AppError> {
    let domain = domain.trim();
    if domain.is_empty() {
        let mut statement = connection.prepare(
            "SELECT id, domain, title, goal, start_url, actions, created_at
             FROM agent_trajectories
             ORDER BY created_at DESC",
        )?;
        let rows = statement
            .query_map([], |row| {
                Ok(crate::models::AgentTrajectory {
                    id: row.get(0)?,
                    domain: row.get(1)?,
                    title: row.get(2)?,
                    goal: row.get(3)?,
                    start_url: row.get(4)?,
                    actions: row.get(5)?,
                    created_at: row.get(6)?,
                    file_path: None,
                    file_name: None,
                    step_count: None,
                    source: Some("db".to_owned()),
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        return Ok(rows);
    }

    let mut statement = connection.prepare(
        "SELECT id, domain, title, goal, start_url, actions, created_at
         FROM agent_trajectories
         WHERE domain = ?1 OR domain LIKE '%' || ?1 OR ?1 LIKE '%' || domain
         ORDER BY created_at DESC",
    )?;
    let rows = statement
        .query_map(params![domain], |row| {
            Ok(crate::models::AgentTrajectory {
                id: row.get(0)?,
                domain: row.get(1)?,
                title: row.get(2)?,
                goal: row.get(3)?,
                start_url: row.get(4)?,
                actions: row.get(5)?,
                created_at: row.get(6)?,
                file_path: None,
                file_name: None,
                step_count: None,
                source: Some("db".to_owned()),
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn delete_agent_trajectory(connection: &Connection, id: i64) -> Result<(), AppError> {
    let affected = connection.execute("DELETE FROM agent_trajectories WHERE id = ?1", params![id])?;
    if affected == 0 {
        return Err(AppError::NotFound(format!("agent trajectory {id} not found")));
    }
    Ok(())
}

/// 按内容清理影子副本（Agent 成功时常同时写文件 + SQLite）
pub fn delete_agent_trajectories_matching(
    connection: &Connection,
    domain: &str,
    title: &str,
    goal: &str,
) -> Result<usize, AppError> {
    let domain = domain.trim();
    let title = title.trim();
    let goal = goal.trim();
    if domain.is_empty() || title.is_empty() {
        return Ok(0);
    }
    let affected = if goal.is_empty() {
        connection.execute(
            "DELETE FROM agent_trajectories WHERE domain = ?1 AND title = ?2",
            params![domain, title],
        )?
    } else {
        connection.execute(
            "DELETE FROM agent_trajectories
             WHERE domain = ?1 AND title = ?2 AND (goal = ?3 OR goal = '' OR ?3 = '')",
            params![domain, title, goal],
        )?
    };
    Ok(affected)
}

const CONTROL_MEMORY_PER_DOMAIN_CAP: usize = 50;

fn sanitize_control_selector(raw: &str) -> String {
    let selector = raw.trim();
    if selector.is_empty() {
        return String::new();
    }
    // 拒绝纯数字临时短 id
    if selector.chars().all(|ch| ch.is_ascii_digit()) {
        return String::new();
    }
    if regex_is_sensitive_selector(selector) {
        return String::new();
    }
    selector.chars().take(240).collect()
}

fn regex_is_sensitive_selector(selector: &str) -> bool {
    let lower = selector.to_ascii_lowercase();
    lower.contains("password")
        || lower.contains("passwd")
        || lower.contains("token")
        || lower.contains("csrf")
        || lower.contains("authorization")
        || lower.contains("api_key")
        || lower.contains("apikey")
}

fn sanitize_control_intent(raw: &str) -> String {
    raw.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(80)
        .collect()
}

fn normalize_intent_key(raw: &str) -> String {
    sanitize_control_intent(raw).to_ascii_lowercase()
}

/// Upsert 同站控件记忆（LRU：同 key 刷新 hit_count；每域名最多 50 条）
pub fn upsert_agent_control_memory(
    connection: &Connection,
    domain: &str,
    intent: &str,
    intent_key: &str,
    kind: &str,
    selector: &str,
    text_hint: &str,
    x_percent: Option<f64>,
    y_percent: Option<f64>,
    hit_count: Option<i64>,
) -> Result<i64, AppError> {
    let domain = domain.trim().trim_start_matches("www.").to_ascii_lowercase();
    let intent = sanitize_control_intent(intent);
    let intent_key = {
        let key = intent_key.trim();
        if key.is_empty() {
            normalize_intent_key(&intent)
        } else {
            normalize_intent_key(key)
        }
    };
    let selector = sanitize_control_selector(selector);
    let text_hint: String = text_hint.trim().chars().take(48).collect();
    let kind = match kind.trim().to_ascii_lowercase().as_str() {
        "fill" => "fill",
        "vision" => "vision",
        _ => "click",
    };

    if domain.is_empty() || intent_key.is_empty() {
        return Err(AppError::Validation(
            "control memory domain/intent cannot be empty".to_owned(),
        ));
    }
    if selector.is_empty() && x_percent.is_none() && y_percent.is_none() {
        return Err(AppError::Validation(
            "control memory requires selector or coordinates".to_owned(),
        ));
    }

    let now = chrono_like_now();
    let incoming_hits = hit_count.unwrap_or(1).max(1);

    connection.execute(
        "INSERT INTO agent_control_memory
            (domain, intent, intent_key, kind, selector, text_hint, x_percent, y_percent, hit_count, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
         ON CONFLICT(domain, intent_key) DO UPDATE SET
            intent = excluded.intent,
            kind = excluded.kind,
            selector = CASE WHEN excluded.selector = '' THEN agent_control_memory.selector ELSE excluded.selector END,
            text_hint = CASE WHEN excluded.text_hint = '' THEN agent_control_memory.text_hint ELSE excluded.text_hint END,
            x_percent = COALESCE(excluded.x_percent, agent_control_memory.x_percent),
            y_percent = COALESCE(excluded.y_percent, agent_control_memory.y_percent),
            hit_count = agent_control_memory.hit_count + 1,
            updated_at = excluded.updated_at",
        params![
            domain,
            intent,
            intent_key,
            kind,
            selector,
            text_hint,
            x_percent,
            y_percent,
            incoming_hits,
            now,
        ],
    )?;

    // 每域名 LRU 裁剪：保留 updated_at 最新的 50 条
    connection.execute(
        "DELETE FROM agent_control_memory
         WHERE domain = ?1
           AND id NOT IN (
             SELECT id FROM agent_control_memory
             WHERE domain = ?1
             ORDER BY updated_at DESC, id DESC
             LIMIT ?2
           )",
        params![domain, CONTROL_MEMORY_PER_DOMAIN_CAP as i64],
    )?;

    let id: i64 = connection.query_row(
        "SELECT id FROM agent_control_memory WHERE domain = ?1 AND intent_key = ?2",
        params![domain, intent_key],
        |row| row.get(0),
    )?;
    Ok(id)
}

fn chrono_like_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // ISO-ish without chrono crate dependency
    format!("{secs}")
}

pub fn list_agent_control_memory(
    connection: &Connection,
    domain: &str,
) -> Result<Vec<crate::models::AgentControlMemory>, AppError> {
    let domain = domain.trim().trim_start_matches("www.").to_ascii_lowercase();
    if domain.is_empty() {
        let mut statement = connection.prepare(
            "SELECT id, domain, intent, intent_key, kind, selector, text_hint,
                    x_percent, y_percent, hit_count, updated_at
             FROM agent_control_memory
             ORDER BY updated_at DESC, id DESC
             LIMIT 500",
        )?;
        let rows = statement
            .query_map([], map_control_memory_row)?
            .collect::<Result<Vec<_>, _>>()?;
        return Ok(rows);
    }

    let mut statement = connection.prepare(
        "SELECT id, domain, intent, intent_key, kind, selector, text_hint,
                x_percent, y_percent, hit_count, updated_at
         FROM agent_control_memory
         WHERE domain = ?1
         ORDER BY updated_at DESC, id DESC
         LIMIT 50",
    )?;
    let rows = statement
        .query_map(params![domain], map_control_memory_row)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

fn map_control_memory_row(
    row: &rusqlite::Row<'_>,
) -> Result<crate::models::AgentControlMemory, rusqlite::Error> {
    Ok(crate::models::AgentControlMemory {
        id: row.get(0)?,
        domain: row.get(1)?,
        intent: row.get(2)?,
        intent_key: row.get(3)?,
        kind: row.get(4)?,
        selector: row.get(5)?,
        text_hint: row.get(6)?,
        x_percent: row.get(7)?,
        y_percent: row.get(8)?,
        hit_count: row.get(9)?,
        updated_at: row.get(10)?,
    })
}

pub fn clear_agent_control_memory(
    connection: &Connection,
    domain: &str,
) -> Result<usize, AppError> {
    let domain = domain.trim().trim_start_matches("www.").to_ascii_lowercase();
    if domain.is_empty() {
        let affected = connection.execute("DELETE FROM agent_control_memory", [])?;
        return Ok(affected);
    }
    let affected = connection.execute(
        "DELETE FROM agent_control_memory WHERE domain = ?1",
        params![domain],
    )?;
    Ok(affected)
}

/// Milestone 3：写入 / 合并环境人设 JSON（由 Node 上报，Rust 单写落盘）
pub fn upsert_profile_persona_data(
    connection: &Connection,
    profile_id: i64,
    persona_json: &str,
) -> Result<(), AppError> {
    let trimmed = persona_json.trim();
    if trimmed.is_empty() {
        return Err(AppError::Validation(
            "persona_data cannot be empty".to_owned(),
        ));
    }
    // 校验为 JSON 对象
    let parsed: serde_json::Value = serde_json::from_str(trimmed)
        .map_err(|error| AppError::Validation(format!("persona_data must be JSON: {error}")))?;
    if !parsed.is_object() {
        return Err(AppError::Validation(
            "persona_data must be a JSON object".to_owned(),
        ));
    }

    // 若已有人设：深度合并（新字段覆盖，旧核心字段保留空位）
    let existing = get_profile(connection, profile_id)?.persona_data;
    let merged = match existing.as_deref().map(str::trim).filter(|v| !v.is_empty()) {
        Some(raw) => match serde_json::from_str::<serde_json::Value>(raw) {
            Ok(serde_json::Value::Object(mut base)) => {
                if let serde_json::Value::Object(incoming) = parsed {
                    for (key, value) in incoming {
                        // 空字符串不覆盖已有核心字段
                        let is_empty_str = value.as_str().is_some_and(|s| s.trim().is_empty());
                        if is_empty_str && base.contains_key(&key) {
                            continue;
                        }
                        base.insert(key, value);
                    }
                }
                serde_json::Value::Object(base)
            }
            _ => parsed,
        },
        None => parsed,
    };
    let stored = serde_json::to_string(&merged)
        .map_err(|error| AppError::Serialization(error.to_string()))?;

    let affected = connection.execute(
        "UPDATE profiles SET persona_data = ?1 WHERE id = ?2",
        params![stored, profile_id],
    )?;
    if affected == 0 {
        return Err(AppError::NotFound(format!("profile {profile_id}")));
    }
    Ok(())
}

pub fn get_profile_persona_data(
    connection: &Connection,
    profile_id: i64,
) -> Result<Option<String>, AppError> {
    let profile = get_profile(connection, profile_id)?;
    Ok(profile
        .persona_data
        .map(|raw| raw.trim().to_owned())
        .filter(|raw| !raw.is_empty()))
}
