//! coflux-ptyd 二进制：起库形态的 ptyd，等 `shutdown` op 或 SIGTERM/SIGINT，然后结束全部子进程退出。
//!
//! 只由生命周期拥有者启动（桌面 app 与 supervisor 平级、或 cofluxd 生成的独立服务）；supervisor
//! 永不启动它。ptyd 收到 SIGTERM 就是"停止本机终端"——替换 supervisor 的路径不会给它发信号。
//! 版本：这里**没有** `COFLUX_RELEASE_VERSION`，只有协议版本；二进制身份由拥有者经
//! `COFLUX_PTYD_ID` 交下来（缺省 sha256 自身），否则"ptyd 没变"永远判不出来。

use std::path::PathBuf;
use std::sync::Arc;

use coflux_protocol::logln;
use coflux_protocol::ptyd::{PTYD_ID_ENV, PTYD_SOCK_ENV, PTYD_SOCK_NAME, PTYD_TEST_OPS_ENV, PTYD_V1_OPS};
use coflux_ptyd::{Ptyd, PtydConfig};
use sha2::{Digest, Sha256};

fn self_identity() -> String {
    std::env::current_exe()
        .ok()
        .and_then(|path| std::fs::read(path).ok())
        .map(|bytes| hex::encode(&Sha256::digest(&bytes)[..12]))
        .unwrap_or_else(|| "unknown".to_string())
}

fn main() {
    let home = std::env::var("COFLUX_HOME")
        .ok()
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| format!("{}/.coflux", std::env::var("HOME").unwrap_or_default()));
    let socket_path = std::env::var(PTYD_SOCK_ENV)
        .ok()
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(&home).join(PTYD_SOCK_NAME));
    let identity = std::env::var(PTYD_ID_ENV)
        .ok()
        .filter(|value| !value.is_empty())
        .unwrap_or_else(self_identity);
    let ops: Vec<String> = match std::env::var(PTYD_TEST_OPS_ENV) {
        Ok(raw) if !raw.trim().is_empty() => raw
            .split(',')
            .map(str::trim)
            .filter(|op| PTYD_V1_OPS.contains(op))
            .map(str::to_string)
            .collect(),
        _ => PTYD_V1_OPS.iter().map(|op| (*op).to_string()).collect(),
    };
    let config = PtydConfig {
        home: PathBuf::from(&home),
        socket_path: socket_path.clone(),
        identity,
        ops,
    };
    let ptyd = match Ptyd::start(config) {
        Ok(ptyd) => Arc::new(ptyd),
        Err(error) => {
            logln!("[ptyd] 启动失败：{error}");
            std::process::exit(1);
        }
    };
    logln!("[ptyd] listening {} instance={}", socket_path.display(), ptyd.instance_id());

    // SIGTERM/SIGINT = 停止本机终端：结束全部 shell 后退出。
    if let Ok(mut signals) = signal_hook::iterator::Signals::new([signal_hook::consts::SIGTERM, signal_hook::consts::SIGINT]) {
        let ptyd = Arc::clone(&ptyd);
        std::thread::spawn(move || {
            if signals.forever().next().is_some() {
                ptyd.request_shutdown();
            }
        });
    }
    ptyd.wait_for_shutdown();
    logln!("[ptyd] shutdown");
    ptyd.terminate();
    std::process::exit(0);
}
