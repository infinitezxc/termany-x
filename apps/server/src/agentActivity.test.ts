import assert from "node:assert/strict";
import test from "node:test";
import { AgentActivityTracker } from "./agentActivity.js";

/**
 * The green dot stays while the agent TUI is open, and clears on exit.
 * A completion settled too early inverts that protection — the agent is
 * still working and the latch keeps the lie — so live busy evidence for the
 * exact same epoch is allowed to pull the task back to working. Nothing
 * else is: a guessed or stale epoch must bounce off, and a completion
 * acknowledged after the agent exits is gone for good.
 */

function tracker(): { tracker: AgentActivityTracker; changes: () => number } {
  let count = 0;
  const t = new AgentActivityTracker({
    now: () => 1_000,
    onChange: () => count++,
  });
  return { tracker: t, changes: () => count };
}

test("live busy evidence pulls a premature done back to working", () => {
  const { tracker: t } = tracker();
  t.register("s1", "claude");
  t.reportIdle("s1", 1, true);
  assert.equal(t.snapshot().s1.status, "done");

  assert.equal(t.reportWorking("s1", 1), true);
  const activity = t.snapshot().s1;
  assert.equal(activity.status, "working");
  assert.equal(activity.taskEpoch, 1, "resuming is the same task, not a new one");
  assert.equal(activity.agent, "claude");
});

test("a resumed task can settle again under the same epoch", () => {
  const { tracker: t } = tracker();
  t.register("s1", "claude");
  t.reportIdle("s1", 1, true);
  t.reportWorking("s1", 1);
  assert.equal(t.reportIdle("s1", 1, true), true);
  assert.equal(t.snapshot().s1.status, "done");
});

test("a stale or guessed epoch cannot resurrect a task", () => {
  const { tracker: t } = tracker();
  t.register("s1", "claude");
  t.reportIdle("s1", 1, true);
  assert.equal(t.reportWorking("s1", 2), false);
  assert.equal(t.reportWorking("s1", 0), false);
  assert.equal(t.snapshot().s1.status, "done");
  assert.equal(t.reportWorking("missing", 1), false);
});

test("a rendered screen cannot re-own a pty the shell took back", () => {
  const { tracker: t } = tracker();
  t.register("s1", "claude");
  t.reportIdle("s1", 1, true);
  // The foreground sampler saw the agent leave and the shell get the terminal
  // back: whatever spinner row is still on screen, the agent process is gone.
  t.noteForegroundJob("s1", "2.1.220", "/bin/zsh");
  t.noteForegroundJob("s1", "zsh", "/bin/zsh");
  assert.equal(t.reportWorking("s1", 1), false);
  assert.equal(t.snapshot().s1, undefined);
});

test("a completion acknowledged after the agent exits stays cleared", () => {
  const { tracker: t } = tracker();
  t.register("s1", "claude");
  t.reportIdle("s1", 1, true);
  // An idle composer is still a live conversation and cannot be dismissed by
  // viewing it. Only after the foreground job returns to the shell does the
  // green completion become a read-once notification.
  t.noteForegroundJob("s1", "2.1.220", "/bin/zsh");
  t.noteForegroundJob("s1", "zsh", "/bin/zsh");
  t.acknowledge([{ id: "s1", taskEpoch: 1 }]);
  assert.equal(t.reportWorking("s1", 1), false);
  assert.equal(t.snapshot().s1, undefined);
});

test("a blocked question resumes to working when the agent moves on", () => {
  // A keypress-only menu answer never reaches the input heuristics, so the
  // busy screen that follows is the only proof the question was answered.
  const { tracker: t } = tracker();
  t.register("s1", "claude");
  t.reportBlocked("s1", 1);
  assert.equal(t.snapshot().s1.status, "error");
  assert.equal(t.reportWorking("s1", 1), true);
  assert.equal(t.snapshot().s1.status, "working");
});

test("confirming an already-working task changes nothing", () => {
  const { tracker: t, changes } = tracker();
  t.register("s1", "claude");
  const before = changes();
  assert.equal(t.reportWorking("s1", 1), true);
  assert.equal(t.snapshot().s1.status, "working");
  assert.equal(changes(), before, "no change event for a no-op confirmation");
});

