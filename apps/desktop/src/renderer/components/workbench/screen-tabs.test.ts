import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createScreenSessionId,
  createScreenTabId,
  parseScreenTabRecords,
  readScreenTabRecords,
  restoreScreenTabs,
  serializeScreenTabRecords,
  writeScreenTabRecords,
} from "./screen-tabs";
import { SCREEN_TAB_PREFIX, createLayout, isScreenTabId, isTaskTabId, layoutTabIds, reconcileLayout, revealTab } from "./terminal-layout";

const A = `${SCREEN_TAB_PREFIX}a`;
const B = `${SCREEN_TAB_PREFIX}b`;

test("screen tab and session ids carry their prefixes and nothing unsafe", () => {
  assert.equal(createScreenTabId("123e4567-e89b-12d3-a456-426614174000"), `${SCREEN_TAB_PREFIX}123e4567-e89b-12d3-a456-426614174000`);
  assert.equal(createScreenTabId("a b/c"), `${SCREEN_TAB_PREFIX}abc`);
  assert.equal(createScreenSessionId("x y"), "scr-xy");
  assert.equal(isScreenTabId(A), true);
  assert.equal(isTaskTabId(A), false);
  assert.equal(isTaskTabId("browser-tab-1"), false);
  assert.equal(isTaskTabId("t1"), true);
});

test("reconcile keeps screen tabs although they are not tasks", () => {
  const layout = revealTab(createLayout(["t1", "t2"]), A);
  const next = reconcileLayout(layout, ["t1"]);
  assert.deepEqual(layoutTabIds(next), ["t1", A]);
  assert.equal(reconcileLayout(next, ["t1"]), next);
  assert.deepEqual(layoutTabIds(reconcileLayout(next, [])), [A]);
});

test("records round-trip and reject junk", () => {
  const records = { [A]: { workspaceId: "w1", daemonId: "d1", sessionId: "scr-1" }, [B]: { workspaceId: "w2", daemonId: "d2", sessionId: "scr-2" } };
  const serialized = serializeScreenTabRecords(records);
  assert.deepEqual(parseScreenTabRecords(serialized), records);
  assert.deepEqual(parseScreenTabRecords(null), {});
  assert.deepEqual(parseScreenTabRecords("not json"), {});
  assert.deepEqual(parseScreenTabRecords(JSON.stringify({ version: 2, tabs: records })), {});
  // A record missing a field, with an unsafe id, or under a non-screen id is skipped, not the whole value.
  const mixed = JSON.stringify({
    version: 1,
    tabs: {
      [A]: { workspaceId: "w1", daemonId: "d1", sessionId: "scr-1" },
      [B]: { workspaceId: "w2", daemonId: "d2" },
      "browser-tab-x": { workspaceId: "w1", daemonId: "d1", sessionId: "scr-9" },
      [`${SCREEN_TAB_PREFIX}bad`]: { workspaceId: "w1", daemonId: "d1", sessionId: "has space" },
    },
  });
  assert.deepEqual(parseScreenTabRecords(mixed), { [A]: records[A] });
});

test("storage that throws reads as nothing and writes as false", () => {
  const throwing = { getItem: () => { throw new Error("no"); }, setItem: () => { throw new Error("no"); } };
  assert.deepEqual(readScreenTabRecords({ storage: throwing, key: "k" }), {});
  assert.equal(writeScreenTabRecords({ storage: throwing, key: "k" }, "{}"), false);
  const memory = new Map<string, string>();
  const store = { storage: { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => memory.set(key, value) }, key: "k" };
  assert.equal(writeScreenTabRecords(store, serializeScreenTabRecords({ [A]: { workspaceId: "w1", daemonId: "d1", sessionId: "s" } })), true);
  assert.deepEqual(readScreenTabRecords(store), { [A]: { workspaceId: "w1", daemonId: "d1", sessionId: "s" } });
});

test("restore keeps a screen tab only with a layout entry and a record for the same workspace", () => {
  const layouts = { w1: revealTab(createLayout(["t1"]), A), w2: revealTab(createLayout([]), B) };
  const records = { [A]: { workspaceId: "w1", daemonId: "d1", sessionId: "s1" }, [B]: { workspaceId: "w9", daemonId: "d1", sessionId: "s2" }, [`${SCREEN_TAB_PREFIX}orphan`]: { workspaceId: "w1", daemonId: "d1", sessionId: "s3" } };
  const restored = restoreScreenTabs(layouts, records);
  assert.deepEqual(layoutTabIds(restored.layouts.w1!), ["t1", A]);
  assert.equal(restored.layouts.w1, layouts.w1, "an unchanged layout is the same object");
  assert.deepEqual(layoutTabIds(restored.layouts.w2!), []);
  assert.deepEqual(Object.keys(restored.records), [A]);
});
