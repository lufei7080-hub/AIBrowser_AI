//! 本地 IPC 服务（Milestone 1 + 4）
//!
//! 仅监听 127.0.0.1（随机端口），供 Node Sidecar 通过 HTTP 上报
//! 轨迹 / 同站控件记忆 / Pause 阻塞等数据，由 Rust 单写队列统一落库或推前端。
//!
//! 端点：
//! - `GET  /health`   健康检查
//! - `POST /report`   上报（body 为单行 JSON，含 `type` 字段）

use std::net::SocketAddr;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::Router;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use crate::db_write_queue::{DbWriteCommand, DbWriteQueue};
use crate::error::AppError;
use crate::{log_error, log_warn};

/// 轨迹落库成功事件名（与 rpa_session.rs 的 AGENT_TRAJECTORY_EVENT 保持一致）
const AGENT_TRAJECTORY_EVENT: &str = "agent-trajectory-saved";
/// Milestone 4：全局任务接管中心
const AGENT_TASK_BLOCKED_EVENT: &str = "agent-task-blocked";
const AGENT_HANDOVER_EVENT: &str = "agent-handover-required";

/// /report 处理器持有的状态。
#[derive(Clone)]
struct ReportState {
    app: AppHandle,
    queue: Arc<DbWriteQueue>,
}

/// 本地 IPC 服务句柄：持有 base_url 与优雅停机所需的信号。
pub struct LocalIpcServer {
    pub base_url: String,
    shutdown_tx: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
    stopped_rx: Mutex<Option<mpsc::Receiver<()>>>,
}

impl LocalIpcServer {
    /// 优雅停机：通知 HTTP 服务停止接受新请求，等待在途请求处理完毕（带 5s 兜底）。
    pub fn shutdown(&self) {
        if let Ok(mut guard) = self.shutdown_tx.lock() {
            if let Some(tx) = guard.take() {
                let _ = tx.send(());
            }
        }
        if let Ok(mut guard) = self.stopped_rx.lock() {
            if let Some(rx) = guard.take() {
                let _ = rx.recv_timeout(Duration::from_secs(5));
            }
        }
    }
}

/// 将本地 IPC 地址与 profile 标识注入 sidecar 进程环境，
/// 使 Node 侧 ipc_client 能直连 Rust 的 /report 端点。
pub fn apply_ipc_env(cmd: &mut std::process::Command, ipc_url: &str, profile_id: &str) {
    cmd.env("CLOAKFORGE_IPC_URL", ipc_url);
    cmd.env("CLOAKFORGE_PROFILE_ID", profile_id);
}

/// 启动本地 IPC 服务（在 Tauri 异步运行时上跑 axum）。
///
/// 同步阶段仅用 `std::net` 绑定端口并取得 `base_url`；
/// `tokio::net::TcpListener::from_std` / `axum::serve` 必须在
/// `tauri::async_runtime` 内执行，否则 setup 同步上下文会 Panic
/// （there is no reactor running）。
pub fn start_local_ipc(
    app: AppHandle,
    queue: Arc<DbWriteQueue>,
) -> Result<LocalIpcServer, AppError> {
    // 绑定 127.0.0.1 随机端口（仅本机可访问，避免多开环境暴露到局域网）
    let std_listener = std::net::TcpListener::bind(("127.0.0.1", 0)).map_err(|error| {
        AppError::State(format!("failed to bind local ipc listener: {error}"))
    })?;
    std_listener.set_nonblocking(true).map_err(|error| {
        AppError::State(format!("failed to set listener nonblocking: {error}"))
    })?;
    let addr: SocketAddr = std_listener.local_addr().map_err(|error| {
        AppError::State(format!("failed to read local ipc addr: {error}"))
    })?;

    let state = ReportState {
        app: app.clone(),
        queue,
    };

    let router = Router::new()
        .route("/health", get(handle_health))
        .route("/report", post(handle_report))
        .with_state(state);

    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();
    let (stopped_tx, stopped_rx) = mpsc::channel::<()>();

    // 关键：from_std / serve 必须在 Tokio 1.x runtime 内，禁止在 setup 同步路径直接调用
    tauri::async_runtime::spawn(async move {
        let listener = match tokio::net::TcpListener::from_std(std_listener) {
            Ok(listener) => listener,
            Err(error) => {
                log_error!("CloakForge: local ipc tokio listener convert failed: {error}");
                let _ = stopped_tx.send(());
                return;
            }
        };

        let server = axum::serve(listener, router).with_graceful_shutdown(async move {
            let _ = shutdown_rx.await;
        });
        // 优雅停机：等待在途请求处理完毕后退出
        if let Err(error) = server.await {
            log_error!("CloakForge: local ipc server exited with error: {error}");
        }
        let _ = stopped_tx.send(());
    });

    Ok(LocalIpcServer {
        base_url: format!("http://{addr}"),
        shutdown_tx: Mutex::new(Some(shutdown_tx)),
        stopped_rx: Mutex::new(Some(stopped_rx)),
    })
}

