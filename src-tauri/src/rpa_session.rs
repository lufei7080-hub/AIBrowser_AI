use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::Mutex as AsyncMutex;

use crate::db;
use crate::db_write_queue::DbWriteCommand;
use crate::error::AppError;
use crate::{log_error, log_info, log_warn};
use crate::fill_sidecar::{load_rpa_runtime_bundle, resolve_profile_user_data_dir};
use crate::process_win::{
    kill_process_tree, prepare_sidecar_command, register_child_for_lifecycle,
};
use crate::profile_id::parse_profile_id;
use crate::sidecar::emit_sidecar_line;
use crate::sidecar_paths::resolve_sidecar_dist;
use crate::AppState;

pub const RPA_STATE_EVENT: &str = "rpa-state";
pub const AGENT_CONFIRM_EVENT: &str = "agent-confirm-required";
pub const AGENT_ASK_EVENT: &str = "agent-ask-user";
pub const AGENT_HANDOVER_EVENT: &str = "agent-handover-required";
pub const AGENT_TASK_BLOCKED_EVENT: &str = "agent-task-blocked";
pub const AGENT_TASK_RESUMED_EVENT: &str = "agent-task-resumed";
pub const AGENT_STATE_EVENT: &str = "agent-state";
pub const AGENT_TRAJECTORY_EVENT: &str = "agent-trajectory-saved";
pub const SCRAPER_DATA_EVENT: &str = "scraper-data-collected";
/// Sidecar 终态等待上限，防止 UI 永久假死
const SIDECAR_RECV_TIMEOUT: Duration = Duration::from_secs(60);
/// Agent 循环可能较长（含人工确认），单独放宽
const AGENT_RECV_TIMEOUT: Duration = Duration::from_secs(600);

static WAIT_ID_SEQ: AtomicU64 = AtomicU64::new(1);

