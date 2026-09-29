# Plan 20260929-coflux-owned-stun: coflux's DERP region runs its own STUN instead of borrowing a personal one

> This plan is an outcome contract, not a step-by-step script. Understand the
> requirement and the recorded decisions, then design the implementation
> yourself against the live hosts and code. Run milestone validations as you go
> only if you are also the verifier — a delegated executor implements only, and
> verification happens outside its session. Stop on any STOP condition. When
> complete, update this plan in `wiki/plans/README.md`.
>
> Drift check: `git diff --stat 00a3fc26..HEAD -- docs/deployment.md transport/tailcat/go.mod apps/server/src/tailcat-rendezvous.ts tests/src/derp-harness.mjs`
> Host drift check (read-only): `ssh root@prod-bj 'systemctl cat coflux-derp derper | grep ExecStart -A10; ss -ulnp | grep -E ":347[89] "'` and `ssh root@prod-jp 'cat /etc/coflux/tailcat.env | grep -o "\"STUNPort\":[0-9]*"'`

## Status

- Priority: P2
- Effort: S
- Risk: MED — two production hosts are changed and the centre is restarted
- Depends on: none
- Category: dx (operations)
- Execution: self — departure check, 2026-09-29
- Stop after: implementation — departure check (plan audit, then autopilot)
- Plan review: audit — departure check
- Workspace: isolated — planned from the main worktree, moved to `.claude/worktrees/20260929-coflux-owned-stun` on `dev/20260929-coflux-owned-stun`
- Planned at: `00a3fc26`, 2026-09-29

## Requirement

Every coflux remote connection learns its public UDP endpoint through STUN
against the one private DERP region, 901 on prod-bj (`49.232.53.23`). Without
STUN a Tailcat node advertises only its interface addresses, so every pair not
on the same LAN silently stays on DERP relay — nothing errors, the sidebar just
shows 「中继连接」 forever.

The centre's `COFLUX_DERP_REGIONS` (prod-jp `/etc/coflux/tailcat.env`) advertises
`"STUNPort":3478` for that node. coflux's own `coflux-derp.service` runs with
`-stun=false`; UDP 3478 is actually answered by `derper.service`, the owner's
**personal Tailscale tailnet DERP** that happens to share the host. That was a
deliberate shortcut on 2026-09-12 (recorded in prod-bj
`/opt/coflux-derp/README.md`) and is now an undocumented cross-project
dependency: stopping, moving or re-porting the personal DERP degrades every
coflux direct path to relay with no signal anywhere.

Done means: coflux's advertised STUN endpoint is served by a coflux-owned
process that nothing else depends on, the centre advertises it, production
traffic has visibly moved to it, and the ownership and a one-line diagnosis are
written down where the next operator will look. The personal `derper.service`
is no longer referenced by any coflux configuration and is left exactly as it
is.