for (const agent of ["codex", "claude"]) {
  test(`${agent} quitting clears green without acknowledgement`, () => {
    const { tracker: t, changes } = tracker();
    t.register("s1", agent);
    t.noteForegroundJob("s1", "node", "zsh");
    t.reportIdle("s1", 1, true);
    const before = changes();

    t.noteForegroundJob("s1", "zsh", "zsh");

    assert.deepEqual(t.snapshot(), {});
    assert.deepEqual(t.activeSessionIds(), []);
    assert.equal(changes(), before + 1);
    assert.equal(t.reportIdle("s1", 1, true), false);
    assert.equal(t.reportBlocked("s1", 1), false);
    t.noteInput("s1", "pwd\r");
    assert.deepEqual(t.snapshot(), {});
    t.register("s1", agent);
    assert.equal(t.snapshot().s1.taskEpoch, 2);
  });
}

test("a rendered shell prompt clears green without acknowledgement", () => {
  const { tracker: t } = tracker();
  t.register("s1", "codex");
  t.reportIdle("s1", 1, true);
  assert.equal(t.reportIdle("s1", 1, false), true);
  assert.deepEqual(t.snapshot(), {});
  assert.deepEqual(t.activeSessionIds(), []);
});

test("a successful PTY exit clears green without acknowledgement", () => {
  const { tracker: t } = tracker();
  t.register("s1", "claude");
  t.reportIdle("s1", 1, true);
  t.noteExit("s1", 0);
  assert.deepEqual(t.snapshot(), {});
  assert.deepEqual(t.activeSessionIds(), []);
});

for (const agent of ["codex", "claude"]) {
  for (const exit of ["foreground", "screen", "pty"]) {
    test(`${agent} red status clears on ${exit} exit while detached`, () => {
      const { tracker: t } = tracker();
      t.register("s1", agent);
      t.noteForegroundJob("s1", "node", "zsh");
      t.reportBlocked("s1", 1);
      assert.equal(t.snapshot().s1.status, "error");

      // No client acknowledgement: the next reconnect receives this snapshot.
      if (exit === "foreground") t.noteForegroundJob("s1", "zsh", "zsh");
      if (exit === "screen") assert.equal(t.reportIdle("s1", 1, false), true);
      if (exit === "pty") t.noteExit("s1", 0);
      assert.deepEqual(t.snapshot(), {});
      assert.deepEqual(t.activeSessionIds(), []);
      assert.equal(t.reportBlocked("s1", 1), false);
      assert.equal(t.reportIdle("s1", 1, true), false);
      assert.equal(t.reportWorking("s1", 1), false);

      t.register("s1", agent);
      assert.equal(t.snapshot().s1.taskEpoch, 2);
      assert.equal(t.reportBlocked("s1", 1), false);
      assert.equal(t.snapshot().s1.status, "working");
    });
  }
}

test("a live blocked agent stays red across idle reports", () => {
  const { tracker: t } = tracker();
  t.register("s1", "claude");
  t.reportBlocked("s1", 1);
  t.reportIdle("s1", 1, true);
  assert.equal(t.snapshot().s1.status, "error");
  assert.deepEqual(t.activeSessionIds(), ["s1"]);
});

for (const [exitCode, signal] of [[255, undefined], [0, 1], [1, undefined]]) {
  test(`SSH/PTY failure (${exitCode}, ${signal}) cannot leave red on reconnect`, () => {
    const { tracker: t } = tracker();
    t.register("ssh-pane", "claude");
    t.reportBlocked("ssh-pane", 1);
    t.noteExit("ssh-pane", exitCode!, signal);
    assert.deepEqual(t.snapshot(), {});
    assert.deepEqual(t.activeSessionIds(), []);
    assert.equal(t.reportBlocked("ssh-pane", 1), false);
    t.bindAgent("ssh-pane", "claude");
    assert.deepEqual(t.snapshot(), {});
    t.register("ssh-pane", "claude");
    assert.equal(t.snapshot()["ssh-pane"].taskEpoch, 2);
  });
}

test("remote foreground shell clears red even when its away transition was missed", () => {
  const { tracker: t } = tracker();
  t.register("ssh-pane", "claude");
  t.reportBlocked("ssh-pane", 1);
  t.noteForegroundJob("ssh-pane", "shell", "shell", true);
  assert.deepEqual(t.snapshot(), {});
  assert.deepEqual(t.activeSessionIds(), []);
});

test("a foreground remote agent keeps red even with background jobs", () => {
  const { tracker: t } = tracker();
  t.register("ssh-pane", "codex");
  t.reportBlocked("ssh-pane", 1);
  t.noteForegroundJob("ssh-pane", "foreground", "shell", true);
  assert.equal(t.snapshot()["ssh-pane"].status, "error");
  assert.deepEqual(t.activeSessionIds(), ["ssh-pane"]);
});
