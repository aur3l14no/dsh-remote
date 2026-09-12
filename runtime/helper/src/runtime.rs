use crate::{
    cancel::Cancel,
    error::{invalid, number, string, Error, Result},
    fs,
    output::{self, Budget, Output},
    process::{self, Process},
    unix,
    wire::{self, Request, CHUNK},
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap},
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
use tokio::{
    net::{UnixListener, UnixStream},
    sync::{mpsc, Mutex, Semaphore},
};

const CAPABILITIES: &[&str] = &[
    "fs.bytes",
    "fs.read-range",
    "fs.atomic-publish",
    "fs.sync",
    "process.pipe",
    "process.pty",
    "process.signals",
    "process.exit-signal-name",
    "output.ack",
    "output.collect",
    "output.spill",
    "runtime.resume",
    "request.dedup",
];
const MAX_PROCESSES: usize = 16;
const MAX_STREAMS: usize = 64;
const MAX_UPLOADS: usize = 16;
const MAX_REQUESTS: usize = 32;
struct Record {
    fingerprint: String,
    cancel: Arc<Cancel>,
    response: Option<Value>,
    size: usize,
}
type Streams = HashMap<String, (Arc<Output>, Option<Arc<Cancel>>)>;
struct Session {
    initialized: bool,
    active: bool,
    detached: Instant,
    world: Option<String>,
    high_water: u64,
    requests: BTreeMap<u64, Record>,
    cache_bytes: usize,
    input_order: HashMap<String, Arc<Cancel>>,
    sender: Option<mpsc::Sender<Value>>,
}
pub struct Runtime {
    capabilities: Vec<&'static str>,
    id: String,
    token: String,
    dir: PathBuf,
    grace: Duration,
    lease: Duration,
    session: Mutex<Session>,
    processes: Mutex<HashMap<String, Arc<Process>>>,
    streams: Mutex<Streams>,
    uploads: Mutex<HashMap<String, Arc<fs::Upload>>>,
    allocation: Mutex<()>,
    publication: Mutex<()>,
    slots: Arc<Semaphore>,
    sequence: AtomicU64,
    spill_reserved: AtomicU64,
    output_budget: Arc<Budget>,
    stopping: AtomicBool,
    exit_ready: AtomicBool,
}
impl Runtime {
    fn resource(&self, kind: &str) -> String {
        format!(
            "{}.{kind}{}",
            self.id,
            self.sequence.fetch_add(1, Ordering::Relaxed)
        )
    }
    pub async fn serve(dir: PathBuf, grace: Duration, lease: Duration) -> Result<()> {
        fs::absolute(fs::utf8(&dir)?)?;
        // A fresh, private directory prevents stale sockets and symlink replacement.
        std::os::unix::fs::DirBuilderExt::mode(&mut std::fs::DirBuilder::new(), 0o700)
            .create(&dir)?;
        let listener = UnixListener::bind(dir.join("socket"))?;
        std::fs::set_permissions(dir.join("socket"), std::fs::Permissions::from_mode(0o600))?;
        #[cfg(target_os = "linux")]
        if unsafe { libc::prctl(libc::PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) } != 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        let mut capabilities = CAPABILITIES.to_vec();
        #[cfg(target_os = "linux")]
        capabilities.push("fs.rooted-publish");
        if unix::pty(24, 80).is_err() {
            capabilities.retain(|cap| *cap != "process.pty");
        }
        let rt = Arc::new(Self {
            capabilities,
            id: unix::random_id()?,
            token: unix::random_id()?,
            dir: dir.clone(),
            grace,
            lease,
            session: Mutex::new(Session {
                initialized: false,
                active: false,
                detached: Instant::now(),
                world: None,
                high_water: 0,
                requests: BTreeMap::new(),
                cache_bytes: 0,
                input_order: HashMap::new(),
                sender: None,
            }),
            processes: Mutex::new(HashMap::new()),
            streams: Mutex::new(HashMap::new()),
            uploads: Mutex::new(HashMap::new()),
            allocation: Mutex::new(()),
            publication: Mutex::new(()),
            slots: Arc::new(Semaphore::new(MAX_REQUESTS)),
            sequence: AtomicU64::new(1),
            spill_reserved: AtomicU64::new(0),
            output_budget: Arc::new(Budget::default()),
            stopping: AtomicBool::new(false),
            exit_ready: AtomicBool::new(false),
        });
        let connections = Arc::new(Semaphore::new(4));
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
        let mut interrupt =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())?;
        loop {
            tokio::select! {
                conn=listener.accept()=> {
                    let (stream,_)=conn?;
                    if let Ok(permit)=connections.clone().try_acquire_owned() {
                        let cloned=rt.clone();tokio::spawn(async move {let _permit=permit;let _=cloned.connection(stream).await;});
                    }
                }
                _=tokio::time::sleep(Duration::from_millis(50))=> {
                    let s=rt.session.lock().await;
                    if rt.exit_ready.load(Ordering::SeqCst)||(!s.active&&s.detached.elapsed()>=grace){break;}
                }
                _=term.recv()=>break,
                _=interrupt.recv()=>break,
            }
        }
        rt.stopping.store(true, Ordering::SeqCst);
        let complete = rt.cleanup(Duration::from_secs(35)).await;
        // Runtime directory contains only our socket/spills; uploads own their separate staging paths.
        rt.uploads.lock().await.clear();
        drop(listener);
        let _ = std::fs::remove_file(dir.join("socket"));
        for entry in std::fs::read_dir(&dir)? {
            let entry = entry?;
            if entry.file_type()?.is_file() {
                let _ = std::fs::remove_file(entry.path());
            }
        }
        let _ = std::fs::remove_dir(&dir);
        if !complete {
            return Err(Error::new(
                "CLEANUP_INCOMPLETE",
                "managed process cleanup deadline expired",
            ));
        }
        Ok(())
    }
    async fn hello(&self, p: &Value) -> Result<Value> {
        if p["api"] != 2 {
            return Err(Error::new(
                "INCOMPATIBLE_VERSION",
                "requires API revision 2",
            ));
        }
        if let Some(required) = p.get("required") {
            for cap in required
                .as_array()
                .ok_or_else(|| invalid("required must be an array"))?
            {
                let cap = cap
                    .as_str()
                    .ok_or_else(|| invalid("capabilities must be strings"))?;
                if !self.capabilities.contains(&cap) {
                    return Err(Error::new(
                        "UNSUPPORTED",
                        format!("required capability unavailable: {cap}"),
                    ));
                }
            }
        }
        let mut s = self.session.lock().await;
        if self.stopping.load(Ordering::SeqCst) || (!s.active && s.detached.elapsed() >= self.grace)
        {
            return Err(Error::new(
                "SESSION_EXPIRED",
                "runtime grace period expired or runtime is closing",
            ));
        }
        if s.active {
            return Err(Error::new(
                "SESSION_BUSY",
                "runtime already has a controller",
            ));
        }
        if s.initialized {
            if p["runtime"] != self.id || p["token"] != self.token {
                return Err(Error::new(
                    "SESSION_MISMATCH",
                    "live runtime requires its resume credentials",
                ));
            }
            if let Some(world) = p.get("world") {
                if world.as_str() != s.world.as_deref() {
                    return Err(Error::new(
                        "SESSION_MISMATCH",
                        "World cannot change on resume",
                    ));
                }
            }
        } else {
            if p.get("runtime").is_some() || p.get("token").is_some() {
                return Err(Error::new(
                    "SESSION_MISMATCH",
                    "this is a fresh runtime; old commands cannot be resumed",
                ));
            }
            s.world = Some(string(p, "world")?.into());
            s.initialized = true;
        }
        s.active = true;
        Ok(
            json!({"api":2,"build":env!("CARGO_PKG_VERSION"),"runtime":self.id,"token":self.token,"world":s.world,"platform":std::env::consts::OS,"arch":std::env::consts::ARCH,"capabilities":self.capabilities,"inputWaiting":"unknown","cleanupScope":"observed-session-members","graceMs":self.grace.as_millis(),"leaseMs":self.lease.as_millis(),"limits":{"frameBytes":wire::MAX_FRAME,"chunkBytes":CHUNK,"processes":MAX_PROCESSES,"streams":MAX_STREAMS,"uploads":MAX_UPLOADS,"requests":MAX_REQUESTS,"outputBytesPerStream":output::MAX_COLLECT_BYTES,"rawOutputBytesPerStream":output::MAX_RAW_BYTES,"outputBytesPerRuntime":output::MAX_RUNTIME_BYTES,"maxGraceMs":30000,"spillBytesPerStream":16*1024*1024,"spillBytesPerRuntime":64*1024*1024,"uploadBytes":64*1024*1024,"dedupResponses":256,"dedupBytes":8*1024*1024},"requestHighWater":s.high_water}),
        )
    }
    async fn connection(self: Arc<Self>, mut stream: UnixStream) -> Result<()> {
        let first = tokio::time::timeout(Duration::from_secs(5), wire::read(&mut stream))
            .await
            .map_err(|_| Error::new("TIMEOUT", "hello timeout"))??;
        let req: Request = serde_json::from_value(first)?;
        let result = if req.id == 0 && req.method == "runtime.hello" {
            self.hello(&req.params).await
        } else {
            Err(invalid("first frame must be runtime.hello with id 0"))
        };
        let success = result.is_ok();
        let greeting = response(req.id, result);
        if let Err(e) =
            tokio::time::timeout(Duration::from_secs(2), wire::write(&mut stream, &greeting))
                .await
                .unwrap_or_else(|_| Err(Error::new("TIMEOUT", "hello write timeout")))
        {
            if success {
                let mut s = self.session.lock().await;
                s.active = false;
                s.detached = Instant::now();
            }
            return Err(e);
        }
        if !success {
            return Ok(());
        }
        let (mut reader, mut writer) = stream.into_split();
        let (tx, mut rx) = mpsc::channel::<Value>(32);
        self.session.lock().await.sender = Some(tx.clone());
        let outgoing = self.clone();
        let mut write_task = tokio::spawn(async move {
            let mut offsets: HashMap<String, u64> = HashMap::new();
            let mut revisions: HashMap<String, u64> = HashMap::new();
            let mut interval = tokio::time::interval(Duration::from_millis(20));
            loop {
                tokio::select! {biased;
                    Some(response)=rx.recv()=>{send(&mut writer,&response).await?;outgoing.publish_result(&response).await;},
                    _=interval.tick()=> {
                        let processes:Vec<_>=outgoing.processes.lock().await.values().cloned().collect();
                        for process in processes {
                            if !process.state.lock().await.published{continue;}
                            let status=process.status().await;
                            let revision=status["revision"].as_u64().unwrap_or(0);
                            if revisions.get(&process.id)!=Some(&revision){send(&mut writer,&json!({"event":"process.state","value":status})).await?;revisions.insert(process.id.clone(),revision);}
                        }
                        let streams:Vec<_>=outgoing.streams.lock().await.values().map(|x|x.0.clone()).collect();
                        offsets.retain(|id,_|streams.iter().any(|o| &o.id==id));
                        let process_ids:Vec<_>=outgoing.processes.lock().await.keys().cloned().collect();
                        revisions.retain(|id,_|streams.iter().any(|o| &o.id==id)||process_ids.contains(id));
                        for output in streams {
                            if !output.visible.load(Ordering::SeqCst){continue;}
                            let revision=output.revision().await;
                            if revisions.get(&output.id)==Some(&revision){continue;}
                            let offset=if let Some(offset)=offsets.get(&output.id){*offset}else if output.raw{output.snapshot(0,0).await?["retainedFrom"].as_u64().unwrap_or(0)}else{0};
                            let value=output.snapshot(offset,CHUNK).await?;
                            let next=value["next"].as_u64().unwrap_or(offset);
                            send(&mut writer,&json!({"event":"stream.data","value":value})).await?;
                            offsets.insert(output.id.clone(),next);
                            // Drain every mode in bounded frames even after the producer has stopped.
                            if next==value["produced"].as_u64().unwrap_or(next){revisions.insert(output.id.clone(),revision);}
                        }
                    }
                }
            }
            #[allow(unreachable_code)]
            Ok::<(), Error>(())
        });
        loop {
            tokio::select! {
                _=&mut write_task=>break,
                frame=tokio::time::timeout(self.lease,wire::read(&mut reader))=> {
                    let Ok(Ok(frame))=frame else {break;};
                    let req=match serde_json::from_value::<Request>(frame){Ok(r)=>r,Err(_)=>break};
                    if let Err(e)=self.clone().admit(req.clone()).await {if tx.send(response(req.id,Err(e))).await.is_err(){break;}}
                }
            }
        }
        write_task.abort();
        let mut s = self.session.lock().await;
        s.sender = None;
        s.active = false;
        s.detached = Instant::now();
        Ok(())
    }
    async fn publish_result(&self, response: &Value) {
        if let Some(id) = response["result"]["process"].as_str() {
            let process = self.processes.lock().await.get(id).cloned();
            if let Some(p) = process {
                p.publish().await;
                for out in &p.outputs {
                    out.visible.store(true, Ordering::SeqCst);
                }
            }
        }
        if let Some(id) = response["result"]["stream"].as_str() {
            if let Some((out, _)) = self.streams.lock().await.get(id) {
                out.visible.store(true, Ordering::SeqCst);
            }
        }
    }
    async fn admit(self: Arc<Self>, req: Request) -> Result<()> {
        if req.id == 0 || req.id > 9_007_199_254_740_991 {
            return Err(invalid("request id must be 1..2^53-1"));
        }
        if self.stopping.load(Ordering::SeqCst) {
            return Err(Error::new("CLOSED", "runtime is shutting down"));
        }
        let fingerprint = format!("{:x}", Sha256::digest(serde_json::to_vec(&req)?));
        let mut s = self.session.lock().await;
        if let Some(record) = s.requests.get(&req.id) {
            if record.fingerprint != fingerprint {
                return Err(Error::new(
                    "REQUEST_CONFLICT",
                    "request id reused for different content",
                ));
            }
            if let Some(response) = record.response.clone() {
                let sender = s.sender.clone();
                drop(s);
                if let Some(sender) = sender {
                    let _ = sender.send(response).await;
                }
            }
            return Ok(());
        }
        if req.id <= s.high_water {
            return Err(Error::new(
                "REQUEST_EXPIRED",
                "request response no longer retained; request will not execute again",
            ));
        }
        // Reserve separate admission for controls so output/input pressure cannot exhaust them.
        let permit = if matches!(
            req.method.as_str(),
            "runtime.cancel"
                | "runtime.ping"
                | "runtime.shutdown"
                | "stream.ack"
                | "process.terminate"
                | "process.status"
        ) {
            None
        } else {
            Some(
                self.slots
                    .clone()
                    .try_acquire_owned()
                    .map_err(|_| Error::new("RESOURCE_LIMIT", "concurrent request limit"))?,
            )
        };
        if s.requests.values().filter(|r| r.response.is_none()).count() >= MAX_REQUESTS + 8 {
            return Err(Error::new("RESOURCE_LIMIT", "control request limit"));
        }
        let order_key = match req.method.as_str() {
            "process.write" | "process.closeStdin" => req.params["process"]
                .as_str()
                .map(|id| format!("input:{id}")),
            "fs.writeChunk" | "fs.commitWrite" | "fs.abortWrite" => req.params["upload"]
                .as_str()
                .map(|id| format!("upload:{id}")),
            _ => None,
        };
        let completed = Arc::new(Cancel::default());
        let preceding = order_key
            .as_ref()
            .and_then(|key| s.input_order.insert(key.clone(), completed.clone()));
        s.high_water = req.id;
        let cancel = Arc::new(Cancel::default());
        s.requests.insert(
            req.id,
            Record {
                fingerprint,
                cancel: cancel.clone(),
                response: None,
                size: 0,
            },
        );
        drop(s);
        tokio::spawn(async move {
            let _permit = permit;
            if let Some(preceding) = preceding {
                preceding.cancelled().await;
            }
            let result = self.dispatch(&req.method, &req.params, &cancel).await;
            completed.cancel();
            let mut response = response(req.id, result);
            if serde_json::to_vec(&response).is_ok_and(|v| v.len() > wire::MAX_FRAME) {
                response = self::response(
                    req.id,
                    Err(Error::new("RESOURCE_LIMIT", "result exceeds frame limit")),
                );
            }
            let size = serde_json::to_vec(&response).map(|b| b.len()).unwrap_or(0);
            let mut s = self.session.lock().await;
            if let Some(key) = order_key {
                if s.input_order
                    .get(&key)
                    .is_some_and(|tail| Arc::ptr_eq(tail, &completed))
                {
                    s.input_order.remove(&key);
                }
            }
            if let Some(record) = s.requests.get_mut(&req.id) {
                record.response = Some(response.clone());
                record.size = size;
                s.cache_bytes += size;
            }
            while s.requests.len() > 256 || s.cache_bytes > 8 * 1024 * 1024 {
                let Some(id) = s
                    .requests
                    .iter()
                    .find(|(_, r)| r.response.is_some())
                    .map(|(id, _)| *id)
                else {
                    break;
                };
                if let Some(record) = s.requests.remove(&id) {
                    s.cache_bytes -= record.size;
                }
            }
            let sender = s.sender.clone();
            drop(s);
            if let Some(sender) = sender {
                let _ = sender.send(response).await;
            }
            if req.method == "runtime.shutdown" && self.stopping.load(Ordering::SeqCst) {
                tokio::time::sleep(Duration::from_millis(250)).await;
                self.exit_ready.store(true, Ordering::SeqCst);
            }
        });
        Ok(())
    }
    async fn process(&self, p: &Value) -> Result<Arc<Process>> {
        self.processes
            .lock()
            .await
            .get(string(p, "process")?)
            .cloned()
            .ok_or_else(|| Error::new("UNKNOWN_RESOURCE", "unknown runtime process"))
    }
    async fn stream(&self, p: &Value) -> Result<Arc<Output>> {
        self.streams
            .lock()
            .await
            .get(string(p, "stream")?)
            .map(|x| x.0.clone())
            .ok_or_else(|| Error::new("UNKNOWN_RESOURCE", "unknown runtime stream"))
    }
    async fn upload(&self, p: &Value) -> Result<Arc<fs::Upload>> {
        self.uploads
            .lock()
            .await
            .get(string(p, "upload")?)
            .cloned()
            .ok_or_else(|| Error::new("UNKNOWN_RESOURCE", "unknown upload"))
    }
    async fn dispatch(&self, method: &str, p: &Value, cancel: &Arc<Cancel>) -> Result<Value> {
        cancel.check()?;
        match method {
            "runtime.ping" => Ok(json!({"runtime":self.id,"value":p.get("value")})),
            "runtime.cancel" => {
                let id = number(p, "request", 0, 9_007_199_254_740_991)?;
                let s = self.session.lock().await;
                Ok(match s.requests.get(&id) {
                    Some(r) if r.response.is_none() => {
                        r.cancel.cancel();
                        json!({"status":"accepted","cleanupComplete":false})
                    }
                    Some(_) => json!({"status":"settled"}),
                    None => json!({"status":"unknown"}),
                })
            }
            "runtime.shutdown" => {
                let deadline = Duration::from_millis(number(p, "deadlineMs", 5000, 35_000)?);
                self.stopping.store(true, Ordering::SeqCst);
                let complete = self.cleanup(deadline).await;
                if complete {
                    Ok(json!({"cleanupComplete":true,"scope":"observed-session-members"}))
                } else {
                    Err(Error::new("CLEANUP_INCOMPLETE", "cleanup deadline expired"))
                }
            }
            "fs.resolve" => {
                let path = string(p, "path")?;
                if path.contains('\0') {
                    return Err(invalid("NUL path"));
                }
                let cwd = fs::absolute(string(p, "cwd")?)?;
                let resolved = tokio::task::block_in_place(|| fs::resolve(&cwd.join(path)))?;
                Ok(json!({"path":fs::utf8(&resolved)?}))
            }
            "fs.stat" => tokio::task::block_in_place(|| {
                fs::stat(
                    &fs::absolute(string(p, "path")?)?,
                    p.get("follow").and_then(Value::as_bool).unwrap_or(true),
                )
            }),
            "fs.sync" => tokio::task::block_in_place(|| {
                cancel.check()?;
                fs::sync(&fs::absolute(string(p, "path")?)?)?;
                Ok(json!({"synced":true}))
            }),
            "fs.list" => tokio::task::block_in_place(|| {
                fs::list(
                    &fs::absolute(string(p, "path")?)?,
                    number(p, "maxEntries", 1000, 1000)? as usize,
                )
            }),
            "fs.read" | "fs.readRange" => {
                let _guard = self.allocation.lock().await;
                cancel.check()?;
                if self.streams.lock().await.len() >= MAX_STREAMS {
                    return Err(Error::new("RESOURCE_LIMIT", "stream limit"));
                }
                let range = method == "fs.readRange";
                let max = if range {
                    number(p, "length", 0, 64 * 1024 * 1024)?
                } else {
                    p["maxBytes"]
                        .as_u64()
                        .ok_or_else(|| invalid("read requires maxBytes"))?
                };
                let (file, metadata) = tokio::task::block_in_place(|| {
                    let path = fs::absolute(string(p, "path")?)?;
                    if range {
                        fs::open_read_range(&path, number(p, "offset", 0, 9_007_199_254_740_991)?)
                    } else {
                        fs::open_read(&path, max)
                    }
                })?;
                let id = self.resource("f");
                let output = Output::new(
                    id.clone(),
                    true,
                    64 * 1024,
                    None,
                    self.output_budget.clone(),
                )?;
                let stop = Arc::new(Cancel::default());
                self.streams
                    .lock()
                    .await
                    .insert(id.clone(), (output.clone(), Some(stop.clone())));
                tokio::spawn(fs::read_file(file, max, range, output, stop));
                Ok(json!({"stream":id,"metadata":metadata}))
            }
            "fs.beginWrite" => {
                let _guard = self.allocation.lock().await;
                cancel.check()?;
                if self.uploads.lock().await.len() >= MAX_UPLOADS {
                    return Err(Error::new("RESOURCE_LIMIT", "upload limit"));
                }
                let id = self.resource("u");
                let upload =
                    tokio::task::block_in_place(|| fs::Upload::begin(p, &unix::random_id()?))?;
                self.uploads.lock().await.insert(id.clone(), upload);
                Ok(json!({"upload":id}))
            }
            "fs.writeChunk" => self.upload(p).await?.write(p, cancel).await,
            "fs.commitWrite" => {
                let upload = self.upload(p).await?;
                let result = upload.commit(cancel, &self.publication).await;
                if result.is_ok() {
                    self.uploads.lock().await.remove(string(p, "upload")?);
                }
                result
            }
            "fs.abortWrite" => {
                let upload = self.upload(p).await?;
                upload.abort().await;
                self.uploads.lock().await.remove(string(p, "upload")?);
                Ok(json!({"aborted":true}))
            }
            "process.resolveExecutable" => {
                let cwd = fs::absolute(string(p, "cwd")?)?;
                Ok(
                    json!({"path":fs::utf8(&process::executable(string(p,"command")?,&process::environment(p)?,&cwd)?)?}),
                )
            }
            "process.spawn" => {
                let _guard = self.allocation.lock().await;
                cancel.check()?;
                if self.processes.lock().await.len() >= MAX_PROCESSES
                    || self.streams.lock().await.len() + 2 > MAX_STREAMS
                {
                    return Err(Error::new("RESOURCE_LIMIT", "process or stream limit"));
                }
                let reservation = number(&p["stdout"], "spillBytes", 0, 16 * 1024 * 1024)?
                    + number(&p["stderr"], "spillBytes", 0, 16 * 1024 * 1024)?;
                self.spill_reserved
                    .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| {
                        n.checked_add(reservation)
                            .filter(|n| *n <= 64 * 1024 * 1024)
                    })
                    .map_err(|_| Error::new("RESOURCE_LIMIT", "runtime spill reservation limit"))?;
                let id = self.resource("p");
                let process = match process::spawn(
                    id.clone(),
                    p,
                    &self.dir,
                    cancel,
                    self.output_budget.clone(),
                    reservation,
                )
                .await
                {
                    Ok(process) => process,
                    Err(error) => {
                        self.spill_reserved.fetch_sub(reservation, Ordering::SeqCst);
                        return Err(error);
                    }
                };
                let mut outputs = Vec::new();
                for out in &process.outputs {
                    self.streams
                        .lock()
                        .await
                        .insert(out.id.clone(), (out.clone(), None));
                    outputs.push(json!({"stream":out.id,"mode":if out.raw{"raw"}else{"collect"}}));
                }
                let result = json!({"process":id,"pid":process.pid,"outputs":outputs});
                self.processes.lock().await.insert(id, process.clone());
                if cancel.check().is_err() {
                    process.terminate().await;
                    return Err(
                        Error::new("CANCELLED", "allocated process cleanup initiated")
                            .detail(json!({"process":process.id,"cleanupComplete":false})),
                    );
                }
                Ok(result)
            }
            "process.write" => {
                let data = STANDARD
                    .decode(string(p, "data")?)
                    .map_err(|_| invalid("invalid Base64"))?;
                if data.len() > CHUNK {
                    return Err(Error::new("RESOURCE_LIMIT", "input chunk limit"));
                }
                self.process(p).await?.write_bytes(&data, cancel).await
            }
            "process.closeStdin" => self.process(p).await?.close_stdin().await,
            "process.status" => Ok(self.process(p).await?.status().await),
            "process.terminate" => Ok(self.process(p).await?.terminate().await),
            "process.signal" => {
                self.process(p)
                    .await?
                    .signal(
                        string(p, "signal")?,
                        p.get("target")
                            .and_then(Value::as_str)
                            .unwrap_or("initial-group"),
                    )
                    .await
            }
            "process.readOutput" | "stream.read" => {
                self.stream(p)
                    .await?
                    .snapshot(number(p, "offset", 0, u64::MAX)?, CHUNK)
                    .await
            }
            "stream.ack" => {
                self.stream(p)
                    .await?
                    .ack(number(p, "offset", 0, u64::MAX)?)
                    .await
            }
            "stream.close" => {
                let id = string(p, "stream")?;
                let mut streams = self.streams.lock().await;
                let (_, stop) = streams
                    .get(id)
                    .ok_or_else(|| Error::new("UNKNOWN_RESOURCE", "unknown stream"))?;
                let stop = stop
                    .as_ref()
                    .ok_or_else(|| invalid("process streams are released with their process"))?;
                stop.cancel();
                streams.remove(id);
                Ok(json!({"closed":true}))
            }
            "process.release" => {
                let proc = self.process(p).await?;
                {
                    let state = proc.state.lock().await;
                    if !state.closed || !state.quiescent {
                        return Err(Error::new(
                            "RESOURCE_BUSY",
                            "process is not closed and cleaned up",
                        ));
                    }
                }
                for out in &proc.outputs {
                    self.streams.lock().await.remove(&out.id);
                }
                let mut retained = 0;
                for out in &proc.outputs {
                    retained += out.retained_spill_bytes().await;
                }
                // Completed files survive release. Refund only unused capacity, once.
                if let Some(released) = self.processes.lock().await.remove(&proc.id) {
                    self.spill_reserved
                        .fetch_sub(released.spill_reservation - retained, Ordering::SeqCst);
                }
                Ok(json!({"released":true}))
            }
            "pty.resize" => {
                let proc = self.process(p).await?;
                let rows = number(p, "rows", 0, u16::MAX as u64)? as u16;
                let cols = number(p, "cols", 0, u16::MAX as u64)? as u16;
                if rows == 0 || cols == 0 {
                    return Err(invalid("positive terminal dimensions required"));
                }
                unix::resize(
                    proc.terminal
                        .as_ref()
                        .ok_or_else(|| invalid("process has no PTY"))?,
                    rows,
                    cols,
                )?;
                Ok(json!({"resized":true}))
            }
            "pty.foreground" => {
                let proc = self.process(p).await?;
                let group = unix::foreground(
                    proc.terminal
                        .as_ref()
                        .ok_or_else(|| invalid("process has no PTY"))?,
                )?;
                Ok(json!({"group":group,"inputWaiting":"unknown"}))
            }
            _ => Err(Error::new("UNSUPPORTED", "unknown method")),
        }
    }
    async fn cleanup(&self, deadline: Duration) -> bool {
        let start = Instant::now();
        {
            let s = self.session.lock().await;
            for r in s.requests.values() {
                r.cancel.cancel();
            }
        }
        for (_, stop) in self.streams.lock().await.values() {
            if let Some(stop) = stop {
                stop.cancel();
            }
        }
        // Wait for allocations that were already admitted before taking the process snapshot.
        let Ok(_allocation) = tokio::time::timeout(deadline, self.allocation.lock()).await else {
            return false;
        };
        let processes: Vec<_> = self.processes.lock().await.values().cloned().collect();
        for p in &processes {
            p.terminate().await;
        }
        loop {
            let mut complete = true;
            for p in &processes {
                let s = p.state.lock().await;
                complete &= s.quiescent && s.closed;
            }
            if complete {
                return true;
            }
            if start.elapsed() >= deadline {
                return false;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }
}
fn response(id: u64, result: Result<Value>) -> Value {
    match result {
        Ok(value) => json!({"id":id,"result":value}),
        Err(e) => json!({"id":id,"error":e.value()}),
    }
}
async fn send<W: tokio::io::AsyncWrite + Unpin>(writer: &mut W, value: &Value) -> Result<()> {
    tokio::time::timeout(Duration::from_secs(2), wire::write(writer, value))
        .await
        .map_err(|_| Error::new("TIMEOUT", "transport output stalled"))?
}