This investigation (2026-09-29) also established facts the executor should not
re-derive: STUN via 3478 works today from Beijing and from prod-jp; Home's NAT is
endpoint-independent; Home↔Debian is already direct over the LAN; Home↔Bytedance
Work cannot be direct (the office NAT varies its egress IP per destination, and
the owner's real Tailscale falls back to a Peer Relay for the same pair). This
plan does **not** try to make more pairs direct; it removes a hidden dependency.

## Decisions & tradeoffs

- **STUN comes from a dedicated `coflux-stun.service` running upstream `stund`**,
  built from the same pinned `tailscale.com` revision as `transport/tailcat/go.mod`
  (currently `v1.103.0-pre.0.20260904030409-31d8badb3bfb`) with Go 1.27.1 and
  `CGO_ENABLED=0`, installed next to the existing binary in `/opt/coflux-derp/`.
  Rejected: turning on `-stun` in `coflux-derp` — derper binds STUN to the IP of
  its `-a` flag and `coflux-derp` listens on `127.0.0.1:8444` behind Caddy, so
  its STUN would be loopback-only; derper also starts STUN in a goroutine that
  discards the listen error, so a bind failure would be silent too. Rejected:
  changing `coflux-derp -a` to a public address — publishes the TLS backend
  beside Caddy just to get STUN, and still swallows STUN bind errors. Rejected:
  giving 3478 to coflux and moving the personal DERP — its port is baked into
  the owner's tailnet DERP map, outside this repository.
  Based on: `derper -help` (`-stun-port … bound to the same IP (if any) as
  specified in the -a flag`); `tailscale.com/cmd/derper/derper.go:185-186`
  (`go ss.ListenAndServe(...)`, error dropped); `tailscale.com/cmd/stund/stund.go`
  (`log.Fatal` on STUN listen failure); `go build -mod=readonly tailscale.com/cmd/stund`
  succeeds in `transport/tailcat` with the current `go.sum` (checked 2026-09-29).

- **Port: UDP 3479 on all addresses; stund's debug HTTP bound to loopback.**
  stund's `-http` default is `:3479` on **all** interfaces (TCP) and exposes
  `/debug`; it must be pointed at `127.0.0.1:<free port>` (executor picks a port
  not in `ss -tlnp` on prod-bj). The STUN port is not the executor's call: 3479
  is what goes into the region. Rejected: any port shared with another service.

- **The region keeps `RegionID` 901 and every other field; only the node's
  `STUNPort` changes 3478 → 3479.** The centre reads `COFLUX_DERP_REGIONS` once
  at start (`apps/server/src/tailcat-rendezvous.ts:13`), so the change takes
  effect only on a `coflux-server` restart; the departure check authorised
  restarting it in this plan (clients and daemons reconnect on their own; worker
  control loss retires the serving helper, so each new serving epoch picks up the
  new region). Rejected: waiting for the next deployment — the switch could not
  be verified.

- **No product-code STUN health check.** Rejected: adding a STUN probe to the
  helper's `health` or worker logs — there is nothing to act on (STUN loss must
  not rotate a DERP region whose relay works), upstream Tailscale degrades just as
  silently, and the repository's test policy (`AGENTS.md`, "Do not grow this back
  by habit") argues against a check for something visible by running one command.
  The remedy for "no signal" is ownership plus a documented diagnosis command.

- **The personal `derper.service` and its UDP 3478 are not touched** — no stop,
  restart, config edit, or firewall change. It stays the implicit rollback target.

- **The stund invocation is fixed; the rest of the unit is the executor's call.**
  `ExecStart=/opt/coflux-derp/stund -stun :3479 -http 127.0.0.1:<port>` — both
  flags are mandatory (without `-stun` it binds 3478, collides with the personal
  derper and crash-loops on `log.Fatal`). `Restart=always` with `RestartSec=3`
  (as `coflux-derp`, so a bad bind does not hit systemd's start limit), enabled
  for boot, no secrets, hardening comparable to `coflux-derp`; running
  unprivileged is fine since 3479 is not a privileged port. (revised on plan audit)

## Direction

Three milestones, strictly sequential: the centre must not advertise a port
nothing answers, and the docs record what actually got deployed. Do not fan out.

### Milestone 1: coflux-owned STUN answers on 49.232.53.23:3479

`coflux-stun.service` is running and enabled on prod-bj, serving the pinned
`stund` on UDP 3479, debug HTTP on loopback only; `derper.service` and
`coflux-derp.service` PIDs are unchanged.
Validation (acceptance, run by whoever verifies):
- `ssh root@prod-bj 'ss -ulnp | grep ":3479 "; ss -tlnp | grep stund'` → UDP 3479 on `*`, the TCP debug port on `127.0.0.1` only. stund drops its HTTP listen error, so the TCP line is the only proof the debug port bound.
- `journalctl -u coflux-stun` shows stund's STUN listening line and no restarts.
- A probe run **on prod-bj** and a probe from outside are recorded separately: local OK + external timeout = Tencent Cloud security group → STOP.
- From outside prod-bj (this Mac and prod-jp): a **Tailscale-format** STUN request to `49.232.53.23:3479` returns a mapped address. Build `tailscale.com/cmd/stunc` from `transport/tailcat` (`go build -mod=readonly`) and run `stunc 49.232.53.23 3479`.
- Before/after PIDs of `derper` and `coflux-derp` are identical.

### Milestone 2: the centre advertises 3479 and live traffic uses it

prod-jp's `/etc/coflux/tailcat.env` has `"STUNPort":3479` (backup of the old file
kept beside it), `coflux-server` restarted, and the centre healthy.
Validation (acceptance):
- `curl -fsS localhost:8787/health` on prod-jp → 200; `coflux device list` shows every device that was online before the restart online again within a few minutes.
- stund's counters prove coflux moved, **measured correctly** (revised on plan audit): the counter counts every valid STUN request, including the executor's own `stunc` probes, and magicsock stops periodic re-STUN when a node has no active peers, so post-restart traffic is a one-off step (about one or two requests per online daemon), not steady growth. Read `/debug/varz` as a baseline after all Milestone 1 probes and before the restart; run no `stunc` afterwards; read it again about a minute after the restart and require an increase of at least the number of online daemons. For attribution, `tcpdump -ni any udp port 3479 -c 20` on prod-bj (read-only) shows the source IPs, which map to the devices (Home and Debian leave as `219.143.180.202`).
- Regression only, not proof of the switch (LAN direct paths use interface addresses, not STUN): Home ↔ Debian is still direct — on Home, `nettop -L 1 -n -m udp -p <pid of Coflux.app/Contents/Resources/daemon/coflux-transport>` shows a UDP socket on the physical interface (`en5`) with traffic in both directions.

