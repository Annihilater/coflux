import assert from "node:assert/strict";
import { test } from "node:test";

import { readRecentPlaces, recordRecentPlace, type RecentPlacesStore } from "./command-palette-recent";

function memoryStore(limit?: number): RecentPlacesStore & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    key: "recent",
    limit,
    storage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
    },
  };
}

test("记录是移到最前而不是新增一次访问", () => {
  const store = memoryStore();
  recordRecentPlace(store, "workspace:a");
  recordRecentPlace(store, "terminal:b");
  recordRecentPlace(store, "workspace:a");
  assert.deepEqual(readRecentPlaces(store), ["workspace:a", "terminal:b"]);

  // 快照校准会反复重写同一个选中项：再记一次不该改变任何顺序
  recordRecentPlace(store, "workspace:a");
  assert.deepEqual(readRecentPlaces(store), ["workspace:a", "terminal:b"]);
});

test("容量上限裁掉最旧的位置", () => {
  const store = memoryStore(3);
  for (const key of ["a", "b", "c", "d"]) recordRecentPlace(store, `workspace:${key}`);
  assert.deepEqual(readRecentPlaces(store), ["workspace:d", "workspace:c", "workspace:b"]);
});

test("存储读不到、内容损坏或直接抛错都只当作「没有记录」", () => {
  const store = memoryStore();
  assert.deepEqual(readRecentPlaces(store), []);

  store.values.set("recent", "{not json");
  assert.deepEqual(readRecentPlaces(store), []);
  store.values.set("recent", JSON.stringify({ a: 1 }));
  assert.deepEqual(readRecentPlaces(store), []);
  store.values.set("recent", JSON.stringify(["workspace:a", 7, "", null, "device:d"]));
  assert.deepEqual(readRecentPlaces(store), ["workspace:a", "device:d"]);

  const hostile: RecentPlacesStore = {
    key: "recent",
    storage: {
      getItem: () => {
        throw new Error("site data blocked");
      },
      setItem: () => {
        throw new Error("site data blocked");
      },
    },
  };
  assert.deepEqual(readRecentPlaces(hostile), []);
  // 写不进去不抛错：调用方拿到本该落盘的列表，下次读仍然是空的
  assert.deepEqual(recordRecentPlace(hostile, "workspace:a"), ["workspace:a"]);
  assert.deepEqual(readRecentPlaces(hostile), []);
});
