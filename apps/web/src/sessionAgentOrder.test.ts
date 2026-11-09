import assert from "node:assert/strict";
import test from "node:test";
import { moveSessionAgent, normalizeSessionAgentOrder } from "./sessionAgentOrder";

test("a saved order keeps known agents once and appends missing ones", () => {
  assert.deepEqual(normalizeSessionAgentOrder(["claude", "bogus", "claude"]), ["claude", "codex"]);
  assert.deepEqual(normalizeSessionAgentOrder(null), ["codex", "claude"]);
  assert.deepEqual(normalizeSessionAgentOrder("claude"), ["codex", "claude"]);
});

test("dropping an agent on another takes that agent's place", () => {
  assert.deepEqual(moveSessionAgent(["codex", "claude"], "codex", "claude"), ["claude", "codex"]);
  assert.deepEqual(moveSessionAgent(["claude", "codex"], "codex", "claude"), ["codex", "claude"]);
  assert.deepEqual(moveSessionAgent(["codex", "claude"], "codex", "codex"), ["codex", "claude"]);
});