fn next_wait_id() -> String {
    let seq = WAIT_ID_SEQ.fetch_add(1, Ordering::Relaxed);
    format!("w-{}-{seq}", std::process::id())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RpaStatePayload {
    pub state: String,
    pub step: u32,
    pub msg: String,
    pub actions: Option<Value>,
    pub profile_id: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct RpaRunResult {
    pub state: String,
    pub step: u32,
    pub msg: String,
    pub actions: Option<Value>,
    /// 与 send_and_wait 注入的 waitId 对齐；缺省时仅 FIFO 唤醒一个 waiter
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wait_id: Option<String>,
}

struct WaiterEntry {
    wait_id: String,
    tx: mpsc::Sender<RpaRunResult>,
}

struct RpaSessionInner {
    child: Mutex<Child>,
    stdin: Mutex<std::process::ChildStdin>,
    waiters: Mutex<Vec<WaiterEntry>>,
    url_waiters: Mutex<Vec<mpsc::Sender<String>>>,
    /// Milestone 4：Node Pause HTTP 端口（127.0.0.1），供 Resume 直连
    pause_http_port: Mutex<Option<u16>>,
}

pub struct RpaSessionManager {
    sessions: Arc<DashMap<String, Arc<RpaSessionInner>>>,
    /// 按 profile 互斥 ensure_session，防止并发双 spawn 孤儿进程
    ensure_locks: DashMap<String, Arc<AsyncMutex<()>>>,
}

impl Default for RpaSessionManager {
    fn default() -> Self {
        Self {
            sessions: Arc::new(DashMap::new()),
            ensure_locks: DashMap::new(),
        }
    }
}

fn parse_rpa_state_line(line: &str) -> Option<RpaRunResult> {
    let value = serde_json::from_str::<Value>(line).ok()?;
    if value.get("type").and_then(|entry| entry.as_str()) != Some("rpa_state") {
        return None;
    }

    let state = value
        .get("state")
        .and_then(|entry| entry.as_str())
        .unwrap_or("paused")
        .to_owned();
    let step = value
        .get("step")
        .and_then(|entry| entry.as_u64())
        .unwrap_or(0) as u32;
    let msg = value
        .get("msg")
        .and_then(|entry| entry.as_str())
        .unwrap_or("")
        .to_owned();
    let actions = value.get("actions").cloned();

    Some(RpaRunResult {
        state,
        step,
        msg,
        actions,
        wait_id: value
            .get("waitId")
            .or_else(|| value.get("wait_id"))
            .and_then(|entry| entry.as_str())
            .map(str::to_owned)
            .filter(|id| !id.is_empty()),
    })
}

fn parse_page_url_line(line: &str) -> Option<String> {
    let value = serde_json::from_str::<Value>(line).ok()?;
    if value.get("type").and_then(|entry| entry.as_str()) != Some("page_url") {
        return None;
    }
    value
        .get("url")
        .and_then(|entry| entry.as_str())
        .map(str::to_owned)
}

fn emit_rpa_state(app: &AppHandle, profile_id: &str, result: &RpaRunResult) {
    let payload = RpaStatePayload {
        state: result.state.clone(),
        step: result.step,
        msg: result.msg.clone(),
        actions: result.actions.clone(),
        profile_id: profile_id.to_owned(),
    };
    let _ = app.emit(RPA_STATE_EVENT, payload);
}

fn map_recv_timeout_error(error: RecvTimeoutError, context: &str) -> AppError {
    match error {
        RecvTimeoutError::Timeout => AppError::Sidecar(format!(
            "{context} timed out after {}s (no terminal state from sidecar)",
            SIDECAR_RECV_TIMEOUT.as_secs()
        )),
        RecvTimeoutError::Disconnected => {
            AppError::Sidecar(format!("{context} channel closed before terminal state"))
        }
    }
}

/// 按 waitId 精确唤醒；无 waitId 时 FIFO 只唤醒最老的一个（禁止扇出假完成）
fn notify_waiters(session: &RpaSessionInner, result: RpaRunResult) {
    let mut waiters = session
        .waiters
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if waiters.is_empty() {
        return;
    }

    if let Some(wait_id) = result
        .wait_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
    {
        if let Some(index) = waiters.iter().position(|entry| entry.wait_id == wait_id) {
            let entry = waiters.remove(index);
            let _ = entry.tx.send(result);
            return;
        }
        log_warn!(
            "[rpa_session] waitId={wait_id} 无匹配 waiter（可能已超时移除），忽略终态"
        );
        return;
    }

    // 兼容旧 sidecar：无 waitId 时绝不 drain 全部，只唤醒队首
    let entry = waiters.remove(0);
    let _ = entry.tx.send(result);
}

/// 进程崩溃等：必须叫醒所有挂起方，避免 UI 永久挂死
fn notify_all_waiters(session: &RpaSessionInner, result: RpaRunResult) {
    let mut waiters = session
        .waiters
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    for entry in waiters.drain(..) {
        let _ = entry.tx.send(result.clone());
    }
}

fn notify_url_waiters(session: &RpaSessionInner, url: String) {
    let mut waiters = session
        .url_waiters
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    for waiter in waiters.drain(..) {
        let _ = waiter.send(url.clone());
    }
}

fn spawn_stdout_pump(
    app: AppHandle,
    profile_id: String,
    session: Arc<RpaSessionInner>,
    stdout: impl std::io::Read + Send + 'static,
    stderr: impl std::io::Read + Send + 'static,
) {
    let app_stdout = app.clone();
    let profile_for_stdout = profile_id.clone();
    let session_for_stdout = session.clone();
    std::thread::spawn(move || {
        let stdout_reader = BufReader::new(stdout);
        for line in stdout_reader.lines() {
            let line = match line {
                Ok(value) => value,
                Err(_) => break,
            };

            if let Ok(value) = serde_json::from_str::<Value>(&line) {
                if value.get("type").and_then(|entry| entry.as_str()) == Some("page_url") {
                    let url = value
                        .get("url")
                        .and_then(|entry| entry.as_str())
                        .unwrap_or("")
                        .to_owned();
                    let _ = app_stdout.emit(
                        "page-url-changed",
                        json!({
                            "profileId": profile_for_stdout,
                            "url": url,
                        }),
                    );
                    if let Some(url) = parse_page_url_line(&line) {
                        notify_url_waiters(&session_for_stdout, url);
                    }
                    continue;
                }
                if value.get("type").and_then(|entry| entry.as_str()) == Some("interactive_extract") {
                    let mut payload = value.clone();
                    if let Some(object) = payload.as_object_mut() {
                        object.insert("profileId".to_owned(), json!(profile_for_stdout));
                    }
                    let _ = app_stdout.emit("interactive-extract-updated", payload);
                    continue;
                }
            }

            emit_sidecar_line(&app_stdout, &line);

            if let Ok(value) = serde_json::from_str::<Value>(&line) {
                let event_type = value.get("type").and_then(|entry| entry.as_str());
                if event_type == Some("agent_confirm_required") {
                    let _ = app_stdout.emit(
                        AGENT_CONFIRM_EVENT,
                        json!({
                            "profileId": profile_for_stdout,
                            "requestId": value.get("requestId"),
                            "url": value.get("url"),
                            "reason": value.get("reason"),
                            "actions": value.get("actions"),
                        }),
                    );
                    continue;
                }
                if event_type == Some("agent_ask_user") {
                    let _ = app_stdout.emit(
                        AGENT_ASK_EVENT,
                        json!({
                            "profileId": profile_for_stdout,
                            "requestId": value.get("requestId"),
                            "question": value.get("question"),
                        }),
                    );
                    continue;
                }
                if event_type == Some("pause_server") {
                    // Milestone 4：记录 Node Resume HTTP 端口
                    let port = value
                        .get("port")
                        .and_then(|entry| entry.as_u64())
                        .unwrap_or(0);
                    if port > 0 && port <= u64::from(u16::MAX) {
                        if let Ok(mut guard) = session_for_stdout.pause_http_port.lock() {
                            *guard = Some(port as u16);
                        }
                    }
                    continue;
                }
                if event_type == Some("agent_handover_required") {
                    let blocked = json!({
                        "profileId": profile_for_stdout,
                        "requestId": value.get("requestId"),
                        "url": value.get("url"),
                        "reason": value.get("reason"),
                        "pausedAt": value.get("pausedAt").cloned().unwrap_or(Value::Null),
                    });
                    let _ = app_stdout.emit(AGENT_HANDOVER_EVENT, blocked.clone());
                    let _ = app_stdout.emit(AGENT_TASK_BLOCKED_EVENT, blocked);
                    continue;
                }
                if event_type == Some("agent_state") {
                    let _ = app_stdout.emit(
                        AGENT_STATE_EVENT,
                        json!({
                            "profileId": profile_for_stdout,
                            "state": value.get("state"),
                            "step": value.get("step"),
                            "msg": value.get("msg"),
                            "engine": value.get("engine"),
                        }),
                    );
                    let state = value
                        .get("state")
                        .and_then(|entry| entry.as_str())
                        .unwrap_or("");
                    if state == "complete" || state == "failed" {
                        let wait_id = value
                            .get("waitId")
                            .or_else(|| value.get("wait_id"))
                            .and_then(|entry| entry.as_str())
                            .map(str::to_owned)
                            .filter(|id| !id.is_empty());
                        notify_waiters(
                            &session_for_stdout,
                            RpaRunResult {
                                state: state.to_owned(),
                                step: value
                                    .get("step")
                                    .and_then(|entry| entry.as_u64())
                                    .unwrap_or(0) as u32,
                                msg: value
                                    .get("msg")
                                    .and_then(|entry| entry.as_str())
                                    .unwrap_or("")
                                    .to_owned(),
                                actions: None,
                                wait_id,
                            },
                        );
                    }
                    continue;
                }
                if event_type == Some("agent_trajectory") {
                    let domain = value
                        .get("domain")
                        .and_then(|entry| entry.as_str())
                        .unwrap_or("")
                        .to_owned();
                    let title = value
                        .get("title")
                        .and_then(|entry| entry.as_str())
                        .unwrap_or("未命名轨迹")
                        .to_owned();
                    let goal = value
                        .get("goal")
                        .and_then(|entry| entry.as_str())
                        .unwrap_or("")
                        .to_owned();
                    let start_url = value
                        .get("startUrl")
                        .and_then(|entry| entry.as_str())
                        .unwrap_or("")
                        .to_owned();
                    let actions = value
                        .get("actions")
                        .cloned()
                        .unwrap_or(Value::Array(vec![]));
                    let actions_json = actions.to_string();
                    let mut saved_id: Option<i64> = None;
                    if let Some(state) = app_stdout.try_state::<AppState>() {
                        // —— Milestone 1：改走单写队列（保留前端可同步拿到落库 id）——
                        let (reply_tx, reply_rx) =
                            tokio::sync::oneshot::channel::<Result<i64, String>>();
                        let enqueued = state.db_queue.enqueue(DbWriteCommand::SaveAgentTrajectory {
                            domain: domain.clone(),
                            title: title.clone(),
                            goal: goal.clone(),
                            start_url: start_url.clone(),
                            actions: actions_json.clone(),
                            reply: Some(reply_tx),
                        });
                        if enqueued.is_ok() {
                            match reply_rx.blocking_recv() {
                                Ok(Ok(id)) => saved_id = Some(id),
                                Ok(Err(error)) => {
                                    log_error!("save agent trajectory failed: {error}");
                                }
                                Err(_) => {
                                    log_warn!("save agent trajectory reply channel closed");
                                }
                            }
                        }
                    }
                    let _ = app_stdout.emit(
                        AGENT_TRAJECTORY_EVENT,
                        json!({
                            "profileId": profile_for_stdout,
                            "id": saved_id,
                            "domain": domain,
                            "title": title,
                            "goal": goal,
                            "startUrl": start_url,
                            "actions": actions,
                        }),
                    );
                    continue;
                }
                if event_type == Some("agent_control_memory") {
                    let domain = value
                        .get("domain")
                        .and_then(|entry| entry.as_str())
                        .unwrap_or("")
                        .to_owned();
                    let intent = value
                        .get("intent")
                        .and_then(|entry| entry.as_str())
                        .unwrap_or("")
                        .to_owned();
                    let intent_key = value
                        .get("intentKey")
                        .and_then(|entry| entry.as_str())
                        .unwrap_or("")
                        .to_owned();
                    let kind = value
                        .get("kind")
                        .and_then(|entry| entry.as_str())
                        .unwrap_or("click")
                        .to_owned();
                    let selector = value
                        .get("selector")
                        .and_then(|entry| entry.as_str())
                        .unwrap_or("")
                        .to_owned();
                    let text_hint = value
                        .get("textHint")
                        .and_then(|entry| entry.as_str())
                        .unwrap_or("")
                        .to_owned();
                    let x_percent = value.get("xPercent").and_then(|entry| entry.as_f64());
                    let y_percent = value.get("yPercent").and_then(|entry| entry.as_f64());
                    let hit_count = value.get("hitCount").and_then(|entry| entry.as_i64());
                    if let Some(state) = app_stdout.try_state::<AppState>() {
                        // —— Milestone 1：改走单写队列（fire-and-forget）——
                        if let Err(error) = state.db_queue.enqueue(DbWriteCommand::UpsertAgentControlMemory {
                            domain,
                            intent,
                            intent_key,
                            kind,
                            selector,
                            text_hint,
                            x_percent,
                            y_percent,
                            hit_count,
                        }) {
                            log_error!("upsert agent control memory enqueue failed: {error}");
                        }
                    }
                    continue;
                }
                if event_type == Some("persona_data") {
                    // Milestone 3：stdout 兜底人设落盘（IPC 失败时）
                    let profile_id_num = value
                        .get("profileId")
                        .and_then(|entry| {
                            entry
                                .as_i64()
                                .or_else(|| entry.as_str().and_then(|s| s.trim().parse::<i64>().ok()))
                        })
                        .or_else(|| profile_for_stdout.trim().parse::<i64>().ok())
                        .unwrap_or(0);
                    let persona_json = value
                        .get("persona")
                        .cloned()
                        .map(|v| {
                            if v.is_string() {
                                v.as_str().unwrap_or("{}").to_owned()
                            } else {
                                v.to_string()
                            }
                        })
                        .unwrap_or_else(|| "{}".to_owned());
                    if profile_id_num > 0 {
                        if let Some(state) = app_stdout.try_state::<AppState>() {
                            if let Err(error) = state.db_queue.enqueue(DbWriteCommand::SavePersonaData {
                                profile_id: profile_id_num,
                                persona_json,
                                reply: None,
                            }) {
                                log_error!("save persona_data enqueue failed: {error}");
                            }
                        }
                    }
                    continue;
                }
                if event_type == Some("scraper_data_collected") {
                    let data = value
                        .get("data")
                        .cloned()
                        .unwrap_or(Value::Array(vec![]));
                    let _ = app_stdout.emit(
                        SCRAPER_DATA_EVENT,
                        json!({
                            "profileId": profile_for_stdout,
                            "data": data,
                            "mode": value.get("mode"),
                            "url": value.get("url"),
                            "count": value.get("count"),
                            "reason": value.get("reason"),
                            "append": value.get("append").and_then(|v| v.as_bool()).unwrap_or(false),
                            "localPath": value.get("localPath"),
                        }),
                    );
                    continue;
                }
                if event_type == Some("interactive_extract") {
                    let mut payload = value.clone();
                    if let Some(object) = payload.as_object_mut() {
                        object.insert("profileId".to_owned(), json!(profile_for_stdout));
                    }
                    let _ = app_stdout.emit("interactive-extract-updated", payload);
                    continue;
                }
            }

            if let Some(result) = parse_rpa_state_line(&line) {
                emit_rpa_state(&app_stdout, &profile_for_stdout, &result);
                if result.state == "paused" || result.state == "complete" {
                    notify_waiters(&session_for_stdout, result);
                }
            }

            if let Some(url) = parse_page_url_line(&line) {
                notify_url_waiters(&session_for_stdout, url);
            }
        }
    });

    let app_stderr = app;
    std::thread::spawn(move || {
        let stderr_reader = BufReader::new(stderr);
        for line in stderr_reader.lines().flatten() {
            emit_sidecar_line(
                &app_stderr,
                &serde_json::json!({
                    "kind": "error",
                    "level": "error",
                    "message": "sidecar_stderr",
                    "data": { "line": line }
                })
                .to_string(),
            );
        }
    });
}

/// Phase 1：Sidecar 意外退出守望 — 从 sessions 移除并推送终态，消除 UI 幽灵「运行中」。
fn spawn_rpa_exit_watcher(
    sessions: Arc<DashMap<String, Arc<RpaSessionInner>>>,
    app: AppHandle,
    profile_id: String,
) {
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(Duration::from_millis(500));

            let exited = if let Some(session) = sessions.get(&profile_id) {
                match session.child.lock() {
                    Ok(mut child) => match child.try_wait() {
                        Ok(Some(_status)) => true,
                        Ok(None) => false,
                        Err(_) => true,
                    },
                    Err(_) => true,
                }
            } else {
                // 已被 stop_session 主动移除
                break;
            };

            if !exited {
                continue;
            }

            if let Some((_, session)) = sessions.remove(&profile_id) {
                let result = RpaRunResult {
                    state: "failed".to_owned(),
                    step: 0,
                    msg: "Sidecar 进程意外退出，会话已清理".to_owned(),
                    actions: None,
                    wait_id: None,
                };
                notify_all_waiters(&session, result.clone());
                emit_rpa_state(&app, &profile_id, &result);
                let _ = app.emit(
                    AGENT_STATE_EVENT,
                    json!({
                        "profileId": profile_id,
                        "state": "failed",
                        "step": 0,
                        "msg": "Sidecar 进程意外退出，会话已清理",
                    }),
                );
                log_info!(
                    "[rpa_session] exit watcher cleaned ghost session profile={profile_id}"
                );
            }
            break;
        }
    });
}

