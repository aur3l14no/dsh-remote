use crate::{
    cancel::Cancel,
    error::{invalid, number, string, Error, Result},
    fs,
    output::{Budget, Output, MAX_COLLECT_BYTES, MAX_RAW_BYTES},
    unix,
    wire::CHUNK,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashMap},
    fs::{File, OpenOptions},
    os::unix::{fs::OpenOptionsExt, process::ExitStatusExt},
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::{
    io::{unix::AsyncFd, AsyncRead, AsyncReadExt, AsyncWriteExt},
    process::{Child, ChildStdin, Command},
    sync::Mutex,
};

pub struct Process {
    pub id: String,
    pub pid: i32,
    pub spill_reservation: u64,
    pub outputs: Vec<Arc<Output>>,
    pub state: Mutex<State>,
    input: Mutex<Option<ChildStdin>>,
    input_order: Mutex<()>,
    pub terminal: Option<Arc<AsyncFd<File>>>,
    stop_io: Cancel,
    stop_input: Cancel,
    grace: Duration,
    drain: Duration,
}
pub struct State {
    pub published: bool,
    pub exit: Option<Value>,
    pub closed: bool,
    pub quiescent: bool,
    pub observation_error: Option<Value>,
    known: HashMap<i32, u64>,
    termination: Option<Instant>,
    pub term_sent: bool,
    pub kill_sent: bool,
    pub revision: u64,
}
pub fn environment(p: &Value) -> Result<BTreeMap<String, String>> {
    let mut env: BTreeMap<_, _> = std::env::vars()
        .filter(|(key, _)| {
            let upper = key.to_uppercase();
            !upper.starts_with("DSH_")
                && !["KEY", "PASSWORD", "SECRET", "TOKEN"]
                    .iter()
                    .any(|s| upper.contains(s))
        })
        .collect();
    if let Some(overrides) = p.get("env") {
        for (key, value) in overrides
            .as_object()
            .ok_or_else(|| invalid("env must be an object"))?
        {
            if key.is_empty() || key.contains(['\0', '=']) {
                return Err(invalid("invalid environment key"));
            }
            if value.is_null() {
                env.remove(key);
            } else {
                let value = value
                    .as_str()
                    .ok_or_else(|| invalid("env values must be strings or null"))?;
                if value.contains('\0') {
                    return Err(invalid("NUL in environment value"));
                }
                env.insert(key.clone(), value.into());
            }
        }
    }
    Ok(env)
}
pub fn executable(command: &str, env: &BTreeMap<String, String>, cwd: &Path) -> Result<PathBuf> {
    if command.is_empty() || command.contains('\0') {
        return Err(invalid("empty or NUL executable"));
    }
    let candidates: Vec<_> = if Path::new(command).is_absolute() {
        vec![PathBuf::from(command)]
    } else {
        if command.contains('/') {
            return Err(invalid("relative executable may not contain '/'"));
        }
        env.get("PATH")
            .map(|v| {
                v.split(':')
                    .map(|dir| cwd.join(dir).join(command))
                    .collect()
            })
            .unwrap_or_default()
    };
    let mut denied = false;
    for path in candidates {
        match std::fs::metadata(&path) {
            Ok(m) if m.is_file() => {
                let c = std::ffi::CString::new(path.as_os_str().as_encoded_bytes())
                    .map_err(|_| invalid("NUL executable"))?;
                if unsafe { libc::access(c.as_ptr(), libc::X_OK) } == 0 {
                    // Keep the invoked filename: multicall executables select their
                    // behavior from argv[0], even when the file is a symlink.
                    let parent = path
                        .parent()
                        .ok_or_else(|| invalid("executable has no parent"))?;
                    let name = path
                        .file_name()
                        .ok_or_else(|| invalid("executable has no filename"))?;
                    return Ok(fs::resolve(parent)?.join(name));
                }
                denied = true;
            }
            Ok(_) => (),
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
                ) => {}
            Err(e) => return Err(e.into()),
        }
    }
    Err(Error::new(
        if denied {
            "PERMISSION_DENIED"
        } else {
            "NOT_FOUND"
        },
        "executable unavailable in target environment",
    ))
}
fn output(id: String, spec: &Value, dir: &Path, budget: Arc<Budget>) -> Result<Arc<Output>> {
    let mode = spec.get("mode").and_then(Value::as_str).unwrap_or("raw");
    if mode != "raw" && mode != "collect" {
        return Err(invalid("output mode must be raw or collect"));
    }
    let limit = if mode == "raw" {
        MAX_RAW_BYTES
    } else {
        MAX_COLLECT_BYTES
    };
    let cap = number(spec, "maxBytes", 64 * 1024, limit as u64)? as usize;
    if cap == 0 {
        return Err(invalid("output maxBytes must be positive"));
    }
    let spill = if let Some(v) = spec.get("spillBytes") {
        if mode != "collect" {
            return Err(invalid("spill requires collect mode"));
        }
        let cap = v
            .as_u64()
            .filter(|n| *n > 0 && *n <= 16 * 1024 * 1024)
            .ok_or_else(|| invalid("spillBytes must be 1..16777216"))?;
        let path = dir.join(format!("{id}.spill"));
        Some((
            OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&path)?,
            path,
            cap,
        ))
    } else {
        None
    };
    Output::new(id, mode == "raw", cap, spill, budget)
}
pub async fn spawn(
    id: String,
    p: &Value,
    dir: &Path,
    cancel: &Cancel,
    budget: Arc<Budget>,
    spill_reservation: u64,
) -> Result<Arc<Process>> {
    cancel.check()?;
    let args = p["argv"]
        .as_array()
        .filter(|a| !a.is_empty())
        .ok_or_else(|| invalid("argv must be nonempty"))?
        .iter()
        .map(|v| {
            v.as_str()
                .filter(|s| !s.contains('\0'))
                .map(String::from)
                .ok_or_else(|| invalid("argv elements must be NUL-free strings"))
        })
        .collect::<Result<Vec<_>>>()?;
    let cwd = fs::absolute(string(p, "cwd")?)?;
    if !std::fs::metadata(&cwd)?.is_dir() {
        return Err(Error::new("NOT_DIRECTORY", "cwd must be a directory"));
    }
    let env = environment(p)?;
    let executable = executable(&args[0], &env, &cwd)?;
    let grace = number(p, "graceMs", 1000, 30_000)?;
    let drain = number(p, "drainMs", 2000, 30_000)?;
    if grace == 0 || drain == 0 {
        return Err(invalid("graceMs and drainMs must be positive"));
    }
    let mode = p.get("mode").and_then(Value::as_str).unwrap_or("pipe");
    if mode != "pipe" && mode != "pty" {
        return Err(invalid("process mode must be pipe or pty"));
    }
    let mut cmd = Command::new(executable);
    cmd.args(&args[1..])
        .current_dir(&cwd)
        .env_clear()
        .envs(env)
        .kill_on_drop(true);
    let mut terminal = None;
    let mut finite = None;
    let outputs;
    if mode == "pty" {
        let rows = number(p, "rows", 24, u16::MAX as u64)? as u16;
        let cols = number(p, "cols", 80, u16::MAX as u64)? as u16;
        if rows == 0 || cols == 0 {
            return Err(invalid("terminal dimensions must be positive"));
        }
        let pty = unix::pty(rows, cols)?;
        cmd.stdin(pty.slave.try_clone()?)
            .stdout(pty.slave.try_clone()?)
            .stderr(pty.slave);
        terminal = Some(Arc::new(pty.master));
        outputs = vec![output(
            format!("{id}.pty"),
            &json!({"mode":"raw","maxBytes":number(p,"maxBytes",64*1024,1024*1024)?}),
            dir,
            budget,
        )?];
    } else {
        let stdin = p.get("stdin").unwrap_or(&Value::Null);
        match stdin
            .as_str()
            .unwrap_or(if stdin.is_object() { "data" } else { "ignore" })
        {
            "ignore" => {
                cmd.stdin(Stdio::null());
            }
            "pipe" => {
                cmd.stdin(Stdio::piped());
            }
            "data" => {
                let data = STANDARD
                    .decode(string(stdin, "data")?)
                    .map_err(|_| invalid("invalid stdin Base64"))?;
                if data.len() > CHUNK {
                    return Err(Error::new(
                        "RESOURCE_LIMIT",
                        "finite stdin exceeds chunk limit",
                    ));
                }
                finite = Some(data);
                cmd.stdin(Stdio::piped());
            }
            _ => return Err(invalid("stdin must be ignore, pipe, or {data: base64}")),
        }
        cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
        outputs = vec![
            output(format!("{id}.stdout"), &p["stdout"], dir, budget.clone())?,
            output(format!("{id}.stderr"), &p["stderr"], dir, budget)?,
        ];
    }
    let is_pty = terminal.is_some();
    unsafe {
        cmd.pre_exec(move || {
            if libc::setsid() < 0 {
                return Err(std::io::Error::last_os_error());
            }
            if is_pty && libc::ioctl(0, libc::TIOCSCTTY as _, 0) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    cancel.check()?;
    let mut child = tokio::task::block_in_place(|| cmd.spawn())?;
    let pid = child
        .id()
        .ok_or_else(|| Error::new("IO_ERROR", "spawn returned no PID"))? as i32;
    let observations = unix::members(pid);
    let mut known = HashMap::new();
    if let Ok(all) = &observations {
        for m in all {
            if m.session == pid {
                known.insert(m.pid, m.birth);
            }
        }
    }
    let proc = Arc::new(Process {
        id,
        spill_reservation,
        pid,
        outputs,
        state: Mutex::new(State {
            published: false,
            exit: None,
            closed: false,
            quiescent: false,
            observation_error: observations.err().map(|e| e.value()),
            known,
            termination: None,
            term_sent: false,
            kill_sent: false,
            revision: 0,
        }),
        input: Mutex::new(child.stdin.take()),
        input_order: Mutex::new(()),
        terminal,
        stop_io: Cancel::default(),
        stop_input: Cancel::default(),
        grace: Duration::from_millis(grace),
        drain: Duration::from_millis(drain),
    });
    if let Some(pty) = &proc.terminal {
        let pty = pty.clone();
        let cloned = proc.clone();
        let out = proc.outputs[0].clone();
        tokio::spawn(async move {
            let mut bytes = vec![0; CHUNK];
            let result:Result<()>=async {loop {
            let n=tokio::select!{_ = cloned.stop_io.cancelled()=>return Err(Error::new("OUTPUT_INCOMPLETE","output drain interrupted")),n=unix::read_pty(&pty,&mut bytes)=>n?};
            if n==0{return Ok(());}
            tokio::select!{_ = cloned.stop_io.cancelled()=>return Err(Error::new("OUTPUT_INCOMPLETE","output drain interrupted")),open=out.append(&bytes[..n])=>if !open{return Ok(());}}
        }}.await;
            out.finish(result.err().map(|e| e.value())).await;
        });
    } else {
        reader(
            child.stdout.take().expect("piped stdout"),
            proc.clone(),
            proc.outputs[0].clone(),
        );
        reader(
            child.stderr.take().expect("piped stderr"),
            proc.clone(),
            proc.outputs[1].clone(),
        );
    }
    let cloned = proc.clone();
    tokio::spawn(async move {
        cloned.monitor(child).await;
    });
    if let Some(data) = finite {
        let p = proc.clone();
        tokio::spawn(async move {
            let _ = p.write_bytes(&data, &Cancel::default()).await;
            let _ = p.close_stdin().await;
        });
    }
    Ok(proc)
}
fn reader<R: AsyncRead + Unpin + Send + 'static>(
    mut reader: R,
    proc: Arc<Process>,
    out: Arc<Output>,
) {
    tokio::spawn(async move {
        let mut bytes = vec![0; CHUNK];
        let result:Result<()>=async{loop{
        let n=tokio::select!{_ = proc.stop_io.cancelled()=>return Err(Error::new("OUTPUT_INCOMPLETE","output drain interrupted")),n=reader.read(&mut bytes)=>n?};
        if n==0{return Ok(());}
        tokio::select!{_ = proc.stop_io.cancelled()=>return Err(Error::new("OUTPUT_INCOMPLETE","output drain interrupted")),open=out.append(&bytes[..n])=>if !open{return Ok(());}}
    }}.await;
        out.finish(result.err().map(|e| e.value())).await;
    });
}
impl Process {
    pub async fn publish(&self) {
        self.state.lock().await.published = true;
    }
    pub async fn status(&self) -> Value {
        let s = self.state.lock().await;
        json!({"process":self.id,"pid":self.pid,"rootExit":s.exit,"closed":s.closed,"cleanupScope":"observed-session-members","cleanupComplete":s.quiescent,"observationError":s.observation_error,"terminationAccepted":s.termination.is_some(),"termSent":s.term_sent,"killSent":s.kill_sent,"revision":s.revision})
    }
    pub async fn terminate(&self) -> Value {
        let mut s = self.state.lock().await;
        if s.termination.is_none() {
            s.termination = Some(Instant::now());
            s.revision += 1;
        }
        self.stop_input.cancel();
        json!({"accepted":true,"cleanupComplete":s.quiescent})
    }
    async fn monitor(self: Arc<Self>, mut child: Child) {
        let mut root_exit_at = None;
        loop {
            let mut s = self.state.lock().await;
            if !s.quiescent {
                match unix::members(self.pid) {
                    Ok(all) => {
                        let anchored = s.exit.is_none()
                            || all.iter().any(|m| s.known.get(&m.pid) == Some(&m.birth));
                        s.known.retain(|pid, birth| {
                            all.iter().any(|m| m.pid == *pid && m.birth == *birth)
                        });
                        if anchored {
                            for m in &all {
                                if m.session == self.pid {
                                    s.known.insert(m.pid, m.birth);
                                }
                            }
                        }
                        let live = all.iter().any(|m| {
                            !m.zombie
                                && m.session == self.pid
                                && s.known.get(&m.pid) == Some(&m.birth)
                        });
                        #[cfg(target_os = "linux")]
                        for m in &all {
                            if m.zombie
                                && m.pid != self.pid
                                && m.ppid == std::process::id() as i32
                                && s.known.get(&m.pid) == Some(&m.birth)
                            {
                                unsafe {
                                    libc::waitpid(m.pid, std::ptr::null_mut(), libc::WNOHANG);
                                }
                            }
                        }
                        s.observation_error = None;
                        if !live && s.exit.is_some() {
                            s.quiescent = true;
                            s.revision += 1;
                        }
                    }
                    Err(e) => {
                        s.observation_error = Some(e.value());
                    }
                }
            }
            if let Some(start) = s.termination {
                if !s.quiescent {
                    let signal = if start.elapsed() >= self.grace {
                        libc::SIGKILL
                    } else {
                        libc::SIGTERM
                    };
                    // Re-scan and re-signal observed members, including children created during grace.
                    let _ = unix::signal_owned(&s.known, self.pid, None, libc::SIGCONT);
                    match unix::signal_owned(&s.known, self.pid, None, signal) {
                        Ok(n) => {
                            if n > 0 {
                                if signal == libc::SIGKILL {
                                    s.kill_sent = true;
                                } else {
                                    s.term_sent = true;
                                }
                                s.revision += 1;
                            }
                        }
                        Err(e) => s.observation_error = Some(e.value()),
                    }
                }
            }
            if s.exit.is_none() {
                match child.try_wait() {
                    Ok(Some(exit)) => {
                        s.exit = Some(
                            json!({"code":exit.code(),"signal":exit.signal(),"signalName":exit.signal().and_then(unix::exit_signal_name),"coreDumped":exit.core_dumped()}),
                        );
                        self.stop_input.cancel();
                        root_exit_at = Some(Instant::now());
                        s.revision += 1;
                    }
                    Ok(None) => (),
                    Err(e) => {
                        s.observation_error = Some(Error::from(e).value());
                    }
                }
            }
            if root_exit_at.is_some_and(|t| t.elapsed() >= self.drain) {
                self.stop_io.cancel();
            }
            if s.exit.is_some() && !s.closed {
                let mut closed = true;
                for out in &self.outputs {
                    closed &= out.eof().await;
                }
                if closed {
                    s.closed = true;
                    s.revision += 1;
                }
            }
            if s.closed && s.quiescent {
                break;
            }
            drop(s);
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }
    pub async fn write_bytes(&self, bytes: &[u8], cancel: &Cancel) -> Result<Value> {
        let _order = self.input_order.lock().await;
        let mut written = 0;
        let mut stdin = self.input.lock().await;
        while written < bytes.len() {
            let next = async {
                if let Some(pty) = &self.terminal {
                    unix::write_pty(pty, &bytes[written..]).await
                } else if let Some(stdin) = stdin.as_mut() {
                    stdin.write(&bytes[written..]).await
                } else {
                    Err(std::io::Error::new(
                        std::io::ErrorKind::BrokenPipe,
                        "stdin is closed",
                    ))
                }
            };
            let n = tokio::select! {
                _ = cancel.cancelled()=>return Err(Error::new("CANCELLED","stdin write cancelled").detail(json!({"written":written}))),
                _ = self.stop_input.cancelled()=>return Err(Error::new("CLOSED","process input is closing").detail(json!({"written":written}))),
                n=next=>n.map_err(|e|Error::from(e).detail(json!({"written":written})))?
            };
            if n == 0 {
                return Err(Error::new("CLOSED", "zero-byte input write")
                    .detail(json!({"written":written})));
            }
            written += n;
        }
        Ok(json!({"written":written}))
    }
    pub async fn close_stdin(&self) -> Result<Value> {
        if self.terminal.is_some() {
            return Err(invalid("PTY has no stdin half-close"));
        }
        let _order = self.input_order.lock().await;
        self.input.lock().await.take();
        Ok(json!({"closed":true}))
    }
    pub async fn signal(&self, name: &str, target: &str) -> Result<Value> {
        let signal = unix::signal_name(name)?;
        let group = match target {
            "initial-group" => self.pid,
            "foreground" => unix::foreground(
                self.terminal
                    .as_ref()
                    .ok_or_else(|| invalid("foreground requires PTY"))?,
            )?,
            _ => return Err(invalid("signal target must be initial-group or foreground")),
        };
        let mut s = self.state.lock().await;
        if s.quiescent {
            return Err(Error::new("CLOSED", "managed session is quiescent"));
        }
        let all = unix::members(self.pid)?;
        if s.exit.is_some() && !all.iter().any(|m| s.known.get(&m.pid) == Some(&m.birth)) {
            return Err(Error::new(
                "NOT_FOUND",
                "no identity anchor remains in the managed session",
            ));
        }
        for m in all {
            if m.session == self.pid {
                s.known.insert(m.pid, m.birth);
            }
        }
        let n = unix::signal_owned(&s.known, self.pid, Some(group), signal)?;
        if n == 0 {
            return Err(Error::new("NOT_FOUND", "no observed live group member"));
        }
        Ok(json!({"signalSent":true,"group":group,"membersSignalled":n,"cleanupComplete":false}))
    }
}
