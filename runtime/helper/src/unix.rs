use crate::error::{Error, Result};
use std::{
    collections::HashMap,
    fs::File,
    io,
    os::fd::{AsRawFd, FromRawFd},
    os::unix::fs::OpenOptionsExt,
};
use tokio::io::unix::AsyncFd;

pub struct Pty {
    pub master: AsyncFd<File>,
    pub slave: File,
}
pub fn pty(rows: u16, cols: u16) -> Result<Pty> {
    // openpty is available on Linux (including musl) and Darwin.
    let mut master = -1;
    let mut slave = -1;
    let mut size = libc::winsize {
        ws_row: rows,
        ws_col: cols,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    if unsafe {
        libc::openpty(
            &mut master,
            &mut slave,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::addr_of_mut!(size),
        )
    } != 0
    {
        return Err(io::Error::last_os_error().into());
    }
    let master = unsafe { File::from_raw_fd(master) };
    let slave = unsafe { File::from_raw_fd(slave) };
    for file in [&master, &slave] {
        if unsafe { libc::fcntl(file.as_raw_fd(), libc::F_SETFD, libc::FD_CLOEXEC) } < 0 {
            return Err(io::Error::last_os_error().into());
        }
    }
    nonblock(&master)?;
    Ok(Pty {
        master: AsyncFd::new(master)?,
        slave,
    })
}
pub fn nonblock(file: &File) -> io::Result<()> {
    let fd = file.as_raw_fd();
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}
pub async fn read_pty(file: &AsyncFd<File>, bytes: &mut [u8]) -> io::Result<usize> {
    loop {
        let mut ready = file.readable().await?;
        match ready.try_io(|fd| {
            let n = unsafe { libc::read(fd.as_raw_fd(), bytes.as_mut_ptr().cast(), bytes.len()) };
            if n < 0 {
                let e = io::Error::last_os_error();
                if e.raw_os_error() == Some(libc::EIO) {
                    Ok(0)
                } else {
                    Err(e)
                }
            } else {
                Ok(n as usize)
            }
        }) {
            Ok(r) => return r,
            Err(_) => continue,
        }
    }
}
pub async fn write_pty(file: &AsyncFd<File>, bytes: &[u8]) -> io::Result<usize> {
    loop {
        let mut ready = file.writable().await?;
        match ready.try_io(|fd| {
            let n = unsafe { libc::write(fd.as_raw_fd(), bytes.as_ptr().cast(), bytes.len()) };
            if n < 0 {
                Err(io::Error::last_os_error())
            } else {
                Ok(n as usize)
            }
        }) {
            Ok(r) => return r,
            Err(_) => continue,
        }
    }
}
pub fn resize(file: &AsyncFd<File>, rows: u16, cols: u16) -> Result<()> {
    let size = libc::winsize {
        ws_row: rows,
        ws_col: cols,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    if unsafe { libc::ioctl(file.as_raw_fd(), libc::TIOCSWINSZ, &size) } < 0 {
        return Err(io::Error::last_os_error().into());
    }
    Ok(())
}
pub fn foreground(file: &AsyncFd<File>) -> Result<i32> {
    let id = unsafe { libc::tcgetpgrp(file.as_raw_fd()) };
    if id < 0 {
        return Err(io::Error::last_os_error().into());
    }
    Ok(id)
}
#[derive(Clone, Debug)]
pub struct Member {
    pub pid: i32,
    #[cfg(target_os = "linux")]
    pub ppid: i32,
    pub group: i32,
    pub session: i32,
    pub birth: u64,
    pub zombie: bool,
}
#[cfg(target_os = "linux")]
pub fn members(session_filter: i32) -> Result<Vec<Member>> {
    let mut out = Vec::new();
    for entry in std::fs::read_dir("/proc")? {
        let entry = entry?;
        let Ok(pid) = entry.file_name().to_string_lossy().parse::<i32>() else {
            continue;
        };
        if unsafe { libc::getsid(pid) } != session_filter {
            continue;
        }
        let stat = match std::fs::read_to_string(entry.path().join("stat")) {
            Ok(s) => s,
            Err(e) if e.kind() == io::ErrorKind::NotFound => continue,
            Err(e) => return Err(e.into()),
        };
        let Some(end) = stat.rfind(')') else {
            return Err(Error::new("OBSERVATION_FAILED", "invalid proc stat"));
        };
        let fields: Vec<_> = stat[end + 1..].split_whitespace().collect();
        if fields.len() < 20 {
            return Err(Error::new("OBSERVATION_FAILED", "short proc stat"));
        }
        let parse = |n: usize| {
            fields[n]
                .parse::<i32>()
                .map_err(|_| Error::new("OBSERVATION_FAILED", "invalid proc field"))
        };
        if parse(3)? != session_filter {
            continue;
        }
        out.push(Member {
            pid,
            ppid: parse(1)?,
            group: parse(2)?,
            session: parse(3)?,
            birth: fields[19]
                .parse()
                .map_err(|_| Error::new("OBSERVATION_FAILED", "invalid process birth"))?,
            zombie: fields[0] == "Z" || fields[0] == "X",
        });
    }
    Ok(out)
}
#[cfg(target_os = "macos")]
pub fn members(session_filter: i32) -> Result<Vec<Member>> {
    let needed = unsafe {
        libc::proc_listpids(
            1, /* PROC_ALL_PIDS, libproc.h */
            0,
            std::ptr::null_mut(),
            0,
        )
    };
    if needed <= 0 {
        return Err(io::Error::last_os_error().into());
    }
    let mut pids = vec![0i32; needed as usize / 4 + 1024];
    let count = unsafe {
        libc::proc_listpids(
            1, /* PROC_ALL_PIDS, libproc.h */
            0,
            pids.as_mut_ptr().cast(),
            (pids.len() * 4) as i32,
        )
    };
    if count <= 0 || count as usize >= pids.len() * 4 {
        return Err(Error::new(
            "OBSERVATION_FAILED",
            "process enumeration incomplete",
        ));
    }
    let mut out = Vec::new();
    for pid in pids.into_iter().take(count as usize / 4).filter(|p| *p > 0) {
        let session = unsafe { libc::getsid(pid) };
        if session != session_filter {
            continue;
        }
        let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
        let size = std::mem::size_of_val(&info) as i32;
        let n = unsafe {
            libc::proc_pidinfo(
                pid,
                libc::PROC_PIDTBSDINFO,
                0,
                (&mut info as *mut libc::proc_bsdinfo).cast(),
                size,
            )
        };
        if n != size {
            let e = io::Error::last_os_error();
            if e.raw_os_error() == Some(libc::ESRCH) || e.raw_os_error() == Some(libc::ENOENT) {
                continue;
            }
            // Other users may be inaccessible; never skip a same-account process silently.
            return Err(Error::new("OBSERVATION_FAILED", e.to_string()));
        }
        let session = unsafe { libc::getsid(pid) };
        if session < 0 {
            continue;
        }
        out.push(Member {
            pid,
            group: info.pbi_pgid as i32,
            session,
            birth: info.pbi_start_tvsec * 1_000_000 + info.pbi_start_tvusec,
            zombie: info.pbi_status == libc::SZOMB,
        });
    }
    Ok(out)
}
pub fn signal_name(name: &str) -> Result<i32> {
    Ok(match name {
        "INT" => libc::SIGINT,
        "TERM" => libc::SIGTERM,
        "KILL" => libc::SIGKILL,
        "HUP" => libc::SIGHUP,
        "QUIT" => libc::SIGQUIT,
        "TSTP" => libc::SIGTSTP,
        "CONT" => libc::SIGCONT,
        "USR1" => libc::SIGUSR1,
        "USR2" => libc::SIGUSR2,
        _ => return Err(Error::new("UNSUPPORTED", "unsupported portable signal")),
    })
}
/// Signal numbers differ between target platforms; publish the target's own spelling.
pub fn exit_signal_name(signal: i32) -> Option<&'static str> {
    [
        (libc::SIGHUP, "SIGHUP"),
        (libc::SIGINT, "SIGINT"),
        (libc::SIGQUIT, "SIGQUIT"),
        (libc::SIGILL, "SIGILL"),
        (libc::SIGTRAP, "SIGTRAP"),
        (libc::SIGABRT, "SIGABRT"),
        (libc::SIGBUS, "SIGBUS"),
        (libc::SIGFPE, "SIGFPE"),
        (libc::SIGKILL, "SIGKILL"),
        (libc::SIGUSR1, "SIGUSR1"),
        (libc::SIGSEGV, "SIGSEGV"),
        (libc::SIGUSR2, "SIGUSR2"),
        (libc::SIGPIPE, "SIGPIPE"),
        (libc::SIGALRM, "SIGALRM"),
        (libc::SIGTERM, "SIGTERM"),
        (libc::SIGCHLD, "SIGCHLD"),
        (libc::SIGCONT, "SIGCONT"),
        (libc::SIGSTOP, "SIGSTOP"),
        (libc::SIGTSTP, "SIGTSTP"),
        (libc::SIGTTIN, "SIGTTIN"),
        (libc::SIGTTOU, "SIGTTOU"),
        (libc::SIGURG, "SIGURG"),
        (libc::SIGXCPU, "SIGXCPU"),
        (libc::SIGXFSZ, "SIGXFSZ"),
        (libc::SIGVTALRM, "SIGVTALRM"),
        (libc::SIGPROF, "SIGPROF"),
        (libc::SIGWINCH, "SIGWINCH"),
        (libc::SIGIO, "SIGIO"),
        (libc::SIGSYS, "SIGSYS"),
    ]
    .into_iter()
    .find_map(|(number, name)| (number == signal).then_some(name))
}
pub fn signal_owned(
    known: &HashMap<i32, u64>,
    session: i32,
    group: Option<i32>,
    signal: i32,
) -> Result<usize> {
    let all = members(session)?;
    let mut sent = 0;
    for m in all {
        if !m.zombie
            && m.session == session
            && known.get(&m.pid) == Some(&m.birth)
            && group.is_none_or(|g| m.group == g)
        {
            if unsafe { libc::kill(m.pid, signal) } < 0 {
                let e = io::Error::last_os_error();
                if e.raw_os_error() != Some(libc::ESRCH) {
                    return Err(e.into());
                }
            } else {
                sent += 1;
            }
        }
    }
    Ok(sent)
}
pub fn random_id() -> Result<String> {
    use std::io::Read;
    let mut bytes = [0u8; 24];
    std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_CLOEXEC)
        .open("/dev/urandom")?
        .read_exact(&mut bytes)?;
    Ok(bytes.iter().map(|x| format!("{x:02x}")).collect())
}