impl RpaSessionManager {
    pub fn has_session(&self, profile_id: &str) -> bool {
        self.sessions.contains_key(profile_id)
    }

    /// Host 级忙碌：存在挂起的 send_and_wait waiter（Agent/RPA/轨迹回放）
    pub fn is_engine_busy(&self, profile_id: &str) -> bool {
        let Some(session) = self.sessions.get(profile_id) else {
            return false;
        };
        session
            .waiters
            .lock()
            .map(|guard| !guard.is_empty())
            .unwrap_or(true)
    }

    pub async fn ensure_session(
        &self,
        app: &AppHandle,
        db_state: &AppState,
        profile_id: &str,
    ) -> Result<(), AppError> {
        if self.sessions.contains_key(profile_id) {
            return Ok(());
        }

        let lock = self
            .ensure_locks
            .entry(profile_id.to_owned())
            .or_insert_with(|| Arc::new(AsyncMutex::new(())))
            .clone();
        let _guard = lock.lock().await;

        // 双检：拿到锁后再看是否已被其它任务 spawn
        if self.sessions.contains_key(profile_id) {
            return Ok(());
        }

        let bundle = load_rpa_runtime_bundle(db_state, profile_id, "{}", false, None).await?;
        let sidecar_entry = resolve_sidecar_dist("index.js")?;

        let mut command = Command::new("node");
        command
            .arg(&sidecar_entry)
            .arg("--cdp-url")
            .arg(&bundle.cdp_url)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        prepare_sidecar_command(&mut command);
        // —— Milestone 1：注入本地 IPC 地址，Sidecar 走 HTTP /report 上报 ——
        if let Some(state) = app.try_state::<AppState>() {
            crate::local_ipc::apply_ipc_env(&mut command, &state.local_ipc.base_url, profile_id);
        }
        let mut child = command
            .spawn()
            .map_err(|error| AppError::Sidecar(format!("failed to spawn rpa sidecar: {error}")))?;
        // Job Object / 进程组：Tauri 强杀时级联回收 Node Sidecar
        if let Err(error) = register_child_for_lifecycle(&child) {
            log_warn!("[rpa_session] register_child_for_lifecycle skipped: {error}");
        }

        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| AppError::Sidecar("rpa sidecar stdout unavailable".to_owned()))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| AppError::Sidecar("rpa sidecar stderr unavailable".to_owned()))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| AppError::Sidecar("rpa sidecar stdin unavailable".to_owned()))?;

        let session = Arc::new(RpaSessionInner {
            child: Mutex::new(child),
            stdin: Mutex::new(stdin),
            waiters: Mutex::new(Vec::new()),
            url_waiters: Mutex::new(Vec::new()),
            pause_http_port: Mutex::new(None),
        });

        spawn_stdout_pump(
            app.clone(),
            profile_id.to_owned(),
            session.clone(),
            stdout,
            stderr,
        );

        self.sessions
            .insert(profile_id.to_owned(), session);

        spawn_rpa_exit_watcher(self.sessions.clone(), app.clone(), profile_id.to_owned());

        tokio::time::sleep(Duration::from_millis(1500)).await;
        Ok(())
    }

    fn write_command(&self, profile_id: &str, command: Value) -> Result<(), AppError> {
        let session = self
            .sessions
            .get(profile_id)
            .ok_or_else(|| AppError::Validation(format!("no rpa session for profile {profile_id}")))?;

        let line = format!("{command}\n");
        let mut stdin = session
            .stdin
            .lock()
            .map_err(|_| AppError::State("rpa stdin lock poisoned".to_owned()))?;
        stdin
            .write_all(line.as_bytes())
            .map_err(|error| AppError::Sidecar(format!("failed to write rpa command: {error}")))?;
        stdin
            .flush()
            .map_err(|error| AppError::Sidecar(format!("failed to flush rpa command: {error}")))?;
        Ok(())
    }

    pub async fn send_and_wait(
        &self,
        app: &AppHandle,
        db_state: &AppState,
        profile_id: &str,
        command: Value,
        wait_for_terminal: bool,
    ) -> Result<Option<RpaRunResult>, AppError> {
        self.send_and_wait_with_timeout(
            app,
            db_state,
            profile_id,
            command,
            wait_for_terminal,
            SIDECAR_RECV_TIMEOUT,
        )
        .await
    }

    pub async fn send_and_wait_with_timeout(
        &self,
        app: &AppHandle,
        db_state: &AppState,
        profile_id: &str,
        mut command: Value,
        wait_for_terminal: bool,
        timeout: Duration,
    ) -> Result<Option<RpaRunResult>, AppError> {
        self.ensure_session(app, db_state, profile_id).await?;

        let wait_id = next_wait_id();
        if let Some(object) = command.as_object_mut() {
            object.insert("waitId".to_owned(), json!(wait_id.clone()));
        }

        let (tx, rx) = mpsc::channel();
        if wait_for_terminal {
            let session = self
                .sessions
                .get(profile_id)
                .ok_or_else(|| {
                    AppError::Validation(format!("no rpa session for profile {profile_id}"))
                })?;
            session
                .waiters
                .lock()
                .map_err(|_| AppError::State("rpa waiters lock poisoned".to_owned()))?
                .push(WaiterEntry {
                    wait_id: wait_id.clone(),
                    tx,
                });
        }

        self.write_command(profile_id, command)?;

        if !wait_for_terminal {
            return Ok(None);
        }

        let result = tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(timeout))
            .await
            .map_err(|error| AppError::Sidecar(error.to_string()))?
            .map_err(|error| {
                // 超时后移除本 waitId，避免迟到终态误唤醒后续 waiter
                if let Some(session) = self.sessions.get(profile_id) {
                    if let Ok(mut waiters) = session.waiters.lock() {
                        waiters.retain(|entry| entry.wait_id != wait_id);
                    }
                }
                map_recv_timeout_error(error, "rpa/agent send_and_wait")
            })?;

        Ok(Some(result))
    }

    pub fn write_session_command(&self, profile_id: &str, command: Value) -> Result<(), AppError> {
        self.write_command(profile_id, command)
    }

    pub fn set_pause_http_port(&self, profile_id: &str, port: u16) -> Result<(), AppError> {
        let session = self
            .sessions
            .get(profile_id)
            .ok_or_else(|| AppError::Validation(format!("no rpa session for profile {profile_id}")))?;
        let mut guard = session
            .pause_http_port
            .lock()
            .map_err(|_| AppError::State("rpa pause_http_port lock poisoned".to_owned()))?;
        *guard = if port > 0 { Some(port) } else { None };
        Ok(())
    }

    pub fn get_pause_http_port(&self, profile_id: &str) -> Option<u16> {
        let session = self.sessions.get(profile_id)?;
        session
            .pause_http_port
            .lock()
            .ok()
            .and_then(|guard| *guard)
    }

    pub fn stop_session(&self, profile_id: &str) -> Result<(), AppError> {
        if let Some((_, session)) = self.sessions.remove(profile_id) {
            // 先发 abort，再强制 kill，杜绝僵尸 Node 进程
            let _ = session.stdin.lock().map(|mut stdin| {
                let _ = stdin.write_all(b"{\"command\":\"agent_abort\"}\n");
                let _ = stdin.write_all(b"{\"command\":\"abort\"}\n");
                let _ = stdin.flush();
            });
            if let Ok(mut child) = session.child.lock() {
                let pid = child.id();
                let _ = child.kill();
                let _ = child.wait();
                // Windows：若子进程树残留，复用统一 kill 工具（含 CREATE_NO_WINDOW，杜绝黑框）
                #[cfg(windows)]
                if pid > 0 {
                    let _ = kill_process_tree(pid);
                }
                log_info!("[rpa_session] killed sidecar for profile={profile_id} pid={pid}");
            }
        }
        Ok(())
    }

    pub fn stop_all_sessions(&self) {
        let keys: Vec<String> = self.sessions.iter().map(|entry| entry.key().clone()).collect();
        for profile_id in keys {
            let _ = self.stop_session(&profile_id);
        }
    }

    pub async fn fetch_page_url(
        &self,
        app: &AppHandle,
        db_state: &AppState,
        profile_id: &str,
    ) -> Result<String, AppError> {
        self.ensure_session(app, db_state, profile_id).await?;

        let (tx, rx) = mpsc::channel();
        {
            let session = self
                .sessions
                .get(profile_id)
                .ok_or_else(|| {
                    AppError::Validation(format!("no rpa session for profile {profile_id}"))
                })?;
            session
                .url_waiters
                .lock()
                .map_err(|_| AppError::State("rpa url waiters lock poisoned".to_owned()))?
                .push(tx);
        }

        self.write_command(
            profile_id,
            json!({
                "command": "get_url",
            }),
        )?;

        let url = tauri::async_runtime::spawn_blocking(move || {
            rx.recv_timeout(SIDECAR_RECV_TIMEOUT)
        })
        .await
        .map_err(|error| AppError::Sidecar(error.to_string()))?
        .map_err(|error| map_recv_timeout_error(error, "fetch_page_url"))?;

        Ok(url)
    }
}

