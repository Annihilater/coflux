// Private-centre build overlay. A normal tree has no private-build.local.json and keeps the
// public defaults. `node scripts/write-private-build.mjs` writes the local file before packaging.
import tls from "node:tls";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function load() {
  const path = join(dirname(fileURLToPath(import.meta.url)), "private-build.local.json");
  if (!existsSync(path)) return { origin: "", caPem: "" };
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  const origin = typeof parsed.origin === "string" ? parsed.origin.replace(/\/+$/, "") : "";
  const caPem = typeof parsed.caPem === "string" ? parsed.caPem : "";
  return { origin, caPem };
}

export const { origin, caPem } = load();

if (caPem && typeof tls.setDefaultCACertificates === "function") {
  tls.setDefaultCACertificates([...tls.rootCertificates, caPem]);
}

/** `wss://<host>/daemon` when this build is tied to a private centre. */
export function daemonServer() {
  if (!origin) return "wss://api.coflux.yourantiandi.com/daemon";
  const url = new URL(origin);
  url.protocol = "wss:";
  url.pathname = "/daemon";
  url.search = "";
  url.hash = "";
  return url.toString();
}

/** `https://<host>` when this build is tied to a private centre. */
export function accountServer() {
  if (!origin) return "https://api.coflux.yourantiandi.com";
  const url = new URL(origin);
  url.protocol = "https:";
  url.pathname = "";
  url.search = "";
  url.hash = "";
  return url.origin;
}

export function tlsCa() {
  return caPem ? [...tls.rootCertificates, caPem] : undefined;
}