### Milestone 3: the ownership is written down

`docs/deployment.md` (prod-bj section) states that coflux's STUN is
`coflux-stun.service` on UDP 3479, that UDP 3478 belongs to the personal
`derper.service` and must not reappear in `COFLUX_DERP_REGIONS`, why
`coflux-derp` cannot serve STUN itself (loopback `-a`), and the one-line
diagnosis (`stunc 49.232.53.23 3479` from any machine, plus the varz counter).
Runbook step 2 in the same file gains one clause warning that derper's STUN
follows its `-a` address. prod-bj `/opt/coflux-derp/README.md` gets a dated
section recording the same change (append; do not rewrite its history), and so
does its copy on prod-jp, `/etc/coflux/README-tailcat-bj.md`, which still says
"STUN port 3478" (revised on plan audit).
Validation: `grep -n "coflux-stun" docs/deployment.md` → at least one hit in the
prod-bj section; `ssh root@prod-bj 'grep -n coflux-stun /opt/coflux-derp/README.md'` → hit.

## Landmines

- **derper's STUN follows `-a`**, and `coflux-derp` is `-a 127.0.0.1:8444` behind
  Caddy's `derp.yourantiandi.com` block (prod-bj `/etc/caddy/Caddyfile` ~line 86).
  Do not "fix" this by editing Caddy or `coflux-derp`.
- **stund's default debug listener is `:3479` TCP on every interface.** Forgetting
  `-http` publishes `/debug` publicly on the same number as the STUN port.
- **A plain RFC 5389 binding request is silently ignored** by Tailscale's STUN
  server (it requires the `tailnode` SOFTWARE attribute and FINGERPRINT). Test
  with `stunc` or `tailscale.com/net/stun`; a python/nc probe "timing out" proves
  nothing.
- **Surge on this Mac hijacks DNS** into `198.18.x.x` fake IPs; probe by literal
  IP, not hostname.
- **Tencent Cloud security group**: not inspected. UDP to a high port on prod-bj
  answered from this Mac on 2026-09-29, and UDP 3478 is reachable, so 3479 is
  expected to be open — if Milestone 1's external probe fails while prod-bj's
  local probe succeeds, that is the security group: STOP (it needs the console).
- **`tailcat.env` holds the region as a single-quoted JSON string** parsed by
  systemd `EnvironmentFile`; edit only the port digits and keep the quoting.
  After the restart, confirm `/proc/<new pid>/environ` contains `"STUNPort":3479`.
  `server.env` next to it holds secrets: never print it.
- **`pkill -f <pattern>` over ssh matches its own command line** and can kill the
  ssh session; prefer `systemctl` for everything here.
- **Cert renewal restarts `coflux-derp`** (`coflux-derp-cert.path` → `try-restart`).
  If its PID changed, check `journalctl -u coflux-derp-cert` before judging it a
  plan violation.
- **One transient desktop error after the centre restart is expected**:
  `apps/desktop/src/main/tailcat-transport.ts:118-124` caches a connection per
  daemon with its first address, and the helper refuses a changed address for
  the same connection (`transport/tailcat/internal/backend/backend.go:172-173`,
  `connection address changed`) until the old lane closes. Every centre restart
  does this; it is not a STUN fault.