async fn build_rpa_start_command(
    app: &AppHandle,
    db_state: &AppState,
    profile_id: &str,
    raw_input: &str,
    actions: Option<Value>,
    confirmed_profile: Option<String>,
    skip_hybrid: bool,
    press_enter_after_fill: bool,
    continuous: bool,
) -> Result<Value, AppError> {
    let has_actions = actions
        .as_ref()
        .and_then(|value| value.as_array())
        .is_some_and(|entries| !entries.is_empty());
    let require_ai = !skip_hybrid && !has_actions;
    let user_data_dir = resolve_profile_user_data_dir(app, profile_id)
        .ok()
        .map(|path| path.to_string_lossy().to_string());
    let bundle = load_rpa_runtime_bundle(db_state, profile_id, raw_input, require_ai, user_data_dir).await?;

    let mut command = json!({
        "command": "rpa_start",
        "profile": bundle.profile_payload,
        "rawInput": bundle.raw_input,
        "skipHybrid": skip_hybrid,
        "pressEnterAfterFill": press_enter_after_fill,
        "continuous": continuous,
        "proxyAuth": bundle.proxy_auth,
    });

    if let Some(dir) = &bundle.user_data_dir {
        command["userDataDir"] = json!(dir);
    }

    if let Some(ai_settings) = bundle.ai_settings {
        command["ai"] = ai_settings;
    }

    if let Some(actions_value) = actions {
        command["actions"] = actions_value;
    }

    if let Some(confirmed) = confirmed_profile {
        let trimmed = confirmed.trim();
        if trimmed.is_empty() {
            return Err(AppError::Validation(
                "confirmed fill profile cannot be empty".to_owned(),
            ));
        }
        let parsed: Value = serde_json::from_str(trimmed).map_err(|error| {
            AppError::Validation(format!("confirmed profile is not valid JSON: {error}"))
        })?;
        if !parsed.is_object() {
            return Err(AppError::Validation(
                "confirmed profile JSON must be an object".to_owned(),
            ));
        }
        command["confirmedProfile"] = parsed;
    }

    Ok(command)
}

