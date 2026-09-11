use rusqlite::Error as SqliteError;
use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Error, Serialize)]
#[serde(tag = "kind", content = "message")]
pub enum AppError {
    #[error("database error: {0}")]
    Database(String),
    #[error("validation error: {0}")]
    Validation(String),
    #[error("record not found: {0}")]
    NotFound(String),
    #[error("filesystem error: {0}")]
    Filesystem(String),
    #[error("serialization error: {0}")]
    Serialization(String),
    #[error("application state error: {0}")]
    State(String),
    #[error("profile {0} browser is already running")]
    AlreadyRunning(String),
    #[error("profile {0} browser is not running")]
    NotRunning(String),
    #[error("browser launcher error: {0}")]
    Launcher(String),
    #[error("no available cdp ports in range {start}-{end}")]
    CdpPortsExhausted { start: u16, end: u16 },
    #[error("fraud check error: {0}")]
    FraudCheck(String),
    #[error("sidecar error: {0}")]
    Sidecar(String),
    #[error("LLM error: {0}")]
    Llm(String),
}

impl From<SqliteError> for AppError {
    fn from(error: SqliteError) -> Self {
        Self::Database(error.to_string())
    }
}

impl From<std::io::Error> for AppError {
    fn from(error: std::io::Error) -> Self {
        Self::Filesystem(error.to_string())
    }
}

impl From<serde_json::Error> for AppError {
    fn from(error: serde_json::Error) -> Self {
        Self::Serialization(error.to_string())
    }
}
