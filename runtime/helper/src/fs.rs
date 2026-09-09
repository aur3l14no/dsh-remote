use crate::{
    cancel::Cancel,
    error::{invalid, number, string, Error, Result},
    output::Output,
    wire::CHUNK,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, Metadata, OpenOptions},
    io::{Seek, SeekFrom, Write},
    os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Component, Path, PathBuf},
    sync::Arc,
};
use tokio::sync::Mutex;

pub fn absolute(s: &str) -> Result<PathBuf> {
    if s.contains('\0') || !Path::new(s).is_absolute() {
        return Err(invalid("path must be absolute and NUL-free"));
    }
    Ok(PathBuf::from(s))
}
pub fn utf8(path: &Path) -> Result<&str> {
    path.to_str()
        .ok_or_else(|| Error::new("UNSUPPORTED_PATH", "non-UTF-8 path"))
}
pub fn resolve(path: &Path) -> Result<PathBuf> {
    // Resolve one component at a time: lexical '..' must not erase a symlink.
    let mut out = PathBuf::from("/");
    let mut remaining: std::collections::VecDeque<_> = path
        .components()
        .map(|x| x.as_os_str().to_owned())
        .collect();
    let mut links = 0;
    while let Some(c) = remaining.pop_front() {
        if c == "/" || c == "." {
            continue;
        }
        if c == ".." {
            out.pop();
            continue;
        }
        out.push(&c);
        match fs::symlink_metadata(&out) {
            Ok(m) if m.file_type().is_symlink() => {
                links += 1;
                if links > 40 {
                    return Err(Error::new("IO_ERROR", "symlink resolution loop"));
                }
                let target = fs::read_link(&out)?;
                out.pop();
                if target.is_absolute() {
                    out = PathBuf::from("/");
                }
                let parts: Vec<_> = target
                    .components()
                    .filter(|c| !matches!(c, Component::RootDir))
                    .map(|c| c.as_os_str().to_owned())
                    .collect();
                for part in parts.into_iter().rev() {
                    remaining.push_front(part);
                }
            }
            Ok(m) if !remaining.is_empty() && !m.is_dir() => {
                return Err(Error::new(
                    "NOT_DIRECTORY",
                    "intermediate path is not a directory",
                ))
            }
            Ok(_) => (),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
            Err(e) => return Err(e.into()),
        }
    }
    utf8(&out)?;
    Ok(out)
}
pub fn version(m: &Metadata) -> String {
    let mut h = Sha256::new();
    for n in [
        m.dev(),
        m.ino(),
        m.mode() as u64,
        m.size(),
        m.mtime() as u64,
        m.mtime_nsec() as u64,
        m.ctime() as u64,
        m.ctime_nsec() as u64,
    ] {
        h.update(n.to_be_bytes());
    }
    format!("{:x}", h.finalize())
}
pub fn metadata(m: &Metadata) -> Value {
    json!({"kind":if m.is_file(){"file"}else if m.is_dir(){"directory"}else if m.file_type().is_symlink(){"symlink"}else{"other"},"size":m.len(),"mode":m.mode() & 0o7777,"version":version(m)})
}
pub fn stat(path: &Path, follow: bool) -> Result<Value> {
    match if follow {
        fs::metadata(path)
    } else {
        fs::symlink_metadata(path)
    } {
        Ok(m) => Ok(metadata(&m)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Value::Null),
        Err(e) => Err(e.into()),
    }
}
pub fn list(path: &Path, limit: usize) -> Result<Value> {
    let mut entries = Vec::new();
    for entry in fs::read_dir(path)? {
        if entries.len() >= limit {
            return Err(Error::new(
                "RESOURCE_LIMIT",
                "directory exceeds entry limit",
            ));
        }
        let entry = entry?;
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| Error::new("UNSUPPORTED_PATH", "non-UTF-8 directory entry"))?;
        let target = resolve(&entry.path())?;
        entries.push(json!({"name":name,"path":utf8(&target)?,"metadata":stat(&target,true)?}));
    }
    entries.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
    Ok(json!({"entries":entries}))
}
pub fn open_read(path: &Path, max: u64) -> Result<(File, Value)> {
    let f = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NONBLOCK | libc::O_CLOEXEC)
        .open(path)?;
    let m = f.metadata()?;
    if !m.is_file() {
        return Err(Error::new(
            "NOT_REGULAR_FILE",
            "read requires a regular file",
        ));
    }
    if m.len() > max {
        return Err(Error::new("TOO_LARGE", "file exceeds whole-content limit"));
    }
    Ok((f, metadata(&m)))
}
pub fn open_read_range(path: &Path, offset: u64) -> Result<(File, Value)> {
    let (mut file, metadata) = open_read(path, u64::MAX)?;
    file.seek(SeekFrom::Start(offset))?;
    Ok((file, metadata))
}
pub async fn read_file(
    file: File,
    max: u64,
    range: bool,
    output: Arc<Output>,
    cancel: Arc<Cancel>,
) {
    use tokio::io::AsyncReadExt;
    let mut file = tokio::fs::File::from_std(file);
    let mut total = 0u64;
    let mut bytes = vec![0; CHUNK];
    let result: Result<()> = async {
        loop {
            cancel.check()?;
            // Regular-file reads are bounded; no blocking special files enter here.
            let capacity = if range {
                (max - total).min(CHUNK as u64) as usize
            } else {
                CHUNK
            };
            if capacity == 0 {
                return Ok(());
            }
            let n = tokio::select! {
                _ = cancel.cancelled() => return cancel.check(),
                n = file.read(&mut bytes[..capacity]) => n?,
            };
            if n == 0 {
                return Ok(());
            }
            total += n as u64;
            if total > max {
                return Err(Error::new(
                    "TOO_LARGE",
                    "file grew beyond whole-content limit",
                ));
            }
            tokio::select! {
                _ = cancel.cancelled() => { cancel.check()?; }
                open = output.append(&bytes[..n]) => if !open { return Ok(()); }
            }
        }
    }
    .await;
    output.finish(result.err().map(|e| e.value())).await;
}

