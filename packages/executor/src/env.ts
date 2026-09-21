/**
 * The two environment variables that let a daemon start an executor host, fixed here so the three
 * sides that meet at them cannot drift: `packages/cli/cofluxd.mjs` writes them into the launchd /
 * systemd unit it generates, `crates/worker/src/executor_host.rs` reads them, and this package is
 * what they point at.
 *
 * They are an **absolute path pair**, deliberately. The alternative — having the worker look for
 * `node` on `PATH` — does not work: a launchd job's `PATH` is not the user's, and picking up
 * whichever version of node happens to be installed is how an executor becomes unreproducible. The
 * runtime that installed `cofluxd` is the runtime that runs the executor, and the unit records
 * which one that was.
 *
 * Absent variables are not an error. They mean this daemon has no JS runtime to host with — the
 * Coflux.app bundled-daemon case, where the app ships Rust and Go binaries and no node — and the
 * desktop hosts instead.
 */

/** Absolute path to the `node` executable that will run the host. */
export const EXECUTOR_NODE_ENV = "COFLUX_EXECUTOR_NODE";

/** Absolute path to this package's host entry point (`@coflux/executor/host`). */
export const EXECUTOR_ENTRY_ENV = "COFLUX_EXECUTOR_ENTRY";
