// Compile-time private centre. electron-vite replaces the two globalThis reads from
// COFLUX_BUILD_PUBLIC_ORIGIN and COFLUX_BUILD_CA_FILE. Unit tests leave them unset.
import { X509Certificate } from "node:crypto";
import { join } from "node:path";
import tls from "node:tls";
import type { Session } from "electron";
import type { DaemonHomePaths } from "./daemon-paths";

declare global {
  var __COFLUX_BUILD_ORIGIN__: string | undefined;
  var __COFLUX_BUILD_CA_PEM__: string | undefined;
}

export function privateOrigin(): string {
  const value = globalThis.__COFLUX_BUILD_ORIGIN__;
  return typeof value === "string" ? value.replace(/\/+$/, "") : "";
}

export function privateCaPem(): string {
  const value = globalThis.__COFLUX_BUILD_CA_PEM__;
  return typeof value === "string" ? value : "";
}

/** Packaged desktop default, `wss://<host>/client`. Undefined keeps the public server. */
export function privateClientUrl(): string | undefined {
  const origin = privateOrigin();
  if (!origin) return undefined;
  const url = new URL(origin);
  url.protocol = "wss:";
  url.pathname = "/client";
  url.search = "";
  url.hash = "";
  return url.toString();
}

/**
 * A private build keeps its daemon in ~/.coflux-private so it never adopts or stops a public
 * install's ~/.coflux and com.coflux.daemon LaunchAgent on the same Mac. An explicit COFLUX_HOME wins.
 */
export function privateDaemonEnv(env: NodeJS.ProcessEnv, homeDir: string): NodeJS.ProcessEnv {
  if (!privateOrigin() || env.COFLUX_HOME?.trim()) return env;
  return { ...env, COFLUX_HOME: join(homeDir, ".coflux-private") };
}

export function privateDaemonPaths(paths: DaemonHomePaths, homeDir: string): DaemonHomePaths {
  if (!privateOrigin()) return paths;
  return { ...paths, plist: join(homeDir, "Library", "LaunchAgents", "com.coflux.private.daemon.plist") };
}

export function wsCaOption(): { ca?: string[] } {
  const pem = privateCaPem();
  return pem ? { ca: [...tls.rootCertificates, pem] } : {};
}

/** Node fetch and tls in the main process. Chromium sockets are handled separately. */
export function installNodeTrust(): void {
  const pem = privateCaPem();
  if (!pem) return;
  const setDefault = (tls as typeof tls & { setDefaultCACertificates?: (certs: readonly string[]) => void }).setDefaultCACertificates;
  if (!setDefault) throw new Error("This Node build cannot install a private CA.");
  setDefault([...tls.rootCertificates, pem]);
}

/** Trust the baked CA for the private centre's host, and leave every other host to Chromium. */
export function installChromiumTrust(ses: Session): void {
  const pem = privateCaPem();
  const origin = privateOrigin();
  if (!pem || !origin) return;
  const ca = new X509Certificate(pem);
  const host = new URL(origin).hostname;
  ses.setCertificateVerifyProc((request, callback) => {
    if (request.hostname !== host) {
      callback(-3);
      return;
    }
    try {
      const leaf = new X509Certificate(request.certificate.data);
      if (leaf.verify(ca.publicKey)) {
        callback(0);
        return;
      }
    } catch {
      // The leaf was not PEM, or the key could not be checked. Chromium's result stands.
    }
    callback(-3);
  });
}
