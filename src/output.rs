use crate::error::{invalid, Error, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::{
    collections::VecDeque,
    fs::File,
    io::Write,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    },
};
use tokio::sync::{Mutex, Notify};

pub const MAX_RAW_BYTES: usize = 1024 * 1024;
pub const MAX_COLLECT_BYTES: usize = 32 * 1024 * 1024;
pub const MAX_RUNTIME_BYTES: usize = 64 * 1024 * 1024;

/// Reservations follow the actual buffers, including readers still shutting down.
#[derive(Default)]
pub struct Budget(AtomicUsize);

pub struct Output {
    pub id: String,
    pub visible: AtomicBool,
    pub raw: bool,
    pub cap: usize,
    pub state: Mutex<State>,
    pub changed: Notify,
    budget: Arc<Budget>,
}
pub struct State {
    bytes: VecDeque<u8>,
    start: u64,
    end: u64,
    pub eof: bool,
    pub failure: Option<Value>,
    spill: Option<(File, PathBuf, u64)>,
    spill_path: Option<PathBuf>,
    pub revision: u64,
}
impl Drop for Output {
    fn drop(&mut self) {
        self.budget.0.fetch_sub(self.cap, Ordering::SeqCst);
        let state = self.state.get_mut();
        if !state.eof {
            if let Some(path) = &state.spill_path {
                let _ = std::fs::remove_file(path);
            }
        }
    }
}
impl Output {
    pub fn new(
        id: String,
        raw: bool,
        cap: usize,
        spill: Option<(File, PathBuf, u64)>,
        budget: Arc<Budget>,
    ) -> Result<Arc<Self>> {
        budget
            .0
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |used| {
                used.checked_add(cap)
                    .filter(|total| *total <= MAX_RUNTIME_BYTES)
            })
            .map_err(|_| {
                if let Some((_, path, _)) = &spill {
                    let _ = std::fs::remove_file(path);
                }
                Error::new("RESOURCE_LIMIT", "runtime output memory reservation limit")
            })?;
        Ok(Arc::new(Self {
            id,
            visible: AtomicBool::new(false),
            raw,
            cap,
            state: Mutex::new(State {
                bytes: VecDeque::with_capacity(cap),
                start: 0,
                end: 0,
                eof: false,
                failure: None,
                spill_path: spill.as_ref().map(|x| x.1.clone()),
                spill,
                revision: 0,
            }),
            changed: Notify::new(),
            budget,
        }))
    }
    pub async fn append(&self, mut bytes: &[u8]) -> bool {
        while !bytes.is_empty() {
            let notified = self.changed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            let mut s = self.state.lock().await;
            if s.eof {
                return false;
            }
            let n = if self.raw {
                (self.cap - s.bytes.len()).min(bytes.len())
            } else {
                bytes.len()
            };
            if n == 0 {
                drop(s);
                notified.await;
                continue;
            }
            let part = &bytes[..n];
            let end = s.end + n as u64;
            if let Some((file, _, cap)) = s.spill.as_mut() {
                if end > *cap {
                    if let Some((_, path, _)) = s.spill.take() {
                        let _ = std::fs::remove_file(path);
                    }
                    s.spill_path = None;
                } else if let Err(e) = tokio::task::block_in_place(|| file.write_all(part)) {
                    s.failure = Some(Error::from(e).value());
                    if let Some((_, path, _)) = s.spill.take() {
                        let _ = std::fs::remove_file(path);
                    }
                    s.spill_path = None;
                }
            }
            s.end = end;
            if self.raw {
                s.bytes.extend(part);
            } else {
                // Trim before extending so the reserved allocation never grows past cap.
                let retained = &part[part.len().saturating_sub(self.cap)..];
                let excess = (s.bytes.len() + retained.len()).saturating_sub(self.cap);
                s.bytes.drain(..excess);
                s.bytes.extend(retained);
                s.start = end - s.bytes.len() as u64;
            }
            s.revision += 1;
            drop(s);
            self.changed.notify_waiters();
            bytes = &bytes[n..];
        }
        true
    }
    pub async fn finish(&self, failure: Option<Value>) {
        let mut s = self.state.lock().await;
        if s.eof {
            return;
        }
        s.eof = true;
        if failure.is_some() {
            s.failure = failure;
        }
        s.spill.take();
        s.revision += 1;
        drop(s);
        self.changed.notify_waiters();
    }
    pub async fn ack(&self, offset: u64) -> Result<Value> {
        if !self.raw {
            return Err(invalid("only raw streams use acknowledgements"));
        }
        let mut s = self.state.lock().await;
        if offset > s.end {
            return Err(invalid("acknowledgement beyond produced end"));
        }
        // Old acknowledgements are harmless during response retransmission.
        if offset > s.start {
            let n = (offset - s.start) as usize;
            s.bytes.drain(..n);
            s.start = offset;
        }
        let result = json!({"acknowledged":s.start});
        drop(s);
        self.changed.notify_waiters();
        Ok(result)
    }
    pub async fn snapshot(&self, offset: u64, max: usize) -> Result<Value> {
        let s = self.state.lock().await;
        if offset > s.end {
            return Err(invalid("offset beyond produced end"));
        }
        let start = offset.max(s.start);
        let bytes: Vec<u8> = s
            .bytes
            .iter()
            .skip((start - s.start) as usize)
            .take(max)
            .copied()
            .collect();
        let next = start + bytes.len() as u64;
        Ok(
            json!({"stream":self.id,"mode":if self.raw {"raw"} else {"collect"},"offset":start,"next":next,"produced":s.end,"retainedFrom":s.start,"gap":offset<s.start,"data":STANDARD.encode(bytes),"eof":s.eof,"error":s.failure,"spill":s.spill_path,"revision":s.revision}),
        )
    }
    pub async fn revision(&self) -> u64 {
        self.state.lock().await.revision
    }
    pub async fn eof(&self) -> bool {
        self.state.lock().await.eof
    }
}
