import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createFileTabId,
  fileTabTitle,
  findFileTab,
  parseFileTabRecords,
  readFileTabRecords,
  restoreFileTabs,
  serializeFileTabRecords,
  writeFileTabRecords,
} from "./file-tabs";
import { FILE_TAB_PREFIX, createLayout, isFileTabId, isTaskTabId, layoutTabIds, reconcileLayout, revealTab } from "./terminal-layout";

const A = `${FILE_TAB_PREFIX}a`;
const B = `${FILE_TAB_PREFIX}b`;

test("file tab ids carry their prefix and nothing unsafe, and are not tasks", () => {
  assert.equal(createFileTabId("123e4567-e89b-12d3-a456-426614174000"), `${FILE_TAB_PREFIX}123e4567-e89b-12d3-a456-426614174000`);
  assert.equal(createFileTabId("a b/c"), `${FILE_TAB_PREFIX}abc`);
  assert.equal(isFileTabId(A), true);
  assert.equal(isTaskTabId(A), false);
  assert.equal(isTaskTabId("t1"), true);
});

test("reconcile keeps file tabs although they are not tasks — including on the first task list after a restore", () => {
  const layout = revealTab(createLayout(["t1", "t2"]), A);
  const next = reconcileLayout(layout, ["t1"]);
  assert.deepEqual(layoutTabIds(next), ["t1", A]);
  assert.equal(reconcileLayout(next, ["t1"]), next);
  assert.deepEqual(layoutTabIds(reconcileLayout(next, [])), [A]);
});

test("the same file of the same workspace is found by its canonical path", () => {
  const records = { [A]: { workspaceId: "w1", path: "src/a.ts" }, [B]: { workspaceId: "w2", path: "src/a.ts", line: 3 } };
  assert.equal(findFileTab(records, "w1", "src/a.ts"), A);
  assert.equal(findFileTab(records, "w2", "src/a.ts"), B);
  assert.equal(findFileTab(records, "w1", "src/b.ts"), null);
  assert.equal(fileTabTitle("crates/worker/src/ops.rs"), "ops.rs");
  assert.equal(fileTabTitle("README.md"), "README.md");
});

test("records round-trip and reject junk", () => {
  const records = { [A]: { workspaceId: "w1", path: "src/a.ts", line: 42 }, [B]: { workspaceId: "w2", path: "with space/b c.rs" } };
  const serialized = serializeFileTabRecords(records);
  assert.deepEqual(parseFileTabRecords(serialized), records);
  assert.deepEqual(parseFileTabRecords(null), {});
  assert.deepEqual(parseFileTabRecords("not json"), {});
  assert.deepEqual(parseFileTabRecords(JSON.stringify({ version: 2, tabs: records })), {});
  // A record missing its path, with an unsafe workspace id, or under a non-file id is skipped; a bad
  // line is dropped and the record kept.
  const mixed = JSON.stringify({
    version: 1,
    tabs: {
      [A]: { workspaceId: "w1", path: "src/a.ts", line: 42 },
      [B]: { workspaceId: "w2" },
      "screen-tab-x": { workspaceId: "w1", path: "src/a.ts" },
      [`${FILE_TAB_PREFIX}bad`]: { workspaceId: "has space", path: "src/a.ts" },
      [`${FILE_TAB_PREFIX}line`]: { workspaceId: "w1", path: "src/c.ts", line: -1 },
    },
  });
  assert.deepEqual(parseFileTabRecords(mixed), { [A]: records[A], [`${FILE_TAB_PREFIX}line`]: { workspaceId: "w1", path: "src/c.ts" } });
});

test("storage that throws reads as nothing and writes as false", () => {
  const throwing = { getItem: () => { throw new Error("no"); }, setItem: () => { throw new Error("no"); } };
  assert.deepEqual(readFileTabRecords({ storage: throwing, key: "k" }), {});
  assert.equal(writeFileTabRecords({ storage: throwing, key: "k" }, "{}"), false);
  const memory = new Map<string, string>();
  const store = { storage: { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => memory.set(key, value) }, key: "k" };
  assert.equal(writeFileTabRecords(store, serializeFileTabRecords({ [A]: { workspaceId: "w1", path: "a.ts" } })), true);
  assert.deepEqual(readFileTabRecords(store), { [A]: { workspaceId: "w1", path: "a.ts" } });
});

test("restore keeps a file tab only with a layout entry and a record for the same workspace", () => {
  const layouts = { w1: revealTab(createLayout(["t1"]), A), w2: revealTab(createLayout([]), B) };
  const records = {
    [A]: { workspaceId: "w1", path: "a.ts" },
    [B]: { workspaceId: "w9", path: "b.ts" },
    [`${FILE_TAB_PREFIX}orphan`]: { workspaceId: "w1", path: "c.ts" },
  };
  const restored = restoreFileTabs(layouts, records);
  assert.deepEqual(layoutTabIds(restored.layouts.w1!), ["t1", A]);
  assert.equal(restored.layouts.w1, layouts.w1, "an unchanged layout is the same object");
  assert.deepEqual(layoutTabIds(restored.layouts.w2!), [], "a layout entry without a matching record is dropped");
  assert.deepEqual(Object.keys(restored.records), [A], "a record no layout references is dropped");
});