- **Cross-border UDP**: prod-jp → prod-bj STUN may time out for reasons unrelated
  to this change (see prod-bj README, "Corrected probes from owo-jp-gw still
  timed out"). Compare against 3478 from the same host before concluding.

## Scope

In scope:
- prod-bj: new `/opt/coflux-derp/stund` binary, new `coflux-stun.service` unit, append to `/opt/coflux-derp/README.md`
- prod-jp: `/etc/coflux/tailcat.env` (STUNPort only), one `coflux-server` restart, append to `/etc/coflux/README-tailcat-bj.md`
- `docs/deployment.md`
- `wiki/plans/20260929-coflux-owned-stun.md`, `wiki/plans/README.md`

Out of scope:
- `derper.service`, its keys and UDP 3478 — the owner's personal tailnet
- `coflux-derp.service` flags, Caddy — see Landmines
- `transport/tailcat/**`, `crates/**`, `apps/**` — no product code changes (Decision: no health check)
- `transport/tailcat/go.mod` — stund already builds from the current module graph; adding a `tool` line is not needed
- `tests/src/derp-harness.mjs` — fixtures run `-stun=false` with `STUNPort:-1` on loopback and are unaffected
- Making more device pairs direct (Peer Relay–style UDP relay) — separate topic

## Commands

| Purpose | Command | Expected result |
| --- | --- | --- |
| Build stund (linux/amd64) | `cd transport/tailcat && GOTOOLCHAIN=go1.27.1 CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -mod=readonly -o <tmp>/stund tailscale.com/cmd/stund` | exit 0 |
| Build stunc (host) | `cd transport/tailcat && CGO_ENABLED=0 go build -mod=readonly -o <tmp>/stunc tailscale.com/cmd/stunc` | exit 0 |
| External STUN probe (acceptance) | `<tmp>/stunc 49.232.53.23 3479` | prints a mapped address |
| Centre health (acceptance) | `ssh root@prod-jp 'curl -fsS localhost:8787/health'` | 200 |
| Devices back (acceptance) | `coflux device list` | same devices online as before |
| stund counters (acceptance) | `ssh root@prod-bj 'curl -fsS 127.0.0.1:<debug port>/debug/varz \| grep stun'` | request counters growing |

Temporary binaries go in a `mktemp -d` directory outside the repository and are
removed afterwards; nothing built lands in the worktree.

## Done criteria

- [ ] All listed commands pass.
- [ ] `49.232.53.23:3479` answers Tailscale STUN from outside prod-bj, served by `coflux-stun.service` (enabled, `Restart=always`).
- [ ] stund's debug HTTP listens on loopback only.
- [ ] The centre runs with `"STUNPort":3479`, is healthy, and stund's counters show coflux traffic.
- [ ] `derper.service` and `coflux-derp.service` were not restarted or edited (PIDs unchanged, or a `coflux-derp` change explained by a cert-renewal entry).
- [ ] `docs/deployment.md` and prod-bj's README record the ownership and the diagnosis command.
- [ ] Implementation follows every entry in Decisions & tradeoffs.
- [ ] No out-of-scope files changed; no temporary files left in the repo or on either host.
- [ ] `wiki/plans/README.md` status is updated.

## STOP conditions

- A fact cited under Decisions & tradeoffs no longer holds (e.g. `coflux-derp` no longer uses a loopback `-a`, the pinned revision changed, or `STUNPort` is no longer 3478).
- UDP 3479 answers on prod-bj locally but not from outside (security group) — needs the cloud console.
- The centre does not return to health, or devices do not come back, within ten minutes of the restart — roll `tailcat.env` back from the backup, restart once more, and report.
- Anything would require touching `derper.service`, Caddy, or `coflux-derp`.
- A validation fails twice after one reasonable fix.

## Rollback

Restore `/etc/coflux/tailcat.env` from its backup (3478 is still served by the
personal DERP) and restart `coflux-server`; `systemctl disable --now coflux-stun`
afterwards if the unit itself is at fault.

## Maintenance notes

- Bumping the Tailcat pin in `transport/tailcat/go.mod` should rebuild both
  `derper` and `stund` on prod-bj from the same revision.
- Plan audit (fable, 2026-09-29) confirmed the region propagation chain (centre
  reads the env once, worker `close_all` on every new control connection, the
  Tailcat address carries `STUNPort`, no disk cache on either side). Not adopted:
  an optional before/after check of Home ↔ Devbox SG — that pair is cross-border
  and relayed today, so it could not show a switch.
- Adding a second DERP region: give it its own STUN in the same way; never point
  `STUNPort` at a service coflux does not own.
