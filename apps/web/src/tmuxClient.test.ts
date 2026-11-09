import assert from "node:assert/strict";
import test from "node:test";
import { agentLaunch, matchingTmux, resumeFork, type RemoteSession } from "./tmuxClient";
const original = "12345678-1234-1234-1234-123456789012";
const fresh = "87654321-4321-4321-4321-210987654321";
const claude = { id: "claude", command: "claude", args: "--verbose" };
const codex = { id: "codex", command: "codex", args: "--model example" };
const session = (extra: Partial<RemoteSession>): RemoteSession => ({ id: "$1", name: "label", windows: 1, attached: 0, ...extra });
test("new Claude sessions launch with the exact ID used for metadata", () => {
  const launch = agentLaunch(claude, { newId: fresh });
  assert.equal(launch.conversationId, fresh);
  assert.ok(launch.command.includes(`--session-id '${fresh}'`));
  assert.ok(launch.name.endsWith(fresh));
});
test("Claude forks are tracked under their new ID, never the source ID", () => {
  const launch = agentLaunch(claude, { resume: original, fork: true, newId: fresh });
  assert.equal(launch.conversationId, fresh);
  assert.ok(launch.command.includes(`--resume '${original}' --fork-session --session-id '${fresh}'`));
  assert.equal(matchingTmux([session({ agent: "claude", conversationId: fresh })], "claude", original), undefined);
});
test("ordinary resumes preserve the conversation ID and Codex creates no invented ID", () => {
  assert.equal(agentLaunch(claude, { resume: original }).conversationId, original);
  const launch = agentLaunch(codex, { newId: fresh });
  assert.equal(launch.conversationId, undefined);
  assert.equal(launch.command, "codex -c tui.copy_on_select=always --model example");
  assert.equal(agentLaunch(codex, { resume: original }).conversationId, original);
});
test("history matches metadata after rename, and never guesses from legacy names", () => {
  const live = session({ agent: "codex", conversationId: original, name: "renamed" });
  assert.equal(matchingTmux([live], "codex", original), live);
  assert.equal(matchingTmux([session({ name: `termany-codex-${original}` })], "codex", original), undefined);
  assert.equal(matchingTmux([live], "claude", original), undefined);
});
test("an unlinked running session never lets two processes share a transcript", () => {
  const unlinkedCodex = [session({ agent: "codex" })];
  // Codex cannot fork, so only a recently active conversation is refused.
  assert.throws(() => resumeFork(unlinkedCodex, "codex", true), /not linked/);
  assert.equal(resumeFork(unlinkedCodex, "codex", false), false);
  // Claude forks instead of refusing.
  assert.equal(resumeFork([session({ agent: "claude" })], "claude", false), true);
  assert.equal(resumeFork([], "claude", true), true);
  assert.equal(resumeFork([session({ agent: "claude", conversationId: original })], "claude", false), false);
  // Another agent's unlinked session does not matter.
  assert.equal(resumeFork([session({ agent: "claude" })], "codex", true), false);
});
test("an empty configured binary falls back to the agent's own command", () => {
  assert.equal(agentLaunch({ ...codex, command: " " }, { resume: original }).command, `codex -c tui.copy_on_select=always resume '${original}' --model example`);
});
test("invalid history identifiers cannot enter a launch command", () => {
  assert.throws(() => agentLaunch(codex, { resume: "id'; touch /tmp/no" }), /Invalid/);
});
