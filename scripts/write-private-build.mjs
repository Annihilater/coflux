#!/usr/bin/env node
// Write packages/cli/private-build.local.json from COFLUX_BUILD_PUBLIC_ORIGIN and COFLUX_BUILD_CA_FILE.
// Cargo and the desktop build read those variables themselves; this file is what the Node CLI reads.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const origin = (process.env.COFLUX_BUILD_PUBLIC_ORIGIN ?? "").replace(/\/+$/, "");
const caFile = process.env.COFLUX_BUILD_CA_FILE ?? "";
if (!origin || !caFile) {
  console.error("Set COFLUX_BUILD_PUBLIC_ORIGIN=https://<ip>:<port> and COFLUX_BUILD_CA_FILE=<ca.crt>.");
  process.exit(1);
}
let parsed;
try {
  parsed = new URL(origin);
} catch {
  console.error(`COFLUX_BUILD_PUBLIC_ORIGIN is not a URL: ${origin}`);
  process.exit(1);
}
if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
  console.error("COFLUX_BUILD_PUBLIC_ORIGIN must be https://<host>[:port] with no path, query, or credentials.");
  process.exit(1);
}
const caPem = readFileSync(caFile, "utf8");
if (!caPem.includes("BEGIN CERTIFICATE")) {
  console.error(`${caFile} is not a PEM certificate.`);
  process.exit(1);
}
const dest = join(dirname(fileURLToPath(import.meta.url)), "../packages/cli/private-build.local.json");
writeFileSync(dest, `${JSON.stringify({ origin: parsed.origin, caPem }, null, 2)}\n`, { mode: 0o644 });
console.log(`Wrote ${dest} for ${parsed.origin}`);
