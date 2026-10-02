// The launchd / systemd units cofluxd writes, as pure functions of the paths that go into them.
//
// Split out of cofluxd.mjs so the one thing that cannot be noticed by using the product can be
// asserted: whether the executor runtime made it into the unit. A missing variable there is silent
// — the daemon starts, everything works, and the only symptom is `coflux executor run` reporting
// much later that this machine has no executor host.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The two variables the runtime reads; kept identical to `packages/executor/src/env.ts` and
 * `crates/runtime/src/executor_host.rs`. */
export const EXECUTOR_NODE_ENV = "COFLUX_EXECUTOR_NODE";
export const EXECUTOR_ENTRY_ENV = "COFLUX_EXECUTOR_ENTRY";

/**
 * The runtime pair to record in the unit, or `null` when this installation cannot host an executor.
 *
 * It is `process.execPath` — the node that is running `cofluxd up` right now — plus the resolved
 * package entry, both absolute. Deliberately **not** a `PATH` lookup deferred to the daemon: a
 * launchd job's `PATH` is not the user's, and resolving `node` at start time would mean the
 * executor silently follows whatever version is installed later.
 *
 * `null` is an ordinary outcome, not an error: the desktop-bundled daemon ships Rust and Go
 * binaries and no JS runtime, and there Coflux.app hosts the executor instead.
 */
export function executorRuntime() {
  const node = process.execPath;
  if (!node?.startsWith("/")) return null;
  // Two known layouts, in the order they occur. Published: `prepack` bundles the executor next to
  // this file with esbuild (see package.json), because `@coflux/executor` is workspace-internal and
  // never published — the tarball carries the build output, not a registry dependency. Source
  // checkout: the workspace package's own `tsc` output. Neither present means this installation
  // cannot host an executor, which is an ordinary outcome.
  for (const candidate of ["./executor/host.js", "../executor/dist/host.js"]) {
    const entry = fileURLToPath(new URL(candidate, import.meta.url));
    if (entry.startsWith("/") && existsSync(entry)) return { node, entry };
  }
  return null;
}

/** Values interpolated into a plist are XML text; a path may legally contain `&` or `<`. */
function xml(value) {
  return String(value).replace(/[&<>]/g, (char) => (char === "&" ? "&amp;" : char === "<" ? "&lt;" : "&gt;"));
}

/**
 * A systemd `Environment=` value must be one line. A path containing a newline would otherwise turn
 * the rest of it into a directive of its own, so such a value is dropped rather than escaped —
 * a real install path never looks like that, and one that does means something is already wrong.
 */
function oneLine(value) {
  return !/[\n\r]/.test(String(value));
}

export function plistXml({ launcherBin, home, logFile, executor }) {
  const variables = [["COFLUX_HOME", home]];
  if (executor) {
    variables.push([EXECUTOR_NODE_ENV, executor.node], [EXECUTOR_ENTRY_ENV, executor.entry]);
  }
  const entries = variables
    .map(([key, value]) => `    <key>${xml(key)}</key><string>${xml(value)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.coflux.daemon</string>
  <key>ProgramArguments</key>
  <array><string>${xml(launcherBin)}</string></array>
  <key>EnvironmentVariables</key>
  <dict>
${entries}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xml(logFile)}</string>
  <key>StandardErrorPath</key><string>${xml(logFile)}</string>
</dict>
</plist>
`;
}

/**
 * ptyd (plan 20260918-ptyd-terminal-custody) runs under its own label: the launcher's SIGTERM
 * leaves sessions in ptyd, so `launchctl unload/load com.coflux.daemon` touches only the launcher
 * and its runtime, and KeepAlive brings ptyd back on its own if it crashes.
 */
export function ptydPlistXml({ ptydBin, home, logFile }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.coflux.ptyd</string>
  <key>ProgramArguments</key>
  <array><string>${xml(ptydBin)}</string></array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>COFLUX_HOME</key><string>${xml(home)}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xml(logFile)}</string>
  <key>StandardErrorPath</key><string>${xml(logFile)}</string>
</dict>
</plist>
`;
}

/**
 * systemd: ptyd has its own unit and the launcher's unit Requires/After it. `systemctl restart
 * coflux-daemon` restarts only the launcher's cgroup (runtime included); ptyd's is not part of it,
 * so terminals are untouched. Stopping ptyd (down) also stops the launcher (Requires).
 */
export function ptydSystemdUnit({ ptydBin, home }) {
  const environment = oneLine(home) ? `Environment=COFLUX_HOME=${home}\n` : "";
  return `[Unit]
Description=coflux ptyd (terminal custody)

[Service]
${environment}ExecStart=${ptydBin}
Restart=always
RestartSec=2
KillMode=process

[Install]
WantedBy=default.target
`;
}

export function systemdUnit({ launcherBin, home, executor }) {
  const variables = [["COFLUX_HOME", home]];
  if (executor) {
    variables.push([EXECUTOR_NODE_ENV, executor.node], [EXECUTOR_ENTRY_ENV, executor.entry]);
  }
  const environment = variables
    .filter(([, value]) => oneLine(value))
    .map(([key, value]) => `Environment=${key}=${value}`)
    .join("\n");
  return `[Unit]
Description=coflux daemon (launcher + runtime)
After=network-online.target coflux-ptyd.service
Wants=network-online.target
Requires=coflux-ptyd.service

[Service]
${environment}
ExecStart=${launcherBin}
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
`;
}
