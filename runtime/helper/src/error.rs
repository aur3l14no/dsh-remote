use serde_json::{json, Value};
use std::io;

#[derive(Debug)]
pub struct Error {
    pub code: &'static str,
    pub message: String,
    pub details: Value,
}
pub type Result<T> = std::result::Result<T, Error>;
impl Error {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            details: Value::Null,
        }
    }
    pub fn detail(mut self, details: Value) -> Self {
        self.details = details;
        self
    }
    pub fn value(&self) -> Value {
        json!({"code":self.code,"message":self.message,"details":self.details})
    }
}
impl From<io::Error> for Error {
    fn from(e: io::Error) -> Self {
        let code = match e.kind() {
            io::ErrorKind::NotFound => "NOT_FOUND",
            io::ErrorKind::PermissionDenied => "PERMISSION_DENIED",
            io::ErrorKind::AlreadyExists => "CREATE_CONFLICT",
            io::ErrorKind::NotADirectory => "NOT_DIRECTORY",
            io::ErrorKind::InvalidInput => "INVALID_ARGUMENT",
            _ => "IO_ERROR",
        };
        Self::new(code, e.to_string()).detail(json!({"errno":e.raw_os_error()}))
    }
}
impl From<serde_json::Error> for Error {
    fn from(e: serde_json::Error) -> Self {
        Self::new("INVALID_ARGUMENT", e.to_string())
    }
}
pub fn invalid(message: impl Into<String>) -> Error {
    Error::new("INVALID_ARGUMENT", message)
}
pub fn string<'a>(p: &'a Value, key: &str) -> Result<&'a str> {
    p.get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| invalid(format!("{key} must be a string")))
}
pub fn number(p: &Value, key: &str, default: u64, max: u64) -> Result<u64> {
    let n = match p.get(key) {
        None => default,
        Some(v) => v
            .as_u64()
            .ok_or_else(|| invalid(format!("{key} must be an unsigned integer")))?,
    };
    if n > max {
        return Err(invalid(format!("{key} exceeds {max}")));
    }
    Ok(n)
}
