use crate::error::{Error, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

pub const MAX_FRAME: usize = 2 * 1024 * 1024;
pub const CHUNK: usize = 32 * 1024;
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub id: u64,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}
pub async fn read<R: AsyncRead + Unpin>(r: &mut R) -> Result<Value> {
    let n = r.read_u32().await? as usize;
    if n == 0 || n > MAX_FRAME {
        return Err(Error::new("FRAME_LIMIT", "invalid frame length"));
    }
    let mut bytes = vec![0; n];
    r.read_exact(&mut bytes).await?;
    Ok(serde_json::from_slice(&bytes)?)
}
pub async fn write<W: AsyncWrite + Unpin>(w: &mut W, v: &Value) -> Result<()> {
    let bytes = serde_json::to_vec(v)?;
    if bytes.len() > MAX_FRAME {
        return Err(Error::new("FRAME_LIMIT", "response exceeds frame limit"));
    }
    w.write_u32(bytes.len() as u32).await?;
    w.write_all(&bytes).await?;
    w.flush().await?;
    Ok(())
}
