import assert from "node:assert/strict";
import { test } from "node:test";

import { createScreenSessionId, parseScreenRecords, readScreenRecords, serializeScreenRecords, writeScreenRecords } from "./screen-records";

test("session ids carry their prefix and nothing unsafe", () => {
  assert.equal(createScreenSessionId("123e4567-e89b-12d3-a456-426614174000"), "scr-123e4567-e89b-12d3-a456-426614174000");
  assert.equal(createScreenSessionId("x y/z"), "scr-xyz");
});

test("records round-trip, one per device, and reject junk", () => {
  const records = { d1: { daemonId: "d1", sessionId: "scr-1" }, d2: { daemonId: "d2", sessionId: "scr-2" } };
  assert.deepEqual(parseScreenRecords(serializeScreenRecords(records)), records);
  assert.deepEqual(parseScreenRecords(null), {});
  assert.deepEqual(parseScreenRecords("not json"), {});
  assert.deepEqual(parseScreenRecords(JSON.stringify({ version: 2, screens: Object.values(records) })), {});
  // The old per-tab shape (an object of tab ids) is not this format: nothing is restored from it.
  assert.deepEqual(
    parseScreenRecords(JSON.stringify({ version: 1, tabs: { "screen-tab-a": { workspaceId: "w1", daemonId: "d1", sessionId: "scr-1" } } })),
    {},
  );
  // A bad entry is skipped, not the whole value; a second screen for a device is ignored.
  const mixed = JSON.stringify({
    version: 1,
    screens: [
      { daemonId: "d1", sessionId: "scr-1" },
      { daemonId: "d1", sessionId: "scr-other" },
      { daemonId: "d2" },
      { daemonId: "has space", sessionId: "scr-3" },
      "junk",
      { daemonId: "d4", sessionId: "scr-4" },
    ],
  });
  assert.deepEqual(parseScreenRecords(mixed), { d1: { daemonId: "d1", sessionId: "scr-1" }, d4: { daemonId: "d4", sessionId: "scr-4" } });
});

test("storage that throws reads as nothing and writes as false", () => {
  const throwing = { getItem: () => { throw new Error("no"); }, setItem: () => { throw new Error("no"); } };
  assert.deepEqual(readScreenRecords({ storage: throwing, key: "k" }), {});
  assert.equal(writeScreenRecords({ storage: throwing, key: "k" }, "{}"), false);
  const memory = new Map<string, string>();
  const store = { storage: { getItem: (key: string) => memory.get(key) ?? null, setItem: (key: string, value: string) => memory.set(key, value) }, key: "k" };
  assert.equal(writeScreenRecords(store, serializeScreenRecords({ d1: { daemonId: "d1", sessionId: "s" } })), true);
  assert.deepEqual(readScreenRecords(store), { d1: { daemonId: "d1", sessionId: "s" } });
});
