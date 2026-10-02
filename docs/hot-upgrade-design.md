# Automatic daemon hot-upgrade design

> Status: implemented (plan 20261002-runtime-launcher-merge). A device runs three Rust processes, `coflux-ptyd`, `coflux-launcher` and `coflux-runtime`, with no Node runtime. The **runtime** is the unit that gets updated: it holds sessiond (VT/history/holder/sequence authority, PTY environment assembly, shell integration) and everything the former worker did (centre connection, git/exec/fs, local gateway, native channels, executor host), and it talks to ptyd directly. The **launcher** is a small, rarely changing process that owns the version pointer, spawns the runtime, decides probation and commit, rolls back a crash-looping or pseudo-healthy candidate, falls back to the builtin runtime and serves `runtime.sock` / `runtime.lock`. Runtime updates — centre pushes included — rebuild sessiond from ptyd: terminals pause briefly, attached clients reattach (holders are reclaimed on reattach) and the create/stop de-duplication ledger is reset. Only a change to ptyd itself still ends terminals, through its own confirmed action.

## Client updates and runtime-component updates

Updating the desktop app restarts only its interface and account client; it reconnects to the existing `runtime.sock`, which the launcher keeps across runtime swaps. After an app update the app stages its bundled runtime and asks the running launcher to switch to it, with no click; when the bundled launcher itself changed, the app asks the old launcher to `leave` (terminals stay in ptyd) and starts the new one. On headless devices the centre pushes every runtime release automatically; `cofluxd update` / `cofluxd restart` are needed only when the launcher, ptyd or the CLI change, and `restart` keeps terminals.

This is not live-process recovery: if `coflux-ptyd` (the PTY-owning process) or the operating system actually restarts, program memory is not guaranteed to survive. A launcher or runtime restart is not that event.

## 1. Why three processes?

A PTY is a resource of the process that owns it. The split keeps three change rates apart: PTY custody (near zero), the launcher (rarely), the runtime (every release):

```text
┌────────────────────────────────────────────────────────────┐
│ coflux-ptyd (long-lived; lifetime independent of the rest)  │
│ · openpty + fork/exec of a fully resolved spec, TIOCSWINSZ, │
│   waitpid; bare write(2) input                              │
│ · per-session 4 MiB output ring indexed by byte offset,     │
│   never overwriting past the last checkpoint (stops reading)│
│ · input cursors, resize log, opaque checkpoint blob, status │
│ · v1 UDS protocol with a capability handshake               │
└──────────────▲───────────────────────────▲─────────────────┘
               │ ptyd protocol (full)      │ ptyd protocol (read-only list / kill on stop)
┌──────────────┴─────────────────────┐ ┌───┴──────────────────────────────────────────┐
│ coflux-runtime (the unit updated)  │ │ coflux-launcher (rarely changes)              │
│ · sessiond: VT/history, holder/seq,│ │ · version pointer (runtime.active), remote    │
│   checkpoints, PTY env, shell rc   │◄┤   release floor (runtime.release-floor)       │
│ · centre WS, loopback gateway,     │ │ · spawns the runtime with a per-spawn nonce   │
│   git/exec/fs, native channels     │ │ · probation: nonce echo + ptyd session list   │
│ · download + verify releases       │ │   + gateway TCP connect, then observation     │
│ · in-process sessiond bridge       │ │ · commit / rollback / builtin fallback        │
└──────────────▲─────────────────────┘ │ · runtime.sock / runtime.lock for the app     │
               │ /daemon protobuf WS    └───────────────────────────────────────────────┘
            Central server               private launcher ↔ runtime channel: launcher.sock
```

When the runtime crashes, is replaced or disconnects from the centre, ptyd keeps reading each PTY into its ring (and stops reading rather than overwriting anything at or past the last checkpoint offset). The next runtime enumerates ptyd's sessions, feeds each checkpoint blob, replays the ring from the checkpoint offset with the resize log applied at the recorded offsets, restores the input cursors, and only then starts its gateway and centre connection. `output_seq` is the ring's byte offset, so the rebuilt sessiond reproduces byte-identical sequence numbers and every client's `resume_from_seq` stays meaningful. Recovery is per session; a session whose blob or ring is unusable degrades alone. Ring replay pipelines several `read` requests on a dedicated ptyd connection, within the v1 protocol. The ptyd protocol is a long-term compatibility contract: the hello advertises the ops the running ptyd implements, the runtime treats a missing op as an unavailable capability, and v1 ops are never removed or changed, so a runtime upgrade never requires a matching ptyd. ptyd is started only by whoever owns the runtime lifecycle (the desktop app as a sibling of the launcher, or the service that `cofluxd` generates); neither the launcher nor the runtime ever starts it, and the runtime refuses to run without it, naming `cofluxd update` as the fix.

## 2. The sessiond bridge and reconciliation

Inside the runtime, sessiond and the rest of the process exchange length-prefixed records over two bounded in-process channels (`crates/runtime/src/sessiond_ipc.rs`): control records are JSON (`session.create`, `session.close`, `resync.request` / `resync.list`, `session.started` / `session.exit` / `session.command`), data records are binary frames (session-dirty notifications and DeviceEnvelope frames keyed by logical channel id). sessiond keeps its own bounded outbound queue per attachment; when a lifecycle record cannot be queued it cuts the attachment and the core re-attaches with a new generation and resyncs. There is no UDS hop on the terminal data path.

Recovery after a runtime start has two levels: sessiond's live snapshot first (`resync.list`), then the centre (`daemon.resync` plus the device catalog). A missing session does not mean exit; sessiond tombstones establish exit facts, and the centre never kills unknown orphans because the runtime or server restarted.