pub struct Upload {
    path: PathBuf,
    stage_dir: PathBuf,
    staged: PathBuf,
    pub state: Mutex<UploadState>,
    expectation: Value,
    limit: u64,
}
pub struct UploadState {
    file: Option<File>,
    bytes: u64,
    committed: bool,
}
impl Drop for Upload {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.staged);
        let _ = fs::remove_dir(&self.stage_dir);
    }
}
fn check_guard(path: &Path, expected: &Value) -> Result<Option<Metadata>> {
    let m = match fs::symlink_metadata(path) {
        Ok(m) => Some(m),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(e.into()),
    };
    if m.as_ref().is_some_and(|m| !m.is_file()) {
        return Err(Error::new(
            "NOT_REGULAR_FILE",
            "write requires a regular file or absent target",
        ));
    }
    match expected["kind"].as_str() {
        Some("any") => (),
        Some("absent") if m.is_none() => (),
        Some("absent") => return Err(Error::new("CREATE_CONFLICT", "target already exists")),
        Some("version")
            if m.as_ref()
                .is_some_and(|m| Some(version(m).as_str()) == expected["version"].as_str()) => {}
        Some("version") => {
            return Err(Error::new(
                "STALE_VERSION",
                "file changed since observation",
            ))
        }
        _ => return Err(invalid("expected must have kind any, absent, or version")),
    }
    Ok(m)
}
impl Upload {
    pub fn begin(p: &Value, nonce: &str) -> Result<Arc<Self>> {
        let path = resolve(&absolute(string(p, "path")?)?)?;
        let expected = p.get("expected").cloned().unwrap_or(json!({"kind":"any"}));
        check_guard(&path, &expected)?;
        let limit = number(p, "maxBytes", 16 * 1024 * 1024, 64 * 1024 * 1024)?;
        let parent = path
            .parent()
            .ok_or_else(|| invalid("cannot publish at filesystem root"))?;
        fs::create_dir_all(parent)?;
        let stage_dir = parent.join(format!(".dsh-stage-{nonce}"));
        std::os::unix::fs::DirBuilderExt::mode(&mut fs::DirBuilder::new(), 0o700)
            .create(&stage_dir)?;
        let staged = stage_dir.join("content");
        let file = match OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&staged)
        {
            Ok(f) => f,
            Err(e) => {
                let _ = fs::remove_dir(&stage_dir);
                return Err(e.into());
            }
        };
        Ok(Arc::new(Self {
            path,
            stage_dir,
            staged,
            state: Mutex::new(UploadState {
                file: Some(file),
                bytes: 0,
                committed: false,
            }),
            expectation: expected,
            limit,
        }))
    }
    pub async fn abort(&self) {
        self.state.lock().await.file.take();
    }
    pub async fn write(&self, p: &Value, cancel: &Cancel) -> Result<Value> {
        let bytes = STANDARD
            .decode(string(p, "data")?)
            .map_err(|_| invalid("invalid Base64 data"))?;
        if bytes.len() > CHUNK {
            return Err(Error::new("RESOURCE_LIMIT", "upload chunk exceeds limit"));
        }
        let offset = number(p, "offset", 0, u64::MAX)?;
        let mut s = self.state.lock().await;
        cancel.check()?;
        if offset != s.bytes {
            return Err(invalid("upload offset must equal accepted byte count"));
        }
        if s.bytes + bytes.len() as u64 > self.limit {
            return Err(Error::new("TOO_LARGE", "upload exceeds reserved limit"));
        }
        let f = s
            .file
            .as_mut()
            .ok_or_else(|| Error::new("CLOSED", "upload is closed"))?;
        // On any partial write failure abort staging: no retry can publish a prefix.
        if let Err(e) = tokio::task::block_in_place(|| f.write_all(&bytes)) {
            s.file.take();
            return Err(e.into());
        }
        s.bytes += bytes.len() as u64;
        Ok(json!({"next":s.bytes}))
    }
    pub async fn commit(&self, cancel: &Cancel, lock: &Mutex<()>) -> Result<Value> {
        let _guard = lock.lock().await;
        let mut s = self.state.lock().await;
        tokio::task::block_in_place(|| {
            cancel.check()?;
            let f = s
                .file
                .as_mut()
                .ok_or_else(|| Error::new("CLOSED", "upload is closed"))?;
            if resolve(&self.path)? != self.path {
                return Err(Error::new("STALE_VERSION", "target resolution changed"));
            }
            let prior = check_guard(&self.path, &self.expectation)?;
            if let Some(m) = &prior {
                f.set_permissions(fs::Permissions::from_mode(m.mode() & 0o777))?;
            }
            f.sync_all()?;
            cancel.check()?;
            check_guard(&self.path, &self.expectation)?;
            if self.expectation["kind"] == "absent" {
                fs::hard_link(&self.staged, &self.path)?;
            } else {
                fs::rename(&self.staged, &self.path)?;
            }
            // Removing the staging hard link changes ctime. Observe the published
            // version only after that change, or a guarded create is immediately stale.
            let staging_removed =
                self.expectation["kind"] != "absent" || fs::remove_file(&self.staged).is_ok();
            // Once publication succeeds, preserve committed outcome even if metadata inspection fails.
            let after = if staging_removed {
                f.metadata().map(|m| metadata(&m)).ok()
            } else {
                None
            };
            s.committed = true;
            s.file.take();
            Ok(
                json!({"committed":true,"kind":if prior.is_some(){"update"}else{"create"},"metadata":after}),
            )
        })
    }
}
