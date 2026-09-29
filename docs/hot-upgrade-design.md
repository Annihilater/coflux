# Automatic daemon hot-upgrade design (Option A)

> Status: implemented. The daemon consists of three Rust processes, `coflux-ptyd`, `coflux-supervisor` and `coflux-worker`, with no Node runtime. Worker upgrades support automatic downloads, dual ed25519 signature verification, persistent rollback prevention, observation-period switching, and crash rollback while preserving PTY/agent sessions. The supervisor is upgraded through `cofluxd update` + `cofluxd restart` (or the desktop's update action) as an ordinary stop/start: PTYs live in `coflux-ptyd`, so terminals keep running with their screens and scrollback intact across the replacement. cofluxd verifies every component against the same release trust root before installation and persistently rejects remote downgrades. Only a change to ptyd itself still ends terminals, through its own confirmed action.

## Client updates and runtime-component updates

Updating the desktop app restarts only its interface and account client. It reconnects to the existing `runtime.sock` without restarting the process that owns terminals. The CLI can be replaced atomically on its own. The runtime's worker and plugins live in stable version directories and do not disappear when the `.app` is replaced. When runtime artifacts change, the app offers deferred installation. Only an explicit user choice to restart local terminals ends live tasks and replaces runtime components. Linux CLI `update` likewise only prepares binaries; explicit `restart` interrupts terminals.

This is not live-process recovery: if `coflux-ptyd` (the PTY-owning process) or the operating system actually restarts, program memory is not guaranteed to survive. A supervisor restart is not that event any more.

## 1. Why split into three processes?

A PTY is a resource of the process that owns it. Putting networking, protocol handling, and PTYs in one frequently upgraded process would kill running shells/agents whenever its code is replaced. The split keeps three change rates apart: PTY custody (near zero), session authority (every release), transport (hot-swapped):

```text
┌────────────────────────────────────────────────────────────┐
│ coflux-ptyd (long-lived; lifetime independent of the rest)  │
│ · openpty + fork/exec of a fully resolved spec, TIOCSWINSZ, │
│   waitpid; bare write(2) input                              │
│ · per-session 4 MiB output ring indexed by byte offset,     │
│   never overwriting past the last checkpoint (stops reading)│
│ · input cursors, resize log, opaque checkpoint blob, status │
│ · v1 UDS protocol with a capability handshake               │
└──────────────────────▲─────────────────────────────────────┘
                       │ local UDS (ptyd protocol)
┌──────────────────────┴─────────────────────────────────────┐
│ coflux-supervisor (replaceable at will; crash-recoverable)  │
│ · sessiond: VT/history, holder/sequence, checkpoints        │
│ · UDS server for the worker                                │
│ · worker spawning/monitoring, versions, observation/rollback│
│ · downloads, dual signatures, SemVer rollback prevention    │
└──────────────────────▲─────────────────────────────────────┘
                       │ local UDS
                       │ control JSON + DeviceEnvelope frame
┌──────────────────────┴─────────────────────────────────────┐
│ coflux-worker (frequently upgraded)                         │
│ · center WS, authentication, reconnect, loopback gateway    │
│ · local/native transport, git/exec/fs, checkpoint               │
└──────────────────────▲─────────────────────────────────────┘
                       │ /daemon protobuf WS
                    Central server
```

When the worker crashes, upgrades, or disconnects from the center, the supervisor continues consuming PTY output from ptyd, advancing VT/history, and retaining sessiond's logical holder/sequence. The replacement worker rebuilds local/native channel transports. A transport never has authority to pause all PTYs.

When the supervisor is replaced or crashes, ptyd keeps reading each PTY into its ring (and stops reading rather than overwriting anything at or past the last checkpoint offset, so the shell pauses on the kernel buffer instead of losing output). The next supervisor enumerates ptyd's sessions, feeds each checkpoint blob, replays the ring from the checkpoint offset with the resize log applied at the recorded offsets, restores the input cursors, and only then starts the worker. `output_seq` is the ring's byte offset, so the rebuilt supervisor reproduces byte-identical sequence numbers and every client's `resume_from_seq` stays meaningful. Recovery is per session; a session whose blob or ring is unusable degrades alone. The worker restarts with the supervisor, so the device is briefly offline at the center. The ptyd protocol is a long-term compatibility contract: the hello advertises the ops the running ptyd implements, a supervisor treats a missing op as an unavailable capability, and v1 ops are never removed or changed, so a supervisor upgrade never requires a matching ptyd (and rolling back the supervisor works too). ptyd is started only by whoever owns the runtime lifecycle (the desktop app as a sibling of the supervisor, or the service that `cofluxd` generates); the supervisor never starts it and refuses to run without it, naming `cofluxd update` as the fix.

## 2. UDS and two-level reconciliation

UDS carries a length-prefixed record stream: control messages use JSON; data messages are distinguished by a frame-kind first byte. All terminal input/resize/output now live inside DeviceEnvelope and are adjudicated by sessiond. Legacy input/replay frame numbers 2/3 remain reserved but are rejected during decoding. Kind 1 only notifies the worker that a session checkpoint is dirty; it carries no raw PTY data.

Recovery after worker startup has two levels:

1. Connect to the supervisor and send `resync.request` to obtain live `SessionInfo(sessionId, taskId, pid)` records.
2. Establish/restore the central connection and report daemon resync plus the complete device catalog.
3. Rebuild the dirty-checkpoint set, local gateway, and native channels.
4. Clients reattach with a higher transport generation, retaining their logical holder and unacknowledged input.

A missing session does not automatically mean exit; sessiond tombstones/catalogs establish exit facts. The center does not kill unknown orphans because the worker or server restarted.

## 3. Upgrade flow

1. The release workflow builds supervisor/worker for four platforms and creates a schema 2 manifest. One ed25519 private key signs the raw worker binary and separate, domain-separated worker/supervisor release statements. Statements bind `version`, Rust `target`, raw 32-byte SHA-256, and artifact size exactly. The URL is only a download location and is not signed.
2. The server polls stable GitHub Releases. On daemon handshake or polling, a detected outdated version triggers `worker.upgrade {version,url,target,sha256,artifactSize,signature,releaseSignature}`.
3. The worker forwards the request to the supervisor over UDS.
4. The supervisor requires canonical strict SemVer and a matching local target, first rejecting downgrades/replays against local `worker.release-floor`. It then performs a bounded download to a temporary destination under `COFLUX_HOME/workers/` and checks signed size, SHA-256, the legacy raw signature, and the release-statement signature. Any mismatch deletes/rejects the candidate and preserves the current worker.
5. After successful verification, switch versions and begin the observation period. The new worker connects to UDS and completes both reconciliation levels; PTYs remain untouched throughout.
6. Repeated candidate crashes reaching the threshold during observation trigger automatic rollback. On stable completion, persist `worker.active`, then `worker.release-floor`, before committing. Pending candidates do not advance the floor. If a crash occurs between active and floor persistence, restart reconstructs the floor from the safely recovered active SemVer. Failure to persist the floor prevents commit and disables further remote upgrades.

Server pushes also have a per-daemon/version backoff cap to prevent repeated switching to the same bad version.

## 4. Security boundaries

- ed25519 separates permission to publish daemon binaries from control of the center or download source. Without the release private key, arbitrary bytes cannot impersonate a valid upgrade artifact. This is not isolation from central control-plane authority: an attacker controlling the center can still orchestrate existing exec/session capabilities. Do not describe signature verification as preventing RCE after central compromise. The public key is compiled into the supervisor and distributed in the cofluxd npm package; the private key exists only in a protected environment secret.
- Tests may inject a temporary public key through `COFLUX_WORKER_PUBKEY` because the trusted local party already controls the machine. A remote center cannot set the local environment, so this does not weaken the production threat model.
- Legacy raw signatures remain for older supervisors. New supervisors also require domain-separated release statements to prevent relabeling valid binaries with a different version, architecture, or size. Protobuf unknown-field handling and serde's ignored unknown fields allow rolling compatibility from newer servers/workers to older supervisors. New supervisors fail closed on raw-only requests.
- `worker.release-floor` uses strict SemVer precedence. Equal precedence, including differences only in build metadata, is rejected as replay. It constrains remote release requests only; the supervisor can still roll back internally to the previous active version, and local administrators remain responsible for switching known local versions.
- SHA-256 verifies manifest/transport integrity; dual signatures authenticate artifacts and release metadata. Every check must pass.
- Download failure, hash/signature mismatch, persistence failure, or a candidate crash must not damage the current worker or PTYs.
- Supervisor upgrades are an ordinary stop/start: the supervisor owns session authority but not the PTYs, and it rebuilds that authority from ptyd on start. They still go through explicit maintenance (`cofluxd update` then `cofluxd restart`, or the desktop's update action, which needs no confirmation and rolls back to the previous directory when the new supervisor fails to start). cofluxd verifies component-separated statements for every binary (worker, supervisor, cli, transport, ptyd), then replaces them from one staging generation. The greater of `cofluxd.release-floor` and `worker.release-floor` prevents a download source from replaying an older valid release. A change to ptyd itself is the one update that ends terminals; it is a separate, confirmed action (`cofluxd restart --ptyd`, the desktop's "update terminal component").
- ptyd's `terminal-data` files are the one place raw terminal output is persisted (everything that ever appeared in a terminal, while its session lives): the directory and files are `0600`, each file is unlinked when its session ends, stale files are swept at ptyd startup, the total is bounded by the live-session limit times the ring size, and the directory is excluded from backups. Weakening any of these is a product decision, not a cleanup.

## 5. Relationship to the local-first data plane

The upgrade design does not rely on the center replaying PTY data. In the final architecture:

- Raw PTY data is never sent to the center.
- Local and native paths carry the same DeviceEnvelope; holder/sequence authority resides in sessiond.
- Worker restarts rebuild channels/generations. Clients automatically resend unacknowledged input; sessiond deduplication ensures each effect occurs once.
- Output gaps trigger reattachment for a sessiond snapshot.
- Checkpoints are disposable derived state, coalesced per session, and never backpressure PTYs.

Worker replaceability and keeping the center out of the local terminal hot path are consequences of the same authority split.

## 6. Acceptance

The black-box harness launches real server, supervisor, and worker processes, isolated with temporary `COFLUX_HOME`:

- Killing the worker preserves PTYs; catalog/attach recover after restart.
- Switching to a valid new version commits after observation and preserves sessions.
- A candidate crash loop triggers automatic rollback and preserves sessions.
- Valid signatures allow remote-download upgrades.
- Tampering with SHA-256, size, version, target, or either signature must be rejected while retaining the current version.
- Committed versions continue rejecting downgrades and equal-precedence replays after supervisor restart.
- Local/native holder recovery, input ACK recovery, and output snapshot recovery during worker restarts produce no duplicate effects.

See [RELEASING.md](RELEASING.md) for release/key operations and [architecture.md](architecture.md) for the final authority/transport design.
