import assert from "node:assert/strict";
import test from "node:test";

import {
  AGENT_CATALOG,
  DEFAULT_AGENT_SETTINGS,
  MAX_COMMAND_LENGTH,
  agentSettingsFromAccount,
  effectiveAgents,
  launchCommandOf,
  sanitizeAgentCommand,
} from "./agent-settings";

test("the catalog is Claude Code, Codex, Cursor, Grok in that order", () => {
  assert.deepEqual(
    AGENT_CATALOG.map((agent) => agent.id),
    ["claude", "codex", "cursor", "grok"],
  );
});

test("an empty account configuration is all off", () => {
  assert.deepEqual(agentSettingsFromAccount({}), DEFAULT_AGENT_SETTINGS);
  assert.equal(effectiveAgents(agentSettingsFromAccount({})).length, 0);
});

test("ids the catalog does not know are ignored; malformed entries read as off without affecting the others", () => {
  const settings = agentSettingsFromAccount({
    claude: { enabled: "yes", command: 3 } as unknown as { enabled: boolean; command: string },
    codex: { enabled: true, command: "codex" },
    aider: { enabled: true, command: "aider" },
    grok: undefined,
  });
  assert.deepEqual(settings.claude, { enabled: false, command: "" });
  assert.deepEqual(settings.codex, { enabled: true, command: "codex" });
  assert.deepEqual(settings.grok, { enabled: false, command: "" });
  assert.deepEqual(Object.keys(settings).sort(), ["claude", "codex", "cursor", "grok"]);
});

test("on with a blank command is not effective; off is never effective", () => {
  assert.equal(launchCommandOf({ enabled: true, command: "" }), null);
  assert.equal(launchCommandOf({ enabled: true, command: "   " }), null);
  assert.equal(launchCommandOf({ enabled: false, command: "claude" }), null);
  assert.equal(launchCommandOf({ enabled: true, command: "  claude --resume " }), "claude --resume");
});

test("effective agents come in catalog order with trimmed commands, never the placeholder", () => {
  const settings = agentSettingsFromAccount({
    grok: { enabled: true, command: "grok" },
    claude: { enabled: true, command: " cc " },
    codex: { enabled: true, command: "" },
    cursor: { enabled: false, command: "cursor-agent" },
  });
  assert.deepEqual(
    effectiveAgents(settings).map((agent) => [agent.id, agent.command]),
    [
      ["claude", "cc"],
      ["grok", "grok"],
    ],
  );
});

test("a command is one line and bounded", () => {
  assert.equal(sanitizeAgentCommand("claude\r\n--resume\t"), "claude--resume");
  assert.equal(sanitizeAgentCommand("x".repeat(MAX_COMMAND_LENGTH + 5)).length, MAX_COMMAND_LENGTH);
  assert.equal(agentSettingsFromAccount({ codex: { enabled: true, command: "codex\n" } }).codex.command, "codex");
});
