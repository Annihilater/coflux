import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ABSENT_LINK_TTL_MS,
  FILE_LINK_TTL_MS,
  MAX_FILE_LINK_BATCH,
  OUTDATED_LINK_TTL_MS,
  createFileLinkCache,
  isLinkReplyCurrent,
} from "./terminal-file-links";

function clock() {
  let now = 1_000;
  return { now: () => now, advance: (ms: number) => void (now += ms) };
}

test("only an existing regular file becomes a link, keyed by its canonical path", () => {
  const time = clock();
  const cache = createFileLinkCache(time.now);
  cache.record("ws", [
    { path: "./src/a.ts", exists: true, isFile: true, relativePath: "src/a.ts" },
    { path: "src", exists: true, isFile: false, relativePath: "src" },
    { path: "gone.ts", exists: false, isFile: false, relativePath: "" },
  ]);
  assert.deepEqual(cache.get("ws", "./src/a.ts"), { kind: "file", relativePath: "src/a.ts" });
  assert.deepEqual(cache.get("ws", "src"), { kind: "absent" }, "a directory is not a link");
  assert.deepEqual(cache.get("ws", "gone.ts"), { kind: "absent" });
  assert.equal(cache.get("other", "./src/a.ts"), undefined, "the cache is per workspace");
});

test("a missing path is re-asked soon, an existing file much later", () => {
  const time = clock();
  const cache = createFileLinkCache(time.now);
  cache.record("ws", [
    { path: "a.ts", exists: true, isFile: true, relativePath: "a.ts" },
    { path: "b.ts", exists: false, isFile: false, relativePath: "" },
  ]);
  time.advance(ABSENT_LINK_TTL_MS);
  assert.equal(cache.get("ws", "b.ts"), undefined, "an agent may be about to create it");
  assert.deepEqual(cache.get("ws", "a.ts"), { kind: "file", relativePath: "a.ts" });
  time.advance(FILE_LINK_TTL_MS);
  assert.equal(cache.get("ws", "a.ts"), undefined);
});

test("a failed check is not cached; only the unknown paths are asked, deduplicated and capped", () => {
  const time = clock();
  const cache = createFileLinkCache(time.now);
  cache.record("ws", [{ path: "a.ts", exists: true, isFile: true, relativePath: "a.ts" }]);
  assert.deepEqual(cache.unknown("ws", ["a.ts", "b.ts", "b.ts", "c.ts"]), ["b.ts", "c.ts"]);
  const many = Array.from({ length: MAX_FILE_LINK_BATCH + 10 }, (_, index) => `f${index}.ts`);
  assert.equal(cache.unknown("ws", many).length, MAX_FILE_LINK_BATCH);
});

test("an outdated worker turns the workspace's references into plain text for a while", () => {
  const time = clock();
  const cache = createFileLinkCache(time.now);
  cache.record("ws", [{ path: "a.ts", exists: true, isFile: true, relativePath: "a.ts" }]);
  cache.recordOutdated("ws");
  assert.deepEqual(cache.get("ws", "a.ts"), { kind: "absent" });
  assert.deepEqual(cache.unknown("ws", ["x.ts"]), [], "nothing is asked while outdated");
  time.advance(OUTDATED_LINK_TTL_MS);
  assert.deepEqual(cache.unknown("ws", ["x.ts"]), ["x.ts"], "a hot-upgraded worker is asked again");
});

test("a late answer is delivered only for the latest request on unchanged text", () => {
  assert.equal(isLinkReplyCurrent({ request: 3, latestRequest: 3, requestedText: "see a.ts", currentText: "see a.ts" }), true);
  assert.equal(
    isLinkReplyCurrent({ request: 3, latestRequest: 4, requestedText: "see a.ts", currentText: "see a.ts" }),
    false,
    "the pointer moved to another line",
  );
  assert.equal(
    isLinkReplyCurrent({ request: 3, latestRequest: 3, requestedText: "see a.ts", currentText: "next line" }),
    false,
    "output scrolled the buffer under a still pointer",
  );
  assert.equal(isLinkReplyCurrent({ request: 3, latestRequest: 3, requestedText: "see a.ts", currentText: null }), false);
});