#[tauri::command]
pub async fn start_rpa_session(
    app: AppHandle,
    db_state: State<'_, AppState>,
    manager: State<'_, RpaSessionManager>,
    profile_id: String,
) -> Result<(), AppError> {
    parse_profile_id(&profile_id)?;
    manager.ensure_session(&app, &db_state, &profile_id).await
}

#[tauri::command]
pub async fn stop_rpa_session(
    manager: State<'_, RpaSessionManager>,
    profile_id: String,
) -> Result<(), AppError> {
    parse_profile_id(&profile_id)?;
    manager.stop_session(&profile_id)
}

#[tauri::command]
pub async fn run_rpa_fill(
    app: AppHandle,
    db_state: State<'_, AppState>,
    manager: State<'_, RpaSessionManager>,
    profile_id: String,
    raw_input: String,
    actions: Option<Value>,
    confirmed_profile: Option<String>,
    skip_hybrid: Option<bool>,
    press_enter_after_fill: Option<bool>,
    continuous: Option<bool>,
) -> Result<RpaRunResult, AppError> {
    parse_profile_id(&profile_id)?;
    let command = build_rpa_start_command(
        &app,
        &db_state,
        &profile_id,
        &raw_input,
        actions,
        confirmed_profile,
        skip_hybrid.unwrap_or(false),
        press_enter_after_fill.unwrap_or(false),
        continuous.unwrap_or(false),
    )
    .await?;

    let result = manager
        .send_and_wait(&app, &db_state, &profile_id, command, true)
        .await?
        .ok_or_else(|| AppError::Sidecar("rpa fill finished without state".to_owned()))?;

    Ok(result)
}

