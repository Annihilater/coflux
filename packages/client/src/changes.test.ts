/// <reference types="node" />

import assert from "node:assert/strict";
import test from "node:test";

import { ChangesWhitespace, create, DeviceChangesFileSchema, DeviceChangesListSchema, DeviceChangeStatus } from "@coflux/protocol";

import { toChangeFileResult, toChangesListResult } from "./changes";

/* Plan 20261001-changes-review-polish: a worker that predates the scope / whitespace fields decodes
 * the request, ignores the new field and answers as if it were absent. Only the echo tells. */

const listed = (fields: { ok?: boolean; error?: string; uncommitted?: boolean }) =>
  create(DeviceChangesListSchema, {
    requestId: "r",
    ok: fields.ok ?? true,
    error: fields.error,
    base: "abc",
    files: [{ path: "a.ts", status: DeviceChangeStatus.MODIFIED, additions: 2, deletions: 1, size: 10n }],
    uncommitted: fields.uncommitted ?? false,
  });

const file = (fields: { ok?: boolean; error?: string; whitespace?: ChangesWhitespace }) =>
  create(DeviceChangesFileSchema, {
    requestId: "r",
    ok: fields.ok ?? true,
    error: fields.error,
    oldExists: true,
    newExists: true,
    oldContent: "a\n",
    newContent: "  a\n",
    patch: "",
    whitespace: fields.whitespace ?? ChangesWhitespace.UNSPECIFIED,
  });

test("the branch scope never needs an echo, so old and new workers both answer it", () => {
  const result = toChangesListResult(listed({}), false);
  assert.ok(result.ok);
  assert.equal(result.base, "abc");
  assert.deepEqual(result.files, [{ path: "a.ts", oldPath: undefined, status: "modified", additions: 2, deletions: 1, binary: false, size: 10 }]);
});

test("asking for the uncommitted scope without an echo is an outdated daemon for that option", () => {
  const result = toChangesListResult(listed({ uncommitted: false }), true);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.daemonOutdated, true);
  assert.equal(result.outdatedOption, "uncommitted");

  const honoured = toChangesListResult(listed({ uncommitted: true }), true);
  assert.ok(honoured.ok, "a worker that echoes the scope is current");
});

test("a failed list reports its own error before the echo is considered", () => {
  const result = toChangesListResult(listed({ ok: false, error: "git 执行失败", uncommitted: false }), true);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error, "git 执行失败");
  assert.equal(result.daemonOutdated, false);
  assert.equal(result.outdatedOption, undefined);
});

test("a whitespace mode the echo does not match is an outdated daemon; a matching echo is used", () => {
  const stale = toChangeFileResult(file({}), "ignoreAll");
  assert.equal(stale.ok, false);
  if (!stale.ok) {
    assert.equal(stale.daemonOutdated, true);
    assert.equal(stale.outdatedOption, "whitespace");
  }

  // A worker that knows the field but not this level applies and echoes it as unspecified.
  const unknownLevel = toChangeFileResult(file({ whitespace: ChangesWhitespace.UNSPECIFIED }), "ignoreAtEol");
  assert.equal(unknownLevel.ok, false);

  // An added, deleted or binary file never runs git on the worker, yet a current worker still echoes.
  const current = toChangeFileResult(file({ whitespace: ChangesWhitespace.IGNORE_CHANGE }), "ignoreChange");
  assert.ok(current.ok);
  assert.equal(current.patch, "");

  const plain = toChangeFileResult(file({}), "show");
  assert.ok(plain.ok, "showing every change needs no echo");
});

test("a failed file read keeps its error even when the echo is missing", () => {
  const result = toChangeFileResult(file({ ok: false, error: "路径无效" }), "ignoreAll");
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error, "路径无效");
  assert.equal(result.daemonOutdated, false);
});
