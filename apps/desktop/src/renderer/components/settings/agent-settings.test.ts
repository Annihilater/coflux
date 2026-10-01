import assert from "node:assert/strict";
import test from "node:test";

import {
  AGENT_CATALOG,
  DEFAULT_AGENT_SETTINGS,
  createAgentSettingsStore,
  effectiveAgents,
  launchCommandOf,
  parseAgentSettings,
  serializeAgentSettings,
  withAgentSetting,
} from "./agent-settings";

function memoryStorage(initial: string | null = null) {
  let value = initial;
  return {
    get value() {
      return value;
    },
    storage: {
      getItem: () => value,
      setItem: (_key: string, next: string) => {
        value = next;
      },
    },
  };
}

test("the catalog is Claude Code, Codex, Cursor, Grok in that order", () => {
  assert.deepEqual(
    AGENT_CATALOG.map((agent) => agent.id),
    ["claude", "codex", "cursor", "grok"],
  );
});

test("missing or garbage storage reads as all off with empty commands", () => {
  for (const raw of [null, "", "not json", "[]", "42", '{"version":2,"agents":{}}', '{"version":1}', '{"version":1,"agents":[]}']) {
    assert.deepEqual(parseAgentSettings(raw), DEFAULT_AGENT_SETTINGS, String(raw));
  }
  assert.equal(effectiveAgents(parseAgentSettings("not json")).length, 0);
});

test("a malformed entry falls back to off without affecting the others", () => {
  const settings = parseAgentSettings(
    JSON.stringify({ version: 1, agents: { claude: { enabled: "yes", command: 3 }, codex: { enabled: true, command: "codex" }, grok: null } }),
  );
  assert.deepEqual(settings.claude, { enabled: false, command: "" });
  assert.deepEqual(settings.codex, { enabled: true, command: "codex" });
  assert.deepEqual(settings.grok, { enabled: false, command: "" });
});

test("on with a blank command is not effective; off is never effective", () => {
  assert.equal(launchCommandOf({ enabled: true, command: "" }), null);
  assert.equal(launchCommandOf({ enabled: true, command: "   " }), null);
  assert.equal(launchCommandOf({ enabled: false, command: "claude" }), null);
  assert.equal(launchCommandOf({ enabled: true, command: "  claude --resume " }), "claude --resume");
});

test("effective agents come in catalog order with trimmed commands, never the placeholder", () => {
  let settings = DEFAULT_AGENT_SETTINGS;
  settings = withAgentSetting(settings, "grok", { enabled: true, command: "grok" });
  settings = withAgentSetting(settings, "claude", { enabled: true, command: " cc " });
  settings = withAgentSetting(settings, "codex", { enabled: true });
  assert.deepEqual(
    effectiveAgents(settings).map((agent) => [agent.id, agent.command]),
    [
      ["claude", "cc"],
      ["grok", "grok"],
    ],
  );
});

test("switching off keeps the typed command", () => {
  let settings = withAgentSetting(DEFAULT_AGENT_SETTINGS, "cursor", { enabled: true, command: "cursor-agent" });
  settings = withAgentSetting(settings, "cursor", { enabled: false });
  assert.deepEqual(settings.cursor, { enabled: false, command: "cursor-agent" });
  assert.deepEqual(parseAgentSettings(serializeAgentSettings(settings)), settings);
});

test("the store writes every change at once and survives a throwing storage", () => {
  const memory = memoryStorage();
  const store = createAgentSettingsStore({ storage: () => memory.storage, key: "k" });
  store.getState().update("claude", { enabled: true });
  store.getState().update("claude", { command: "claude" });
  assert.deepEqual(parseAgentSettings(memory.value).claude, { enabled: true, command: "claude" });

  const broken = createAgentSettingsStore({
    storage: () => {
      throw new Error("storage unavailable");
    },
    key: "k",
  });
  assert.deepEqual(broken.getState().settings, DEFAULT_AGENT_SETTINGS);
  broken.getState().update("codex", { enabled: true, command: "codex" });
  assert.equal(effectiveAgents(broken.getState().settings)[0]?.id, "codex");
});