#[tauri::command]
pub async fn resume_rpa_fill(
    app: AppHandle,
    db_state: State<'_, AppState>,
    manager: State<'_, RpaSessionManager>,
    profile_id: String,
) -> Result<RpaRunResult, AppError> {
    parse_profile_id(&profile_id)?;
    let result = manager
        .send_and_wait(
            &app,
            &db_state,
            &profile_id,
            json!({ "command": "rpa_resume" }),
            true,
        )
        .await?
        .ok_or_else(|| AppError::Sidecar("rpa resume finished without state".to_owned()))?;
    Ok(result)
}

#[tauri::command]
pub async fn rescan_rpa_page(
    app: AppHandle,
    db_state: State<'_, AppState>,
    manager: State<'_, RpaSessionManager>,
    profile_id: String,
    raw_input: Option<String>,
) -> Result<RpaRunResult, AppError> {
    parse_profile_id(&profile_id)?;
    let input = raw_input.unwrap_or_else(|| "{}".to_owned());
    let user_data_dir = resolve_profile_user_data_dir(&app, &profile_id)
        .ok()
        .map(|path| path.to_string_lossy().to_string());
    let bundle = load_rpa_runtime_bundle(&db_state, &profile_id, &input, false, user_data_dir).await?;
    let result = manager
        .send_and_wait(
            &app,
            &db_state,
            &profile_id,
            json!({
                "command": "rpa_rescan",
                "profile": bundle.profile_payload,
                "rawInput": bundle.raw_input,
                "userDataDir": bundle.user_data_dir,
            }),
            true,
        )
        .await?
        .ok_or_else(|| AppError::Sidecar("rpa rescan finished without state".to_owned()))?;
    Ok(result)
}

#[tauri::command]
pub async fn pause_rpa_fill(
    app: AppHandle,
    db_state: State<'_, AppState>,
    manager: State<'_, RpaSessionManager>,
    profile_id: String,
) -> Result<(), AppError> {
    parse_profile_id(&profile_id)?;
    manager
        .send_and_wait(
            &app,
            &db_state,
            &profile_id,
            json!({ "command": "rpa_pause" }),
            false,
        )
        .await?;
    Ok(())
}

#[tauri::command]
pub async fn get_profile_page_url(
    app: AppHandle,
    db_state: State<'_, AppState>,
    manager: State<'_, RpaSessionManager>,
    profile_id: String,
) -> Result<String, AppError> {
    parse_profile_id(&profile_id)?;
    manager
        .fetch_page_url(&app, &db_state, &profile_id)
        .await
}

#[tauri::command]
pub async fn start_autonomous_agent(
    app: AppHandle,
    db_state: State<'_, AppState>,
    manager: State<'_, RpaSessionManager>,
    profile_id: String,
    goal: String,
    max_rounds: Option<u32>,
    sense_mode: Option<String>,
    enable_recording: Option<bool>,
) -> Result<RpaRunResult, AppError> {
    parse_profile_id(&profile_id)?;
    let trimmed = goal.trim();
    if trimmed.is_empty() {
        return Err(AppError::Validation("agent goal cannot be empty".to_owned()));
    }

    // Free Key + 151-pro pin: fingerprint only — block Agent
    {
        let entitlement = crate::key_file::resolve_license_entitlement(&db_state).await?;
        let browser_version = {
            let connection = db_state
                .database
                .lock()
                .map_err(|_| AppError::State("database lock poisoned".to_owned()))?;
            let numeric_id = parse_profile_id(&profile_id)?;
            db::get_profile(&connection, numeric_id)?.browser_version
        };
        crate::kernel_policy::assert_ai_allowed_for_browser_version(
            entitlement.is_pro,
            &browser_version,
        )?;
    }

    // 默认关闭：录制须显式开启，避免一次性任务污染轨迹库
    let enable_recording = enable_recording.unwrap_or(false);

    let bundle = load_rpa_runtime_bundle(&db_state, &profile_id, "{}", true, None).await?;
    let ai = bundle.ai_settings.ok_or_else(|| {
        AppError::Validation("AI API key is not configured in global settings".to_owned())
    })?;

    // 感知模式固定均衡：兼容旧调用方仍传 sense_mode，运行时一律忽略
    let _ = sense_mode;
    let mode = "balanced";

    // 开局注入同站控件记忆（脱敏 selector + 意图），供 sidecar LRU hydrate
    let (control_memory, persona_data, numeric_id, panorama_enabled) = {
        let connection = db_state
            .database
            .lock()
            .map_err(|_| AppError::State("database lock poisoned".to_owned()))?;
        let numeric_id = parse_profile_id(&profile_id)?;
        let control_memory = db::list_agent_control_memory(&connection, "").unwrap_or_default();
        let persona_data = db::get_profile_persona_data(&connection, numeric_id).unwrap_or(None);
        let panorama_enabled = db::get_profile(&connection, numeric_id)
            .map(|p| p.agent_panorama_enabled)
            .unwrap_or(false);
        (control_memory, persona_data, numeric_id, panorama_enabled)
    };
    let control_memory_json: Vec<Value> = control_memory
        .into_iter()
        .map(|row| {
            json!({
                "domain": row.domain,
                "intent": row.intent,
                "intentKey": row.intent_key,
                "kind": row.kind,
                "selector": row.selector,
                "textHint": row.text_hint,
                "xPercent": row.x_percent,
                "yPercent": row.y_percent,
                "hitCount": row.hit_count,
                "updatedAt": row.updated_at,
            })
        })
        .collect();

    // Milestone 3：解析代理 GeoIP（Country/Region/City），强绑定造境上下文
    let geo_context = {
        let proxy_input = {
            let connection = db_state
                .database
                .lock()
                .map_err(|_| AppError::State("database lock poisoned".to_owned()))?;
            let profile = db::get_profile(&connection, numeric_id)?;
            crate::proxy::proxy_resolution_input_from_profile(&connection, &profile)?
        };
        match proxy_input {
            Some(input) => {
                match crate::proxy::resolve_profile_proxy_input(input).await {
                    Ok(resolved) => match crate::ip_geo::resolve_proxy_egress_env(&resolved).await {
                        Ok(env) => Some(json!({
                            "exitIp": env.exit_ip,
                            "country": env.country,
                            "countryCode": env.country_code,
                            "region": env.region,
                            "city": env.city,
                            "timezone": env.timezone,
                            "locale": env.locale,
                            "latitude": env.latitude,
                            "longitude": env.longitude,
                        })),
                        Err(error) => {
                            log_warn!("CloakForge: agent geo resolve failed: {error}");
                            None
                        }
                    },
                    Err(error) => {
                        log_warn!("CloakForge: agent proxy resolve failed: {error}");
                        None
                    }
                }
            }
            None => match crate::ip_geo::lookup_direct_env_sync().await {
                Ok(env) => Some(json!({
                    "exitIp": env.exit_ip,
                    "country": env.country,
                    "countryCode": env.country_code,
                    "region": env.region,
                    "city": env.city,
                    "timezone": env.timezone,
                    "locale": env.locale,
                    "latitude": env.latitude,
                    "longitude": env.longitude,
                })),
                Err(error) => {
                    log_warn!("CloakForge: agent direct geo skipped: {error}");
                    None
                }
            },
        }
    };

    let mut command = json!({
        "command": "agent_start",
        "goal": trimmed,
        "maxRounds": max_rounds.unwrap_or(15),
        "senseMode": mode,
        "ai": ai,
        "profileId": profile_id,
        "controlMemory": control_memory_json,
        "enableRecording": enable_recording,
        "panoramaEnabled": panorama_enabled,
    });
    if let Ok(dir) = crate::fill_sidecar::resolve_profile_user_data_dir(&app, &profile_id) {
        command["userDataDir"] = json!(dir.to_string_lossy());
    }
    if let Some(geo) = geo_context {
        command["geoContext"] = geo;
    }
    if let Some(persona) = persona_data {
        if let Ok(parsed) = serde_json::from_str::<Value>(&persona) {
            command["personaData"] = parsed;
        } else {
            command["personaData"] = Value::String(persona);
        }
    }
    if let Some(proxy) = bundle.proxy_auth {
        command["proxyAuth"] = serde_json::to_value(&proxy).map_err(|error| {
            AppError::Validation(format!("failed to serialize proxyAuth: {error}"))
        })?;
    }
    {
        let connection = db_state
            .database
            .lock()
            .map_err(|_| AppError::State("database lock poisoned".to_owned()))?;
        if let Ok(roots) = crate::storage_paths::download_roots_json(&app, &connection) {
            command["storage"] = roots;
        }
    }

    let result = manager
        .send_and_wait_with_timeout(
            &app,
            &db_state,
            &profile_id,
            command,
            true,
            AGENT_RECV_TIMEOUT,
        )
        .await?
        .ok_or_else(|| AppError::Sidecar("agent finished without terminal state".to_owned()))?;

    Ok(result)
}

