import assert from "node:assert/strict";
import test from "node:test";
import { replaceAfterRelease, sameTerminal, sessionOpenAction, sshExitAction } from "./sessionOpenPolicy";

test("sidebar creates a pane while the title picker replaces its current pane", () => {
  assert.equal(sessionOpenAction("new", true), "create");
  assert.equal(sessionOpenAction("new", false), "create");
  assert.equal(sessionOpenAction("switch", true), "replace");
  assert.equal(sessionOpenAction("switch", false), "create");
});

test("switch commits only after teardown acknowledgement", async () => {
  const events: string[] = [];
  let acknowledge!: (ok: boolean) => void;
  const pending = replaceAfterRelease({
    release: () => new Promise<boolean>(resolve => { events.push("release"); acknowledge = resolve; }),
    isCurrent: () => true, replace: () => events.push("replace"), restore: () => events.push("restore"),
  });
  assert.deepEqual(events, ["release"]);
  acknowledge(true); await pending;
  assert.deepEqual(events, ["release", "replace"]);
});
test("failed release restores the original terminal without connecting a replacement", async () => {
  const events: string[] = [];
  await assert.rejects(replaceAfterRelease({
    release: async () => false, isCurrent: () => true,
    replace: () => events.push("replace"), restore: () => events.push("restore"),
  }), /release/);
  assert.deepEqual(events, ["restore"]);
});
test("closing or changing a pane during release cannot resurrect or overwrite it", async () => {
  for (const released of [true, false]) {
    const events: string[] = [];
    await assert.rejects(replaceAfterRelease({
      release: async () => released, isCurrent: () => false,
      replace: () => events.push("replace"), restore: () => events.push("restore"),
    }));
    assert.deepEqual(events, []);
  }
});

test("workspace sync and renaming do not cancel a pending terminal switch", () => {
  const pane = { id: "pane", sshTarget: "host", tmuxSession: "old", terminalRevision: 2, view: "terminal", title: "old title" };
  assert.equal(sameTerminal(pane, { ...pane, title: "new title" } as typeof pane), true);
  assert.equal(sameTerminal(pane, JSON.parse(JSON.stringify(pane))), true);
  assert.equal(sameTerminal(pane, { ...pane, tmuxSession: "other" }), false);
  assert.equal(sameTerminal(pane, { ...pane, terminalRevision: 3 }), false);
  assert.equal(sameTerminal(pane, undefined), false);
});

test("exiting a remote agent releases tmux and returns to the same SSH host", async () => {
  const pane = { sshTarget: "dev", sshLabel: "Development", tmuxSession: "termany-codex-123", agentSession: { agent: "codex", sessionId: "123" } };
  const action = sshExitAction(pane, pane);
  assert.equal(action.kind, "host");
  const destination = action.kind === "host" ? action.destination : undefined;
  assert.deepEqual(destination, { title: "Development", sshTarget: "dev", sshLabel: "Development" });
  const events: unknown[] = [];
  await replaceAfterRelease({
    release: async () => { events.push("release"); return true; }, isCurrent: () => true,
    replace: () => events.push(destination), restore: () => assert.fail("unexpected restore"),
  });
  assert.deepEqual(events, ["release", destination]);
  assert.deepEqual(sshExitAction({ sshTarget: "dev" }, { sshTarget: "dev" }), { kind: "local" });
});

test("stale SSH exits cannot change a closed pane or a different session", () => {
  const exit = { sshTarget: "dev", tmuxSession: "old" };
  for (const pane of [undefined, { sshTarget: "other", tmuxSession: "old" }, { sshTarget: "dev", tmuxSession: "new" }, { sshTarget: "dev" }]) {
    assert.deepEqual(sshExitAction(pane, exit), { kind: "ignore" });
  }
});
