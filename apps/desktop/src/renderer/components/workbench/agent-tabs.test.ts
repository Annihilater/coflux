import assert from "node:assert/strict";
import test from "node:test";

import {
  NO_AGENT_TABS,
  answersAgentCreate,
  parseAgentTabRecords,
  pruneAgentTabRecords,
  serializeAgentTabRecords,
} from "./agent-tabs";

test("garbage storage reads as no records; unknown agents are skipped", () => {
  for (const raw of [null, "", "nope", "[]", '{"version":2,"tabs":{}}', '{"version":1,"tabs":[]}']) {
    assert.deepEqual(parseAgentTabRecords(raw), NO_AGENT_TABS, String(raw));
  }
  assert.deepEqual(parseAgentTabRecords(JSON.stringify({ version: 1, tabs: { a: "claude", b: "vim", c: 3 } })), { a: "claude" });
});

test("records round-trip", () => {
  const records = { t1: "codex", t2: "grok" } as const;
  assert.deepEqual(parseAgentTabRecords(serializeAgentTabRecords(records)), records);
});

test("pruning drops records of tasks that are gone and keeps identity when nothing changed", () => {
  const records = { t1: "claude", t2: "cursor" } as const;
  assert.equal(pruneAgentTabRecords(records, new Set(["t1", "t2", "t3"])), records);
  assert.deepEqual(pruneAgentTabRecords(records, new Set(["t2"])), { t2: "cursor" });
});

test("only a task carrying exactly the sent title answers an agent create", () => {
  assert.equal(answersAgentCreate("Claude Code", "Claude Code"), true);
  assert.equal(answersAgentCreate("终端 3", "Claude Code"), false);
  assert.equal(answersAgentCreate("Claude Code ", "Claude Code"), false);
  assert.equal(answersAgentCreate(undefined, "Claude Code"), false);
});
