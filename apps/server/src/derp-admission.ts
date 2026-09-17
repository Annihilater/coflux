import { timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";

/** The smallest route that can be public. Stock `derper` calls a verifier over plain HTTP with no
 * way to send a header or a client certificate (`-verify-client-url` takes a URL and nothing else),
 * so the shared secret lives in the path and the reverse proxy in front of this listener supplies
 * TLS. The listener still binds loopback only: it is the proxy that is public, not this socket, and
 * the rest of the application's routes stay on their own port either way.
 *
 * Why not keep it unreachable and tunnel to it: an SSH tunnel pins the centre's address inside a
 * relay host's unit file, and on 2026-09-17 the centre changed IP — the tunnel died, every DERP
 * admission failed closed, and every remote device in the account went dark for hours while the
 * control plane looked perfectly healthy. A name resolved per request survives that; a hard-coded
 * host:port in a systemd unit on another machine does not. */
const ADMISSION_PREFIX = "/derp-verify/";

/** Constant-time compare that does not leak the secret's length through an early return. */
function secretMatches(candidate: string, expected: string): boolean {
  const a = Buffer.from(candidate, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * @param token Shared secret placed in the request path by the caller. When empty the listener keeps
 * its loopback-only contract and answers `/verify` unauthenticated — the shape a local fixture and a
 * same-host derper use. A non-empty token switches the route to `/derp-verify/<token>` and nothing
 * else is accepted, so a public deployment has exactly one reachable path and it carries the secret.
 */
export function startDerpAdmission(admitted: (node: string) => boolean, port: number, token = ""): Server {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid DERP admission port");
  if (token && token.length < 32) throw new Error("DERP admission token must be at least 32 characters");
  const server = createServer({ requestTimeout: 2000, headersTimeout: 2000, maxHeaderSize: 4096 }, (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    const reject = () => { if (!response.writableEnded) { response.writeHead(403, { "Content-Type": "application/json" }); response.end('{"Allow":false}'); } };
    const url = request.url ?? "";
    // Authorised the same way whether or not a proxy is in front: the path is the credential, and an
    // unauthenticated `/verify` stops existing the moment a token is configured.
    const authorised = token
      ? url.startsWith(ADMISSION_PREFIX) && secretMatches(url.slice(ADMISSION_PREFIX.length), token)
      : url === "/verify";
    if (request.method !== "POST" || !authorised) { reject(); request.resume(); return; }
    let bytes = 0;
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > 1024) { reject(); request.destroy(); return; } chunks.push(chunk); });
    request.on("end", () => {
      if (response.writableEnded) return;
      let allowed = false;
      try { const body = JSON.parse(Buffer.concat(chunks).toString("utf8")); allowed = typeof body.NodePublic === "string" && admitted(body.NodePublic); } catch { /* Reject malformed verifier requests. */ }
      response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify({ Allow: allowed }));
    });
    request.on("error", reject);
  });
  server.maxConnections = 64;
  server.listen(port, "127.0.0.1");
  return server;
}
