import assert from "node:assert/strict";
import test from "node:test";
import { parseIdentityOutput, transcriptIdentity } from "./tmuxIdentity.js";
const id = "12345678-1234-1234-1234-123456789012";
const other = "87654321-4321-4321-4321-210987654321";
test("identity comes from a unique open transcript, including custom Codex homes", () => {
  const file = `/custom/sessions/2026/11/03/rollout-2026-11-03T12-00-00-${id}.jsonl`;
  assert.equal(transcriptIdentity(`${file}\n${file}\n/dev/pts/1`, "codex"), id);
  assert.equal(transcriptIdentity(`/home/user/.claude/projects/-project/${id}.jsonl`, "claude"), id);
});
test("Claude is identified by its per-process session record", () => {
  assert.equal(transcriptIdentity(`claude-session:${id}\n/dev/pts/1`, "claude"), id);
  assert.equal(transcriptIdentity(`claude-session:${id}\n/home/u/.claude/projects/-p/${other}.jsonl`, "claude"), undefined);
  assert.equal(transcriptIdentity(`/home/u/.claude/projects/-p/${id}/subagents`, "claude"), undefined);
  assert.equal(transcriptIdentity(`claude-session:${id}`, "codex"), undefined);
});
test("identity output is split per pane", () => {
  const parsed = parseIdentityOutput(`=10\n/a\n/b\n=20\n=30\n/c\n`);
  assert.deepEqual([...parsed], [[10, "/a\n/b\n"], [20, ""], [30, "/c\n"]]);
});
test("ambiguous, missing and unrelated files never produce a guessed association", () => {
  assert.equal(transcriptIdentity(`/x/rollout-time-${id}.jsonl\n/x/rollout-time-${other}.jsonl`, "codex"), undefined);
  assert.equal(transcriptIdentity(`/logs/${id}.jsonl`, "claude"), undefined);
  assert.equal(transcriptIdentity("", "codex"), undefined);
});

test("process discovery sees owned descriptors but not an unrelated process", async () => {
  const { spawn, execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { TMUX_IDENTITY_SCRIPT } = await import("./tmuxIdentity.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "termany-identity-"));
  const children: import("node:child_process").ChildProcess[] = [];
  try {
    async function holder(sessionId: string) {
      const file = path.join(dir, `rollout-test-${sessionId}.jsonl`);
      const child = spawn(process.execPath, ["-e", 'require("fs").openSync(process.argv[1], "w"); process.stdout.write("ready"); setInterval(()=>{},1000)', file], { stdio: ["ignore", "pipe", "ignore"] });
      children.push(child);
      await new Promise<void>(resolve => child.stdout!.once("data", () => resolve()));
      return child;
    }
    const owner = await holder(id);
    const unrelated = await holder(other);
    // A Claude process is found through its session record, not an open file.
    const claudeDir = path.join(dir, "claude");
    fs.mkdirSync(path.join(claudeDir, "sessions"), { recursive: true });
    fs.writeFileSync(path.join(claudeDir, "sessions", `${unrelated.pid}.json`), JSON.stringify({ pid: unrelated.pid, sessionId: id }));
    const { stdout } = await promisify(execFile)("/bin/sh", ["-c", TMUX_IDENTITY_SCRIPT, "termany", String(owner.pid), String(unrelated.pid)], {
      timeout: 5000, env: { ...process.env, CLAUDE_CONFIG_DIR: claudeDir },
    });
    const panes = parseIdentityOutput(stdout);
    assert.equal(transcriptIdentity(panes.get(owner.pid!)!, "codex"), id);
    assert.ok(!panes.get(owner.pid!)!.includes(other));
    assert.equal(transcriptIdentity(panes.get(unrelated.pid!)!, "claude"), id);
  } finally {
    children.forEach(child => child.kill());
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
