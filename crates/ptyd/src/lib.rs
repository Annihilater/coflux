//! `coflux-ptyd`：持有 PTY 的长生进程（plan 20260918-ptyd-terminal-custody）。
//!
//! 生命周期与 supervisor 无关：supervisor 被替换、崩溃、重启，shell 都活在这里；ptyd 只做
//! `openpty` + fork/exec + 读循环 + 输出 ring + 输入写入/去重游标 + resize 日志 + 不透明 blob，
//! 通过 [`coflux_protocol::ptyd`] 的能力握手协议对外服务。它**必须**远离一切会变化的东西：
//! spawn_env、shell 集成、secret、sessiond、DeviceEnvelope、worker/中心的任何形状——ptyd 收到的
//! spec 已经完全解析（argv / env map / cwd / rows / cols），它一项都不解释。ptyd 的低变化率就是
//! 整个方案的资产：一个每次发版都变的 ptyd 什么都没买到。
//!
//! 库 + 薄二进制：supervisor 的单测在进程内起一个 [`Ptyd`] 跑真 PTY。

pub mod client;
mod pty;
mod ring;
mod server;

pub use client::{InputChannel, PtydClient, PtydError, PtydHello, PtydStatus, SubscriptionEvent, Written};
pub use pty::{write_pty_input, PtyWriteFailure};
pub use server::{Ptyd, PtydConfig};

#[cfg(test)]
mod tests;
