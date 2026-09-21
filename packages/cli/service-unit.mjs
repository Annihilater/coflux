// The launchd / systemd units cofluxd writes, as pure functions of the paths that go into them.
//
// Split out of cofluxd.mjs so the one thing that cannot be noticed by using the product can be
// asserted: whether the executor runtime made it into the unit. A missing variable there is silent
// — the daemon starts, everything works, and the only symptom is `coflux executor run` reporting
// much later that this machine has no executor host.
import { createRequire } from "node:module";

/** The two variables the worker reads; kept identical to `packages/executor/src/env.ts` and
 * `crates/worker/src/executor_host.rs`. */
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
export function executorRuntime(resolver = createRequire(import.meta.url)) {
  try {
    const entry = resolver.resolve("@coflux/executor/host");
    const node = process.execPath;
    if (!node?.startsWith("/") || !entry.startsWith("/")) return null;
    return { node, entry };
  } catch {
    return null;
  }
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

export function plistXml({ supervisorBin, home, logFile, executor }) {
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
  <array><string>${xml(supervisorBin)}</string></array>
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

export function systemdUnit({ supervisorBin, home, executor }) {
  const variables = [["COFLUX_HOME", home]];
  if (executor) {
    variables.push([EXECUTOR_NODE_ENV, executor.node], [EXECUTOR_ENTRY_ENV, executor.entry]);
  }
  const environment = variables
    .filter(([, value]) => oneLine(value))
    .map(([key, value]) => `Environment=${key}=${value}`)
    .join("\n");
  return `[Unit]
Description=coflux daemon (supervisor)
After=network-online.target
Wants=network-online.target

[Service]
${environment}
ExecStart=${supervisorBin}
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
`;
}
