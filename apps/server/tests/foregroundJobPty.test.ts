import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node-pty";
import { AgentActivityTracker } from "../src/agentActivity.ts";
import { sampleOnceOutputSettles } from "../src/foregroundJob.ts";

/**
 * End-to-end over a real PTY, because everything this feature rests on is
 * outside the process: that node-pty's `process` really follows tcgetpgrp,
 * that a command taking and releasing the terminal is visible from here, and
 * that the wiring settles the task at the right moment rather than instantly.
 *
 * Wired exactly as index.ts wires it, so this covers the shipped policy and
 * not a copy of it.
 */
const SHELL = "/bin/sh";
const skip = process.platform === "win32" ? "POSIX shells only" : false;

type Run = { statusAt: (status: string) => number | undefined; elapsed: number };

/** Run one command in an interactive shell and watch a task through it. */
async function runInShell(command: string, holdMs: number, ignoreTaskOutput = false): Promise<Run> {
  const pty = spawn(SHELL, ["-i"], {
    name: "xterm-256color",
    cols: 80,
    rows: 24,
    cwd: process.cwd(),
    env: { ...process.env, PS1: "$ " },
  });
  const tracker = new AgentActivityTracker();
  const startedAt = Date.now();
  const seen = new Map<string, number>();
  const record = () => {
    const status = tracker.snapshot()["pane-a"]?.status ?? "none";
    if (!seen.has(status)) seen.set(status, Date.now() - startedAt);
  };

  // Wired as index.ts wires it: the first settled read is the shell's own
  // name, since nothing else can have run yet. /bin/sh answers "bash" here,
  // so the spawn command would not have matched.
  let shellJob = "";
  const reconcile = () => {
    if (!shellJob) return;
    tracker.noteForegroundJob("pane-a", pty.process, shellJob);
    record();
  };
  const sampler = sampleOnceOutputSettles(() => {
    if (!shellJob) shellJob = pty.process || SHELL;
    reconcile();
  });
  let taskStarted = false;
  pty.onData(() => {
    if (!ignoreTaskOutput || !taskStarted) sampler.noteOutput();
  });
  const poll = setInterval(reconcile, 2_000);

  await new Promise((r) => setTimeout(r, 300));
  taskStarted = true;
  tracker.register("pane-a", "claude");
  record();
  pty.write(`${command}\n`);

  await new Promise((r) => setTimeout(r, holdMs));
  clearInterval(poll);
  sampler.dispose();
  pty.kill();
  return { statusAt: (status) => seen.get(status), elapsed: Date.now() - startedAt };
}

test("the shell taking the terminal back settles the task", { skip }, async () => {
  const run = await runInShell("sleep 1", 2_500);

  assert.equal(typeof run.statusAt("done"), "number", "the task never settled");
  // Not before the command released the terminal, and not long after either:
  // the quiet-window heuristic would not have called it until 2s.
  assert.ok(
    run.statusAt("done")! > 1_000,
    `settled at ${run.statusAt("done")}ms, before the command had exited`,
  );
  assert.ok(
    run.statusAt("done")! < 2_000,
    `settled at ${run.statusAt("done")}ms, no earlier than the screen heuristic`,
  );
});

test("a command still holding the terminal leaves the task working", { skip }, async () => {
  const run = await runInShell("sleep 5", 1_500);

  assert.equal(run.statusAt("done"), undefined, "settled while the command was still running");
  assert.equal(typeof run.statusAt("working"), "number");
});

test("periodic reconciliation clears working without output or an attached client", { skip }, async () => {
  // Ignore all task output: only independent foreground samples can observe
  // both the running command and the return to the shell.
  const run = await runInShell("sleep 2.5", 4_500, true);
  assert.equal(typeof run.statusAt("done"), "number");
  assert.ok(run.statusAt("done")! > 2_500, "must not finish before the process exits");
});

test("periodic reconciliation keeps a silent running task yellow", { skip }, async () => {
  const run = await runInShell("sleep 8", 4_500, true);
  assert.equal(run.statusAt("done"), undefined);
  assert.equal(typeof run.statusAt("working"), "number");
});
