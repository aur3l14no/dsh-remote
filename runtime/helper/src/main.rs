#![cfg(unix)]
mod cancel;
mod error;
mod fs;
mod output;
mod process;
mod runtime;
mod unix;
mod wire;
use error::{invalid, Result};
use std::{path::PathBuf, time::Duration};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let result = if args.get(1).is_some_and(|s| s == "connect") {
        bridge(&args)
    } else {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .expect("create runtime")
            .block_on(run())
    };
    if let Err(e) = result {
        eprintln!("{}: {}", e.code, e.message);
        std::process::exit(1);
    }
}
fn bridge(args: &[String]) -> Result<()> {
    use std::{
        io::{self, Read, Write},
        net::Shutdown,
        os::unix::net::UnixStream,
    };
    let socket = args
        .windows(2)
        .find(|v| v[0] == "--socket")
        .ok_or_else(|| invalid("missing --socket"))?;
    let mut reader = UnixStream::connect(&socket[1])?;
    let mut writer = reader.try_clone()?;
    // A detached stdio thread allows remote EOF to end the bridge even while
    // stdin remains open. Tokio's blocking stdin worker cannot be cancelled.
    std::thread::spawn(move || {
        let _ = io::copy(&mut io::stdin().lock(), &mut writer);
        let _ = writer.shutdown(Shutdown::Both);
    });
    let mut output = io::stdout().lock();
    let mut bytes = [0u8; 32768];
    loop {
        let n = reader.read(&mut bytes)?;
        if n == 0 {
            break;
        }
        output.write_all(&bytes[..n])?;
        output.flush()?;
    }
    Ok(())
}
async fn run() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let option = |name: &str| -> Result<&str> {
        args.windows(2)
            .find(|v| v[0] == name)
            .map(|v| v[1].as_str())
            .ok_or_else(|| invalid(format!("missing {name}")))
    };
    let milliseconds = |name: &str, default: u64| -> Result<Duration> {
        let n = match args.windows(2).find(|v| v[0] == name) {
            Some(v) => v[1]
                .parse::<u64>()
                .map_err(|_| invalid(format!("invalid {name}")))?,
            None => default,
        };
        if !(100..=300_000).contains(&n) {
            return Err(invalid(format!("{name} must be 100..300000")));
        }
        Ok(Duration::from_millis(n))
    };
    match args.get(1).map(String::as_str) {
        Some("serve") => {
            runtime::Runtime::serve(
                PathBuf::from(option("--runtime-dir")?),
                PathBuf::from(option("--cwd")?),
                milliseconds("--grace-ms", 30_000)?,
                milliseconds("--lease-ms", 30_000)?,
            )
            .await
        }
        Some("start") => {
            use std::{
                os::unix::process::CommandExt,
                process::{Command, Stdio},
            };
            let dir = PathBuf::from(option("--runtime-dir")?);
            if std::fs::symlink_metadata(&dir).is_ok() {
                return Err(invalid("runtime directory must not already exist"));
            }
            let mut cmd = Command::new(std::env::current_exe()?);
            cmd.arg("serve")
                .args(&args[2..])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            unsafe {
                cmd.pre_exec(|| {
                    if libc::setsid() < 0 {
                        Err(std::io::Error::last_os_error())
                    } else {
                        Ok(())
                    }
                });
            }
            let mut child = cmd.spawn()?;
            for _ in 0..100 {
                if dir.join("socket").exists() {
                    println!("{{\"started\":true}}");
                    return Ok(());
                }
                if child.try_wait()?.is_some() {
                    return Err(error::Error::new(
                        "START_FAILED",
                        "helper exited before socket became available",
                    ));
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            let _ = child.kill();
            let _ = child.wait();
            Err(error::Error::new(
                "START_FAILED",
                "runtime startup timed out",
            ))
        }
        Some("--version") => {
            println!(
                "dsh-remote-helper {} api=1 {}-{}",
                env!("CARGO_PKG_VERSION"),
                std::env::consts::ARCH,
                std::env::consts::OS
            );
            Ok(())
        }
        _ => {
            eprintln!("Usage: dsh-remote-helper serve|start --runtime-dir ABSENT_DIR --cwd DIR [--grace-ms N] [--lease-ms N]\n       dsh-remote-helper connect --socket PATH\n       dsh-remote-helper --version");
            Err(invalid("unknown command"))
        }
    }
}