#[tauri::command]
pub async fn confirm_agent_action(
    manager: State<'_, RpaSessionManager>,
    profile_id: String,
    request_id: String,
    fill_overrides: Option<Value>,
) -> Result<(), AppError> {
    parse_profile_id(&profile_id)?;
    let request_id = request_id.trim();
    if request_id.is_empty() {
        return Err(AppError::Validation("request_id cannot be empty".to_owned()));
    }

    let mut command = json!({
        "command": "agent_confirm",
        "requestId": request_id,
    });
    if let Some(overrides) = fill_overrides {
        command["fillOverrides"] = overrides;
    }

    manager.write_session_command(&profile_id, command)
}

#[tauri::command]
pub async fn cancel_agent_action(
    manager: State<'_, RpaSessionManager>,
    profile_id: String,
    request_id: Option<String>,
) -> Result<(), AppError> {
    parse_profile_id(&profile_id)?;
    let mut command = json!({ "command": "agent_cancel" });
    if let Some(id) = request_id.map(|value| value.trim().to_owned()).filter(|value| !value.is_empty())
    {
        command["requestId"] = json!(id);
    }
    manager.write_session_command(&profile_id, command)
}

#[tauri::command]
pub async fn reply_agent_ask(
    manager: State<'_, RpaSessionManager>,
    profile_id: String,
    request_id: String,
    answer: String,
) -> Result<(), AppError> {
    parse_profile_id(&profile_id)?;
    let request_id = request_id.trim();
    if request_id.is_empty() {
        return Err(AppError::Validation("request_id cannot be empty".to_owned()));
    }
    manager.write_session_command(
        &profile_id,
        json!({
            "command": "agent_user_reply",
            "requestId": request_id,
            "answer": answer,
        }),
    )
}

#[tauri::command]
pub async fn continue_agent_handover(
    app: AppHandle,
    manager: State<'_, RpaSessionManager>,
    profile_id: String,
    request_id: Option<String>,
) -> Result<(), AppError> {
    parse_profile_id(&profile_id)?;
    let request_id_trim = request_id
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty());

    // Milestone 4：优先 HTTP POST /resume 打破 Node 未决 Promise；stdin 作兜底
    if let Some(port) = manager.get_pause_http_port(&profile_id) {
        let url = format!("http://127.0.0.1:{port}/resume");
        let body = match &request_id_trim {
            Some(id) => json!({ "requestId": id }),
            None => json!({}),
        };
        match reqwest::Client::new()
            .post(&url)
            .json(&body)
            .timeout(Duration::from_secs(3))
            .send()
            .await
        {
            Ok(response) => {
                if !response.status().is_success() {
                    log_warn!(
                        "CloakForge: pause resume http status={} profile={}",
                        response.status(),
                        profile_id
                    );
                }
            }
            Err(error) => {
                log_error!("CloakForge: pause resume http failed: {error}");
            }
        }
    }

    let mut command = json!({ "command": "agent_handover_continue" });
    if let Some(id) = &request_id_trim {
        command["requestId"] = json!(id);
    }
    manager.write_session_command(&profile_id, command)?;

    let _ = app.emit(
        AGENT_TASK_RESUMED_EVENT,
        json!({
            "profileId": profile_id,
            "requestId": request_id_trim,
        }),
    );
    Ok(())
}

