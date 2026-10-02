//! The private launcher ↔ runtime channel (plan 20261002-runtime-launcher-merge).
//!
//! `coflux-launcher` spawns one `coflux-runtime`, hands it a per-spawn nonce and the path of a
//! 0600 UDS through the environment, and decides probation / commit / rollback from what it can
//! check *itself*: the runtime's echo of that nonce, ptyd's own session list against the set the
//! runtime reports as rebuilt, and a TCP connect to the gateway port the runtime reports. A
//! self-reported "ready" alone never commits anything.
//!
//! The same channel carries the runtime's switch requests after it downloaded and verified a
//! release (the runtime owns download and verification; the launcher owns the version pointer
//! and the remote release floor). Requests over this channel are remote-initiated by definition
//! and are bound by the floor; administrator switches arrive over `runtime.sock` instead.
//!
//! Wire shape: newline-delimited JSON, one request at a time per connection, replies in order.

use serde::{Deserialize, Serialize};

/// Path of the launcher's private UDS, set on every runtime the launcher starts.
pub const LAUNCHER_SOCK_ENV: &str = "COFLUX_LAUNCHER_SOCK";
/// Per-spawn nonce the runtime must echo in [`RuntimeToLauncher::Ready`].
pub const LAUNCHER_NONCE_ENV: &str = "COFLUX_LAUNCHER_NONCE";
/// `1` on every runtime started by a launcher: the only source of the launcher capability a
/// runtime advertises to the centre. A bare runtime started by hand never claims it.
pub const LAUNCHER_ENV: &str = "COFLUX_LAUNCHER";
/// The version string the launcher runs this runtime as (release tag, `builtin`, or a locally
/// registered test name); reported to the centre as `worker_version`.
pub const RUNTIME_VERSION_ENV: &str = "COFLUX_RUNTIME_VERSION";
/// The launcher's own compiled-in version; reported to the centre as `supervisor_version`.
pub const LAUNCHER_VERSION_ENV: &str = "COFLUX_LAUNCHER_VERSION";
/// Default socket file name under `COFLUX_HOME`.
pub const LAUNCHER_SOCK_NAME: &str = "launcher.sock";
/// Capability name a launcher-started runtime advertises to the centre; the centre pushes
/// `runtime` releases only to daemons that carry it. Same spelling as the TS constant.
pub const RUNTIME_LAUNCHER_CAPABILITY: &str = "runtime_launcher_v1";
/// Largest request / reply line on the channel.
pub const MAX_LAUNCHER_LINE_BYTES: usize = 256 * 1024;

/// runtime → launcher.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum RuntimeToLauncher {
    /// Sent once the runtime rebuilt every session from ptyd and knows its gateway port.
    /// `sessions` are the live session ids sessiond serves; `gateway_port` is `None` when the
    /// local gateway is disabled on this machine.
    Ready {
        nonce: String,
        sessions: Vec<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        gateway_port: Option<u16>,
    },
    /// Switch to `version`: either a release the runtime installed under
    /// `<COFLUX_HOME>/runtimes/<version>/` or a version already registered with the launcher.
    Switch { version: String },
}

/// launcher → runtime, one per request.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LauncherReply {
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// For `ready`: the committed remote release floor, so the runtime can refuse a downgrade or
    /// replay before paying for a download. The launcher re-checks on `switch` regardless.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub release_floor: Option<String>,
    /// For `ready`: the check failed on a transient condition (a session created while the
    /// report was in flight); the runtime may report again.
    #[serde(default)]
    pub retry: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ready_and_reply_are_camel_case_json_lines() {
        let ready = RuntimeToLauncher::Ready {
            nonce: "ab".into(),
            sessions: vec!["s1".into()],
            gateway_port: Some(8788),
        };
        let json = serde_json::to_string(&ready).unwrap();
        assert_eq!(json, r#"{"type":"ready","nonce":"ab","sessions":["s1"],"gatewayPort":8788}"#);
        let reply: LauncherReply = serde_json::from_str(r#"{"ok":true,"releaseFloor":"v1.2.3"}"#).unwrap();
        assert!(reply.ok);
        assert_eq!(reply.release_floor.as_deref(), Some("v1.2.3"));
        assert!(!reply.retry);
        let switch: RuntimeToLauncher = serde_json::from_str(r#"{"type":"switch","version":"v2.0.0"}"#).unwrap();
        assert!(matches!(switch, RuntimeToLauncher::Switch { version } if version == "v2.0.0"));
    }
}
