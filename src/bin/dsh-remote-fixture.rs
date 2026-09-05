//! Portable acceptance child. Never used by the helper in production.
use std::{
    io::{self, BufRead, Read, Write},
    os::unix::process::CommandExt,
    time::Duration,
};
fn main() {
    let args: Vec<_> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("echo") => {
            let mut bytes = Vec::new();
            io::stdin().read_to_end(&mut bytes).unwrap();
            io::stdout().write_all(&bytes).unwrap();
            io::stderr().write_all(&[0, 255, 254, b'!']).unwrap();
        }
        Some("argv") => println!("{}", serde_json::to_string(&args[2..]).unwrap()),
        Some("env") => {
            let values: std::collections::BTreeMap<_, _> = args[2..]
                .iter()
                .map(|k| (k, std::env::var(k).ok()))
                .collect();
            println!("{}", serde_json::to_string(&values).unwrap());
        }
        Some("burst") => {
            let n: usize = args[2].parse().unwrap();
            let chunk: Vec<_> = (0..8192).map(|n| (n % 251) as u8).collect();
            let mut out = io::stdout().lock();
            for i in (0..n).step_by(chunk.len()) {
                out.write_all(&chunk[..chunk.len().min(n - i)]).unwrap();
            }
            out.flush().unwrap();
            if let Some(path) = args.get(3) {
                std::fs::write(path, b"complete").unwrap();
            }
        }
        Some("hold") => {
            if args.get(2).is_some_and(|v| v == "ignore") {
                unsafe {
                    libc::signal(libc::SIGTERM, libc::SIG_IGN);
                }
            }
            if let Some(path) = args.get(3) {
                std::fs::write(path, std::process::id().to_string()).unwrap();
            }
            loop {
                std::thread::sleep(Duration::from_secs(1));
            }
        }
        Some("tree") => {
            let mut cmd = std::process::Command::new(std::env::current_exe().unwrap());
            cmd.args(["hold", "ignore", &args[2]]);
            if args.get(3).is_some_and(|v| v == "escape") {
                unsafe {
                    cmd.pre_exec(|| {
                        if libc::setsid() < 0 {
                            Err(io::Error::last_os_error())
                        } else {
                            Ok(())
                        }
                    });
                }
            }
            // Intentionally orphan this child to test helper-owned descendant cleanup.
            #[allow(clippy::zombie_processes)]
            let child = cmd.spawn().unwrap();
            println!("{}", child.id());
        }
        Some("pty") => {
            let mut size: libc::winsize = unsafe { std::mem::zeroed() };
            unsafe {
                libc::ioctl(0, libc::TIOCGWINSZ, &mut size);
            }
            println!(
                "TTY {} {} {}",
                unsafe { libc::isatty(0) },
                size.ws_row,
                size.ws_col
            );
            io::stdout().flush().unwrap();
            for line in io::stdin().lock().lines() {
                match line.unwrap().as_str() {
                    "size" => {
                        unsafe {
                            libc::ioctl(0, libc::TIOCGWINSZ, &mut size);
                        }
                        println!("SIZE {} {}", size.ws_row, size.ws_col);
                    }
                    "quit" => break,
                    _ => println!("INPUT"),
                }
                io::stdout().flush().unwrap();
            }
        }
        Some("append") => {
            let mut f = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&args[2])
                .unwrap();
            f.write_all(b"once\n").unwrap();
        }
        _ => std::process::exit(2),
    }
}
