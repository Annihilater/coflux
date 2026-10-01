import assert from "node:assert/strict";
import { test } from "node:test";
import type { SecretRequestState } from "@coflux/client";

import {
  multilineSecretFromPaste,
  phaseAfterAnswer,
  secretRequestEntryEnded,
  secretRequestNameOf,
  secretRequestsForTask,
  SECRET_REQUEST_NOTIFY_PREFIX,
} from "./secret-request";

function request(requestId: string, taskId: string, name: string, createdAt = 1): SecretRequestState {
  return { requestId, daemonId: "d1", sessionId: `s-${taskId}`, taskId, name, reason: "why", createdAt, expiresAt: createdAt + 600_000 };
}

test("secret-request inbox messages are recognised by the worker's prefix and carry the NAME", () => {
  assert.equal(secretRequestNameOf(`${SECRET_REQUEST_NOTIFY_PREFIX}OPENAI_API_KEY — run the tests`), "OPENAI_API_KEY");
  assert.equal(secretRequestNameOf("Both approaches work; pick one"), null);
  assert.equal(secretRequestNameOf(`${SECRET_REQUEST_NOTIFY_PREFIX}`), null);
});

test("an inbox entry reads as ended once its terminal has no pending request for that NAME", () => {
  const pending = { r1: request("r1", "t1", "TOKEN") };
  const message = `${SECRET_REQUEST_NOTIFY_PREFIX}TOKEN — deploy`;
  assert.equal(secretRequestEntryEnded({ message, taskId: "t1" }, pending), false);
  assert.equal(secretRequestEntryEnded({ message, taskId: "t2" }, pending), true);
  assert.equal(secretRequestEntryEnded({ message: `${SECRET_REQUEST_NOTIFY_PREFIX}OTHER — x`, taskId: "t1" }, pending), true);
  assert.equal(secretRequestEntryEnded({ message: "plain notify", taskId: "t1" }, pending), null);
  assert.equal(secretRequestEntryEnded({ message, taskId: "t1" }, {}), true);
});

test("a terminal's cards are its own requests, oldest first", () => {
  const pending = {
    b: request("b", "t1", "B", 20),
    a: request("a", "t1", "A", 10),
    c: request("c", "t2", "C", 5),
  };
  assert.deepEqual(secretRequestsForTask(pending, "t1").map((item) => item.requestId), ["a", "b"]);
  assert.deepEqual(secretRequestsForTask(pending, "t3"), []);
});

test("the card closes on every acknowledgement except a refused value or a failed send", () => {
  assert.deepEqual(phaseAfterAnswer("provide", { status: "accepted" }), { kind: "closed", reason: "provided" });
  assert.deepEqual(phaseAfterAnswer("decline", { status: "accepted" }), { kind: "closed", reason: "declined" });
  assert.deepEqual(phaseAfterAnswer("cancel", { status: "accepted" }), { kind: "closed", reason: "cancelled" });
  assert.deepEqual(phaseAfterAnswer("provide", { status: "already_answered" }), { kind: "closed", reason: "answered_elsewhere" });
  assert.deepEqual(phaseAfterAnswer("provide", { status: "expired" }), { kind: "closed", reason: "expired" });
  assert.deepEqual(phaseAfterAnswer("provide", { status: "unknown_request" }), { kind: "closed", reason: "expired" });
  assert.equal(phaseAfterAnswer("provide", { status: "invalid" }).kind, "failed");
  const failed = phaseAfterAnswer("provide", { status: "failed", error: "Device request 超时" });
  assert.equal(failed.kind, "failed");
  assert.ok(failed.kind === "failed" && failed.error.includes("Device request 超时"));
});

test("a key copied with a trailing newline stays a single-line paste", () => {
  assert.equal(multilineSecretFromPaste("sk-abc123\n"), null);
  assert.equal(multilineSecretFromPaste("sk-abc123\n\n"), null);
});

test("a leading newline does not switch to multi-line", () => {
  assert.equal(multilineSecretFromPaste("\nsk-abc123"), null);
  assert.equal(multilineSecretFromPaste("\n\nsk-abc123\n"), null);
});

test("a trailing CRLF or lone CR does not switch to multi-line", () => {
  assert.equal(multilineSecretFromPaste("sk-abc123\r\n"), null);
  assert.equal(multilineSecretFromPaste("sk-abc123\r"), null);
  assert.equal(multilineSecretFromPaste("\r\nsk-abc123\r\n"), null);
});

test("text without any line break stays single-line", () => {
  assert.equal(multilineSecretFromPaste("sk-abc123"), null);
  assert.equal(multilineSecretFromPaste(""), null);
  assert.equal(multilineSecretFromPaste("\n"), null);
  assert.equal(multilineSecretFromPaste("\r\n\r\n"), null);
});

test("an inner newline switches to multi-line and keeps the trailing newline", () => {
  assert.equal(multilineSecretFromPaste("line one\nline two\n"), "line one\nline two\n");
  assert.equal(multilineSecretFromPaste("line one\nline two"), "line one\nline two");
  assert.equal(multilineSecretFromPaste("\nline one\nline two\n"), "\nline one\nline two\n");
});

test("inner CRLF and lone CR are normalized to LF and nothing else changes", () => {
  assert.equal(multilineSecretFromPaste("a\r\nb"), "a\nb");
  assert.equal(multilineSecretFromPaste("a\rb"), "a\nb");
  assert.equal(multilineSecretFromPaste("a\r\nb\rc\nd\r\n"), "a\nb\nc\nd\n");
  assert.equal(multilineSecretFromPaste("  a \t\r\n b  "), "  a \t\n b  ");
});

test("a PEM keeps every line and its trailing newline", () => {
  const pem = "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\nBBBB\n-----END OPENSSH PRIVATE KEY-----\n";
  assert.equal(multilineSecretFromPaste(pem), pem);
  assert.equal(multilineSecretFromPaste(pem.replace(/\n/g, "\r\n")), pem);
});
