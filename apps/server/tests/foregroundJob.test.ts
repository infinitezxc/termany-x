import assert from "node:assert/strict";
import test from "node:test";
import { AgentActivityTracker } from "../src/agentActivity.ts";
import { foregroundJobIsShell, normalizeJobName } from "../src/foregroundJob.ts";

test("a job name is recognized whatever the shell calls it", () => {
  // Sampling right after spawn can still report the path, and a login shell
  // conventionally advertises itself with a leading dash.
  assert.equal(normalizeJobName("/bin/zsh"), "zsh");
  assert.equal(normalizeJobName("-zsh"), "zsh");
  assert.equal(normalizeJobName("zsh"), "zsh");
  assert.equal(normalizeJobName("C:\\Program Files\\PowerShell\\pwsh.exe"), "pwsh.exe");
  assert.equal(normalizeJobName("  fish  "), "fish");
  assert.equal(normalizeJobName(""), "");
});

test("anything that is not the session's own shell counts as a running job", () => {
  assert.equal(foregroundJobIsShell("zsh", "/bin/zsh"), true);
  assert.equal(foregroundJobIsShell("-zsh", "/bin/zsh"), true);
  // Claude Code reports as its version string, Codex as a wrapper name: naming
  // the agent is hopeless, and not needed. Not-the-shell is the whole signal.
  assert.equal(foregroundJobIsShell("2.1.220", "/bin/zsh"), false);
  assert.equal(foregroundJobIsShell("node", "/bin/zsh"), false);
  assert.equal(foregroundJobIsShell("vim", "/bin/zsh"), false);
});

/** The transition that matters: something ran, and then the shell got the terminal back. */
function runAndExit(tracker: AgentActivityTracker, id: string, shell = "/bin/zsh") {
  tracker.noteForegroundJob(id, "2.1.220", shell);
  tracker.noteForegroundJob(id, "zsh", shell);
}

test("a task ends the moment the shell gets the terminal back", () => {
  const tracker = new AgentActivityTracker();
  tracker.register("pane-a", "claude");
  assert.equal(tracker.snapshot()["pane-a"].status, "working");

  runAndExit(tracker, "pane-a");

  assert.equal(tracker.snapshot()["pane-a"], undefined);
  assert.deepEqual(tracker.activeSessionIds(), []);
});

test("the shell holding the terminal at task start is not an exit", () => {
  // The window between Enter and the agent taking over the foreground: the
  // shell is still what tcgetpgrp reports, and concluding there would finish
  // every task the instant it started.
  const tracker = new AgentActivityTracker();
  tracker.register("pane-a", "claude");

  tracker.noteForegroundJob("pane-a", "zsh", "/bin/zsh");
  tracker.noteForegroundJob("pane-a", "zsh", "/bin/zsh");

  assert.equal(tracker.snapshot()["pane-a"].status, "working");
});

test("an earlier command's exit does not settle a later task", () => {
  // `vim`, quit, then start an agent: the watcher must not carry that return
  // to the prompt across into the task that follows it.
  const tracker = new AgentActivityTracker();
  tracker.noteForegroundJob("pane-a", "vim", "/bin/zsh");
  tracker.noteForegroundJob("pane-a", "zsh", "/bin/zsh");

  tracker.register("pane-a", "claude");
  tracker.noteForegroundJob("pane-a", "zsh", "/bin/zsh");

  assert.equal(tracker.snapshot()["pane-a"].status, "working");
});

test("a session whose foreground job never moves is left alone", () => {
  // Two shapes at once: an ssh session, whose local foreground job is `ssh`
  // for its whole life, and Windows, where the reported job never tracks the
  // foreground group at all. Both must fall back to the screen heuristic
  // rather than read as a task that finished instantly.
  const tracker = new AgentActivityTracker();
  tracker.register("pane-a", "claude");

  for (let i = 0; i < 5; i++) tracker.noteForegroundJob("pane-a", "ssh", "ssh");

  assert.equal(tracker.snapshot()["pane-a"].status, "working");
});

test("the returned shell also releases the input the agent was holding", () => {
  // agentActive is what routes the next Enter to a new task. Left true after
  // the agent exited, every plain shell command would open one.
  const tracker = new AgentActivityTracker();
  tracker.register("pane-a", "claude");
  runAndExit(tracker, "pane-a");
  tracker.acknowledge([{ id: "pane-a", taskEpoch: 1 }]);

  tracker.noteInput("pane-a", "ls\r");

  assert.deepEqual(tracker.snapshot(), {});
});

test("a foreground job never invents a task of its own", () => {
  // Once the agent's task is acknowledged the dot is gone, and the plain
  // commands that follow all day must not bring it back or open new ones.
  const tracker = new AgentActivityTracker();
  tracker.register("pane-a", "claude");
  runAndExit(tracker, "pane-a");
  tracker.acknowledge([{ id: "pane-a", taskEpoch: 1 }]);

  tracker.noteForegroundJob("pane-a", "ls", "/bin/zsh");
  tracker.noteForegroundJob("pane-a", "zsh", "/bin/zsh");

  assert.deepEqual(tracker.snapshot(), {});
});

test("a job that reads back as nothing is not a transition", () => {
  // node-pty hands back null exactly while a process group changes hands, and
  // its own typings say otherwise. Read as a name, that would look like a job
  // starting; read as empty, like the shell returning.
  const tracker = new AgentActivityTracker();
  tracker.register("pane-a", "claude");

  tracker.noteForegroundJob("pane-a", "2.1.220", "zsh");
  tracker.noteForegroundJob("pane-a", null as unknown as string, "zsh");
  assert.equal(tracker.snapshot()["pane-a"].status, "working");

  tracker.noteForegroundJob("pane-a", "zsh", "zsh");
  assert.equal(tracker.snapshot()["pane-a"], undefined);
});

test("a blocked task clears when its agent returns to the shell", () => {
  // A question from an exited agent is no longer actionable.
  const tracker = new AgentActivityTracker();
  tracker.register("pane-a", "claude");
  tracker.reportBlocked("pane-a", 1);

  runAndExit(tracker, "pane-a");

  assert.equal(tracker.snapshot()["pane-a"], undefined);
  assert.deepEqual(tracker.activeSessionIds(), []);
});