/// Milestone 4：将环境 Chromium 页面前台唤醒（CDP Page.bringToFront + Win 任务栏）
#[tauri::command]
pub async fn bring_profile_to_front(
    app: AppHandle,
    db_state: State<'_, AppState>,
    manager: State<'_, RpaSessionManager>,
    profile_id: String,
) -> Result<(), AppError> {
    parse_profile_id(&profile_id)?;
    // 1) Sidecar：Playwright/CDP bringToFront
    let _ = manager.write_session_command(
        &profile_id,
        json!({ "command": "agent_bring_to_front" }),
    );
    // 2) Windows：按 CDP 端口把窗口抬到前台
    let _ = focus_profile_browser_inner(&db_state, &profile_id).await;
    let _ = app;
    Ok(())
}

async fn focus_profile_browser_inner(
    db_state: &AppState,
    profile_id: &str,
) -> Result<(), AppError> {
    let numeric_id = parse_profile_id(profile_id)?;
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
pub async fn abort_autonomous_agent(
    app: AppHandle,
    manager: State<'_, RpaSessionManager>,
    profile_id: String,
) -> Result<(), AppError> {
    parse_profile_id(&profile_id)?;
    manager.write_session_command(&profile_id, json!({ "command": "agent_abort" }))?;
    let _ = app.emit(
        AGENT_TASK_RESUMED_EVENT,
        json!({
            "profileId": profile_id,
            "requestId": Value::Null,
            "aborted": true,
        }),
    );
    Ok(())
}

/// 轨迹回放：机械步骤 + 目标需交付时混合 LLM 分析（对齐 Agent 效果）
#[tauri::command]
pub async fn replay_agent_trajectory(
    app: AppHandle,
    db_state: State<'_, AppState>,
    manager: State<'_, RpaSessionManager>,
    profile_id: String,
    file_path: Option<String>,
    actions: Option<Value>,
    title: Option<String>,
    goal: Option<String>,
    value_overrides: Option<Value>,
) -> Result<RpaRunResult, AppError> {
    parse_profile_id(&profile_id)?;

    let path = file_path
        .as_ref()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty());
    let has_actions = actions
        .as_ref()
        .and_then(|value| value.as_array())
        .is_some_and(|entries| !entries.is_empty());

    if path.is_none() && !has_actions {
        return Err(AppError::Validation(
            "replay 需要 file_path 或非空 actions".to_owned(),
        ));
    }

    if let Some(ref file) = path {
        let file_norm = file.replace('\\', "/").to_ascii_lowercase();
        let under_exports = file_norm.contains("agent_exports/trajectories");
        let under_resolved = crate::trajectory_files::path_is_under_trajectories(file)
            || crate::trajectory_files::resolve_trajectories_dir()
                .ok()
                .is_some_and(|dir| PathBuf::from(file).starts_with(dir));
        if !under_exports && !under_resolved {
            return Err(AppError::Validation(
                "file_path 必须位于 agent_exports/trajectories/".to_owned(),
            ));
        }
    }

    let mut bundle = load_rpa_runtime_bundle(&db_state, &profile_id, "{}", false, None).await?;

    // 沙盘延迟造数需要 AI + GeoIP + 人设
    let needs_jit = value_overrides
        .as_ref()
        .and_then(|value| value.as_object())
        .is_some_and(|map| {
            map.values().any(|entry| {
                entry
                    .get("mode")
                    .and_then(|mode| mode.as_str())
                    .is_some_and(|mode| mode.eq_ignore_ascii_case("ai_prompt"))
            })
        });
    if needs_jit && bundle.ai_settings.is_none() {
        bundle = load_rpa_runtime_bundle(&db_state, &profile_id, "{}", true, None).await?;
    }

    let numeric_id = parse_profile_id(&profile_id)?;
    let persona_data = {
        let connection = db_state
            .database
            .lock()
            .map_err(|_| AppError::State("database lock poisoned".to_owned()))?;
        db::get_profile_persona_data(&connection, numeric_id).unwrap_or(None)
    };

    let geo_context = {
        let proxy_input = {
            let connection = db_state
                .database
                .lock()
                .map_err(|_| AppError::State("database lock poisoned".to_owned()))?;
            let profile = db::get_profile(&connection, numeric_id)?;
            crate::proxy::proxy_resolution_input_from_profile(&connection, &profile)?
        };
        match proxy_input {
            Some(input) => match crate::proxy::resolve_profile_proxy_input(input).await {
                Ok(resolved) => crate::ip_geo::resolve_proxy_egress_env(&resolved)
                    .await
                    .ok()
                    .map(|env| {
                        json!({
                            "exitIp": env.exit_ip,
                            "country": env.country,
                            "countryCode": env.country_code,
                            "region": env.region,
                            "city": env.city,
                            "timezone": env.timezone,
                            "locale": env.locale,
                            "latitude": env.latitude,
                            "longitude": env.longitude,
                        })
                    }),
                Err(_) => None,
            },
            None => crate::ip_geo::lookup_direct_env_sync().await.ok().map(|env| {
                json!({
                    "exitIp": env.exit_ip,
                    "country": env.country,
                    "countryCode": env.country_code,
                    "region": env.region,
                    "city": env.city,
                    "timezone": env.timezone,
                    "locale": env.locale,
                    "latitude": env.latitude,
                    "longitude": env.longitude,
                })
            }),
        }
    };

    let mut command = json!({
        "command": "trajectory_replay",
        "title": title.unwrap_or_else(|| "轨迹回放".to_owned()),
        "goal": goal.unwrap_or_default(),
        "proxyAuth": bundle.proxy_auth,
    });
    if let Some(file) = path {
        command["filePath"] = json!(file);
    }
    if let Some(actions_value) = actions {
        command["actions"] = actions_value;
    }
    if let Some(overrides) = value_overrides {
        if overrides.is_object() {
            command["valueOverrides"] = overrides;
        }
    }
    if let Some(ai_settings) = bundle.ai_settings {
        command["ai"] = ai_settings;
    }
    if let Some(geo) = geo_context {
        command["geoContext"] = geo;
    }
    if let Some(persona) = persona_data {
        if let Ok(parsed) = serde_json::from_str::<Value>(&persona) {
            command["personaData"] = parsed;
        } else {
            command["personaData"] = Value::String(persona);
        }
    }

    let result = manager
        .send_and_wait_with_timeout(
            &app,
            &db_state,
            &profile_id,
            command,
            true,
            AGENT_RECV_TIMEOUT,
        )
        .await?
        .ok_or_else(|| AppError::Sidecar("trajectory replay finished without state".to_owned()))?;

    Ok(result)
}