async fn handle_health() -> StatusCode {
    StatusCode::OK
}

async fn handle_report(State(state): State<ReportState>, body: String) -> impl IntoResponse {
    let value: Value = match serde_json::from_str(&body) {
        Ok(value) => value,
        Err(error) => {
            return (StatusCode::BAD_REQUEST, format!("invalid json: {error}")).into_response();
        }
    };

    let report_type = value
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();
    let profile_id = value
        .get("profileId")
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_owned();

    match report_type.as_str() {
        "agent_trajectory" => {
            let domain = field_str(&value, "domain").unwrap_or_default();
            let title = field_str(&value, "title").unwrap_or_else(|| "未命名轨迹".to_owned());
            let goal = field_str(&value, "goal").unwrap_or_default();
            let start_url = field_str(&value, "startUrl").unwrap_or_default();
            let actions = value
                .get("actions")
                .cloned()
                .unwrap_or(Value::Array(vec![]));
            let actions_json = actions.to_string();

            // 走单写队列，并同步等待落库 id（对齐旧 stdout 路径的行为）
            let (reply_tx, reply_rx) = tokio::sync::oneshot::channel::<Result<i64, String>>();
            let enqueue_result = state.queue.enqueue(DbWriteCommand::SaveAgentTrajectory {
                domain: domain.clone(),
                title: title.clone(),
                goal: goal.clone(),
                start_url: start_url.clone(),
                actions: actions_json,
                reply: Some(reply_tx),
            });

            let saved_id = match enqueue_result {
                Ok(()) => match reply_rx.await {
                    Ok(Ok(id)) => Some(id),
                    Ok(Err(error)) => {
                        log_error!("CloakForge: ipc save agent trajectory failed: {error}");
                        None
                    }
                    Err(_) => None,
                },
                Err(error) => {
                    log_error!("CloakForge: ipc enqueue trajectory failed: {error}");
                    None
                }
            };

            // 向前端推送轨迹已保存事件（对齐旧 stdout 路径行为）
            let _ = state.app.emit(
                AGENT_TRAJECTORY_EVENT,
                json!({
                    "profileId": profile_id,
                    "id": saved_id,
                    "domain": domain,
                    "title": title,
                    "goal": goal,
                    "startUrl": start_url,
                    "actions": actions,
                }),
            );

            StatusCode::OK.into_response()
        }
        "agent_control_memory" => {
            let domain = field_str(&value, "domain").unwrap_or_default();
            let intent = field_str(&value, "intent").unwrap_or_default();
            let intent_key = field_str(&value, "intentKey").unwrap_or_default();
            let kind = field_str(&value, "kind").unwrap_or_else(|| "click".to_owned());
            let selector = field_str(&value, "selector").unwrap_or_default();
            let text_hint = field_str(&value, "textHint").unwrap_or_default();
            let x_percent = value.get("xPercent").and_then(Value::as_f64);
            let y_percent = value.get("yPercent").and_then(Value::as_f64);
            let hit_count = value.get("hitCount").and_then(Value::as_i64);

            if let Err(error) = state.queue.enqueue(DbWriteCommand::UpsertAgentControlMemory {
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
                log_error!("CloakForge: ipc enqueue control memory failed: {error}");
            }
            StatusCode::OK.into_response()
        }
        "persona_data" => {
            // Milestone 3：人设落盘 — Node 上报核心人设，Rust 单写合并写入 profiles.persona_data
            let profile_id_num = value
                .get("profileId")
                .and_then(|entry| {
                    entry
                        .as_i64()
                        .or_else(|| entry.as_str().and_then(|s| s.trim().parse::<i64>().ok()))
                })
                .unwrap_or_else(|| {
                    profile_id
                        .trim()
                        .parse::<i64>()
                        .unwrap_or(0)
                });
            if profile_id_num <= 0 {
                return (
                    StatusCode::BAD_REQUEST,
                    "persona_data requires valid profileId".to_owned(),
                )
                    .into_response();
            }

            let persona_json = value
                .get("persona")
                .cloned()
                .or_else(|| value.get("personaData").cloned())
                .or_else(|| value.get("data").cloned())
                .map(|v| {
                    if v.is_string() {
                        v.as_str().unwrap_or("{}").to_owned()
                    } else {
                        v.to_string()
                    }
                })
                .unwrap_or_else(|| "{}".to_owned());

            let (reply_tx, reply_rx) = tokio::sync::oneshot::channel::<Result<(), String>>();
            let enqueue_result = state.queue.enqueue(DbWriteCommand::SavePersonaData {
                profile_id: profile_id_num,
                persona_json,
                reply: Some(reply_tx),
            });

            match enqueue_result {
                Ok(()) => match reply_rx.await {
                    Ok(Ok(())) => {
                        let _ = state.app.emit(
                            "persona-data-saved",
                            json!({
                                "profileId": profile_id_num.to_string(),
                                "ok": true,
                            }),
                        );
                        StatusCode::OK.into_response()
                    }
                    Ok(Err(error)) => {
                        log_error!("CloakForge: save persona_data failed: {error}");
                        (StatusCode::INTERNAL_SERVER_ERROR, error).into_response()
                    }
                    Err(_) => (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        "persona_data reply channel closed".to_owned(),
                    )
                        .into_response(),
                },
                Err(error) => {
                    log_error!("CloakForge: ipc enqueue persona_data failed: {error}");
                    (StatusCode::SERVICE_UNAVAILABLE, error.to_string()).into_response()
                }
            }
        }
        "agent_task_blocked" => {
            // Milestone 4：Pause 上报 → 立即推前端 Intervention Center
            let request_id = field_str(&value, "requestId").unwrap_or_default();
            let url = field_str(&value, "url").unwrap_or_default();
            let reason = field_str(&value, "reason").unwrap_or_else(|| "需要人工接管".to_owned());
            let paused_at = field_str(&value, "pausedAt").unwrap_or_default();
            let payload = json!({
                "profileId": profile_id,
                "requestId": request_id,
                "url": url,
                "reason": reason,
                "pausedAt": paused_at,
            });
            let _ = state.app.emit(AGENT_TASK_BLOCKED_EVENT, payload.clone());
            // 兼容旧抽屉监听
            let _ = state.app.emit(AGENT_HANDOVER_EVENT, payload);
            StatusCode::OK.into_response()
        }
        other => {
            log_warn!("CloakForge: unknown ipc report type: {other}");
            (
                StatusCode::BAD_REQUEST,
                format!("unknown report type: {other}"),
            )
                .into_response()
        }
    }
}

fn field_str(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(|entry| {
        entry
            .as_str()
            .map(str::to_owned)
            .or_else(|| entry.as_i64().map(|n| n.to_string()))
            .or_else(|| entry.as_u64().map(|n| n.to_string()))
    })
}
