//! 裸 `openpty` + `fork/execve` + `write(2)`。
//!
//! 刻意**不用** `portable_pty`：它的 `take_writer()` 返回的 writer 在 Drop 时会往 PTY 里写
//! `\n` + EOT——谁持有它、谁的线程一结束就等于替 shell 按了 Ctrl-D。supervisor 今天能活下来
//! 只是因为收尾形状恰好如此；在 ptyd 里，任何"丢掉一个 session writer 而 shell 该活着"的路径
//! 都会把 EOF 送进每一个 shell。这里的写就是对 master fd 的 `write(2)`，没有任何析构副作用。

use std::ffi::CString;
use std::io::{self, ErrorKind, Write};
use std::os::fd::RawFd;

/// 一对已打开的 PTY 端：master 归 ptyd，slave 只活到 spawn。
pub struct PtyPair {
    pub master: RawFd,
    pub slave: RawFd,
    pub tty: String,
}

fn winsize(rows: u16, cols: u16) -> libc::winsize {
    libc::winsize {
        ws_row: rows,
        ws_col: cols,
        ws_xpixel: 0,
        ws_ypixel: 0,
    }
}

fn set_cloexec(fd: RawFd) -> io::Result<()> {
    // SAFETY: fd 是刚由 openpty 返回的有效描述符。
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
    if flags < 0 {
        return Err(io::Error::last_os_error());
    }
    if unsafe { libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

/// 本 PTY 从属端的设备路径（macOS `/dev/ttysNNN`、Linux `/dev/pts/N`）。supervisor 拿它做
/// `SSH_TTY`：程序可能真的去 stat/open 它，取不到宁可不注入也不编造。macOS 没有 `ptsname_r`，
/// `ptsname` 又是进程级静态缓冲，多线程不安全，故走 `TIOCPTYGNAME`；Linux 用 `ptsname_r`。
pub fn device_path(master: RawFd) -> Option<String> {
    let mut buffer = [0 as libc::c_char; 128];
    #[cfg(target_os = "macos")]
    // SAFETY: TIOCPTYGNAME 只把设备名写进调用方提供的 128 字节缓冲区（内核侧长度即 128）。
    let named = unsafe { libc::ioctl(master, libc::TIOCPTYGNAME as _, buffer.as_mut_ptr()) } == 0;
    #[cfg(not(target_os = "macos"))]
    // SAFETY: ptsname_r 只写入调用方缓冲区，且被显式告知其长度。
    let named = unsafe { libc::ptsname_r(master, buffer.as_mut_ptr(), buffer.len()) } == 0;
    if !named {
        return None;
    }
    // SAFETY: 成功返回即意味着 buffer 里是一个 NUL 结尾的 C 字符串。
    let path = unsafe { std::ffi::CStr::from_ptr(buffer.as_ptr()) }
        .to_str()
        .ok()?;
    (!path.is_empty()).then(|| path.to_string())
}

pub fn open(rows: u16, cols: u16) -> io::Result<PtyPair> {
    let mut master: RawFd = -1;
    let mut slave: RawFd = -1;
    let mut size = winsize(rows, cols);
    // SAFETY: 两个 out 参数是有效的 c_int，winsize 结构体完整初始化。
    let opened = unsafe {
        libc::openpty(
            &mut master,
            &mut slave,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut size,
        )
    };
    if opened != 0 {
        return Err(io::Error::last_os_error());
    }
    // 两端都 CLOEXEC：子进程只通过显式 dup2 拿到 slave，别的 session 的 master 绝不能泄漏进
    // 任何 shell（否则那个 shell 一天不退出，那个 PTY 就一天读不到 EOF）。
    if let Err(error) = set_cloexec(master).and_then(|_| set_cloexec(slave)) {
        // SAFETY: 两个 fd 都是我们刚打开的。
        unsafe {
            libc::close(master);
            libc::close(slave);
        }
        return Err(error);
    }
    let tty = device_path(master).unwrap_or_default();
    Ok(PtyPair { master, slave, tty })
}

pub fn resize(master: RawFd, rows: u16, cols: u16) -> io::Result<()> {
    let size = winsize(rows, cols);
    // SAFETY: master 有效；TIOCSWINSZ 只读取传入的 winsize。
    if unsafe { libc::ioctl(master, libc::TIOCSWINSZ as _, &size) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

pub fn close(fd: RawFd) {
    // SAFETY: 调用方保证 fd 归它所有且不再使用。
    unsafe {
        libc::close(fd);
    }
}

/// `argv[0]` 不含 `/` 时按 spec 自己的 PATH（缺省进程 PATH）解析，与 `execvp` 一致；解析发生在
/// fork 之前，子进程里只剩 async-signal-safe 调用。
fn resolve_program(program: &str, env: &[(String, String)]) -> io::Result<CString> {
    if program.contains('/') {
        return CString::new(program).map_err(|_| io::Error::new(ErrorKind::InvalidInput, "argv[0] 含 NUL"));
    }
    let path = env
        .iter()
        .find(|(key, _)| key == "PATH")
        .map(|(_, value)| value.clone())
        .or_else(|| std::env::var("PATH").ok())
        .unwrap_or_else(|| "/usr/bin:/bin".to_string());
    for dir in path.split(':') {
        let dir = if dir.is_empty() { "." } else { dir };
        let candidate = std::path::Path::new(dir).join(program);
        let executable = std::fs::metadata(&candidate)
            .map(|meta| {
                use std::os::unix::fs::PermissionsExt;
                meta.is_file() && meta.permissions().mode() & 0o111 != 0
            })
            .unwrap_or(false);
        if executable {
            return CString::new(candidate.to_string_lossy().into_owned())
                .map_err(|_| io::Error::new(ErrorKind::InvalidInput, "路径含 NUL"));
        }
    }
    Err(io::Error::new(
        ErrorKind::NotFound,
        format!("找不到可执行文件 {program}"),
    ))
}

/// 在 `slave` 上 fork/exec。父进程返回 pid（不关闭 slave，调用方负责）。
pub fn spawn(slave: RawFd, argv: &[String], env: &[(String, String)], cwd: &str) -> io::Result<i32> {
    let Some(program) = argv.first() else {
        return Err(io::Error::new(ErrorKind::InvalidInput, "argv 为空"));
    };
    let program = resolve_program(program, env)?;
    let args: Vec<CString> = argv
        .iter()
        .map(|arg| CString::new(arg.as_str()))
        .collect::<Result<_, _>>()
        .map_err(|_| io::Error::new(ErrorKind::InvalidInput, "argv 含 NUL"))?;
    let envs: Vec<CString> = env
        .iter()
        .map(|(key, value)| CString::new(format!("{key}={value}")))
        .collect::<Result<_, _>>()
        .map_err(|_| io::Error::new(ErrorKind::InvalidInput, "env 含 NUL"))?;
    let cwd = CString::new(cwd).map_err(|_| io::Error::new(ErrorKind::InvalidInput, "cwd 含 NUL"))?;
    let mut argv_ptrs: Vec<*const libc::c_char> = args.iter().map(|arg| arg.as_ptr()).collect();
    argv_ptrs.push(std::ptr::null());
    let mut env_ptrs: Vec<*const libc::c_char> = envs.iter().map(|entry| entry.as_ptr()).collect();
    env_ptrs.push(std::ptr::null());

    // SAFETY: fork 之后子进程只调用 async-signal-safe 的 libc 函数，所有字符串在 fork 前已准备好。
    let pid = unsafe { libc::fork() };
    if pid < 0 {
        return Err(io::Error::last_os_error());
    }
    if pid == 0 {
        // ---- 子进程 ----
        unsafe {
            libc::setsid();
            libc::ioctl(slave, libc::TIOCSCTTY as _, 0);
            libc::dup2(slave, 0);
            libc::dup2(slave, 1);
            libc::dup2(slave, 2);
            if slave > 2 {
                libc::close(slave);
            }
            // 兜底关掉 3.. 的一切：master、监听 socket、mmap 文件全是 CLOEXEC，这里只是防线。
            let max_fd = libc::sysconf(libc::_SC_OPEN_MAX);
            let max_fd = if max_fd <= 0 || max_fd > 4096 { 4096 } else { max_fd as i32 };
            let mut fd = 3;
            while fd < max_fd {
                libc::close(fd);
                fd += 1;
            }
            // 信号回到默认（ptyd 自己忽略了 SIGPIPE 等，shell 不该继承）。
            libc::signal(libc::SIGPIPE, libc::SIG_DFL);
            libc::signal(libc::SIGINT, libc::SIG_DFL);
            libc::signal(libc::SIGTERM, libc::SIG_DFL);
            libc::signal(libc::SIGHUP, libc::SIG_DFL);
            if libc::chdir(cwd.as_ptr()) != 0 {
                let message = b"coflux-ptyd: chdir failed\r\n";
                libc::write(2, message.as_ptr() as *const libc::c_void, message.len());
                libc::_exit(127);
            }
            libc::execve(program.as_ptr(), argv_ptrs.as_ptr(), env_ptrs.as_ptr());
            let message = b"coflux-ptyd: exec failed\r\n";
            libc::write(2, message.as_ptr() as *const libc::c_void, message.len());
            libc::_exit(127);
        }
    }
    Ok(pid)
}

/// SIGKILL 子进程；进程已不在时静默。
pub fn kill(pid: i32) {
    if pid > 0 {
        // SAFETY: 只对本进程 fork 出的 pid 发信号。
        unsafe {
            libc::kill(pid, libc::SIGKILL);
        }
    }
}

/// 阻塞等待子进程退出，返回与 supervisor 过去 `child.try_wait().exit_code()` 相同口径的退出码：
/// 正常退出取退出码，被信号杀死记 1（portable-pty 的口径），waitpid 失败记 -1。
pub fn wait(pid: i32) -> i32 {
    let mut status: libc::c_int = 0;
    loop {
        // SAFETY: status 是有效的 out 参数。
        let waited = unsafe { libc::waitpid(pid, &mut status, 0) };
        if waited == pid {
            break;
        }
        if waited < 0 {
            let error = io::Error::last_os_error();
            if error.kind() == ErrorKind::Interrupted {
                continue;
            }
            return -1;
        }
    }
    if libc::WIFEXITED(status) {
        libc::WEXITSTATUS(status)
    } else {
        1
    }
}

/// master fd 上的 `write(2)`。没有任何 Drop 副作用。
pub struct MasterWriter(pub RawFd);

impl Write for MasterWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        // SAFETY: buf 是有效切片；fd 由持有者保证存活。
        let written = unsafe { libc::write(self.0, buf.as_ptr() as *const libc::c_void, buf.len()) };
        if written < 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(written as usize)
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// 阻塞 `read(2)`：返回读到的字节数；0 或错误（EIO = slave 端全部关闭）表示流结束。
pub fn read(master: RawFd, buffer: &mut [u8]) -> Option<usize> {
    loop {
        // SAFETY: buffer 是有效可写切片。
        let count = unsafe { libc::read(master, buffer.as_mut_ptr() as *mut libc::c_void, buffer.len()) };
        if count > 0 {
            return Some(count as usize);
        }
        if count == 0 {
            return None;
        }
        let error = io::Error::last_os_error();
        if error.kind() == ErrorKind::Interrupted {
            continue;
        }
        return None;
    }
}

#[derive(Debug)]
pub struct PtyWriteFailure {
    pub written: usize,
    pub error: io::Error,
}

/// 不使用 `write_all`：错误里没有"已经写了多少"。显式维护 offset 后，partial failure 可以由
/// 调用方封死该 reservation 并终止 session，而不是让 client 从 byte 0 全量重投。
pub fn write_pty_input(writer: &mut dyn Write, data: &[u8]) -> Result<(), PtyWriteFailure> {
    let mut written = 0;
    while written < data.len() {
        match writer.write(&data[written..]) {
            Ok(0) => {
                return Err(PtyWriteFailure {
                    written,
                    error: io::Error::new(ErrorKind::WriteZero, "PTY writer 未推进"),
                });
            }
            Ok(length) if length <= data.len() - written => written += length,
            Ok(_) => {
                return Err(PtyWriteFailure {
                    written,
                    error: io::Error::new(ErrorKind::InvalidData, "PTY writer 返回越界长度"),
                });
            }
            Err(error) if error.kind() == ErrorKind::Interrupted => {}
            Err(error) => return Err(PtyWriteFailure { written, error }),
        }
    }
    Ok(())
}