## 3. Upgrade flow

1. The release workflow builds launcher, runtime, CLI, transport and ptyd for four platforms and creates a schema 3 manifest. One ed25519 private key signs a domain-separated release statement per component (`coflux-runtime-release-v1`, `coflux-launcher-release-v1`, `coflux-cli-release-v1`, `coflux-transport-release-v1`, `coflux-ptyd-release-v1`), binding `version`, Rust `target`, raw 32-byte SHA-256 and artifact size exactly. There is no `worker` component and no raw-binary signature for any component. The URL is only a download location and is not signed.
2. The server polls stable GitHub Releases and parses schema 2 and 3. A schema 3 `runtime` is pushed only to daemons that advertise `runtime_launcher_v1` and are not desktop-managed; a schema 2 `worker` only to daemons without the launcher capability. The push reuses `worker.upgrade {version,url,target,sha256,artifactSize,releaseSignature,transport}`; the legacy `signature` field is ignored by the runtime.
3. The runtime requires canonical strict SemVer and a matching local target, refuses versions at or below the floor the launcher reported at `ready`, then performs a bounded download into `COFLUX_HOME/runtimes/<version>/` and checks signed size, SHA-256 and the release-statement signature (and the paired transport's). Any mismatch deletes the candidate. One download executor with a latest-only mailbox makes sure a slow old download never overtakes a newer request.
4. After atomic installation the runtime sends `switch {version}` over the private channel. The launcher re-validates the installed file, enforces the floor (strict precedence, equal precedence rejected; remote-initiated requests arrive only over this channel, administrator switches only over `runtime.sock` and are not floor-bound), kills the current runtime and spawns the candidate with a fresh nonce.
5. The candidate rebuilds every session from ptyd, binds its gateway and reports `ready {nonce, sessions, gatewayPort}`. The launcher independently checks that the nonce is this spawn's, that every live session in ptyd's own list is among the reported ones, and that the gateway port accepts a TCP connection; only then is the process healthy. A self-reported ready alone never commits; alive-but-silent, a wrong nonce, a session not taken over or a gateway that does not listen are terminated at the end of the observation period and counted against the crash budget.
6. Repeated candidate crashes reaching the threshold trigger rollback to the previous version (or the builtin). On stable completion the launcher persists `runtime.active`, then `runtime.release-floor`, before committing. Pending candidates do not advance the floor. On restart the persisted active is re-observed as a candidate first; one that cannot pass falls back to the builtin.

Server pushes also have a per-daemon/version backoff cap to prevent repeated switching to the same bad version.

## 4. Security boundaries

- ed25519 separates permission to publish daemon binaries from control of the centre or download source. Without the release private key, arbitrary bytes cannot impersonate a valid upgrade artifact. This is not isolation from central control-plane authority. The public key is compiled into the runtime and distributed in the cofluxd npm package; the private key exists only in a protected environment secret.
- Tests may inject a temporary public key through `COFLUX_WORKER_PUBKEY` because the trusted local party already controls the machine.
- The runtime artifact has its own statement domain and carries no raw-binary signature: no pre-plan supervisor can verify, install or run one through any path, and a runtime `releaseSignature` never verifies against the worker-domain statement built from identical metadata. Old `cofluxd` fails closed on schema 3, so a headless machine upgrades the npm package first.
- `runtime.release-floor` uses strict SemVer precedence and constrains remote requests only; the launcher can still roll back internally, and local administrators remain responsible for switching known local versions.
- Host capabilities (`runtime_launcher_v1`, `transport_pair_v1`, `desktop_managed`) come from launcher-provided environment, never from the runtime's code, so a bare runtime started outside a launcher claims none of them.
- Download failure, hash/signature mismatch, persistence failure, or a candidate crash must not damage the current runtime or the PTYs.
- ptyd's `terminal-data` files are the one place raw terminal output is persisted: the directory and files are `0600`, each file is unlinked when its session ends, stale files are swept at ptyd startup, the total is bounded by the live-session limit times the ring size, and the directory is excluded from backups. Weakening any of these is a product decision, not a cleanup.

## 5. Relationship to the local-first data plane

- Raw PTY data is never sent to the centre.
- Local and native paths carry the same DeviceEnvelope; holder/sequence authority resides in sessiond.
- A runtime restart rebuilds channels/generations; clients resend unacknowledged input and sessiond's ptyd-backed cursors ensure each effect occurs once across the swap.
- Output gaps trigger reattachment for a sessiond snapshot.
- Checkpoints are disposable derived state, coalesced per session, and never backpressure PTYs.

## 6. Acceptance

The black-box harness launches real server, ptyd, launcher and runtime processes, isolated with temporary `COFLUX_HOME` (`tests/src/worker-upgrade.test.mjs`, `signed-upgrade.test.mjs`, `ptyd-custody.test.mjs`):

- Switching to a valid new runtime commits after observation and preserves sessions.
- A candidate crash loop triggers automatic rollback and preserves sessions.
- Candidates that are alive but silent, connect but never report, echo a wrong nonce, report none of ptyd's live sessions, or report a gateway port that does not listen never commit.
- A restart with the pointer on a pseudo-healthy version ends on the builtin.
- Valid signatures allow remote-download upgrades; tampering with SHA-256, size, version, target or the statement signature, and a worker-domain statement over identical metadata, are rejected while retaining the current version.
- Committed versions continue rejecting downgrades and equal-precedence replays after a launcher restart.
- Replacing or killing the launcher keeps every shell, byte-identical sequence numbers and the screen.

See [RELEASING.md](RELEASING.md) for release/key operations and [architecture.md](architecture.md) for the final authority/transport design.
