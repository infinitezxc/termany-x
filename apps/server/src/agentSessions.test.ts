import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFile } from "node:child_process";
import { listAgentSessions, listAgentUsage, listRemoteAgentUsage, normalizeUsageSince } from "./agentSessions.js";

const now = new Date(2026, 7, 3, 12, 0, 0);

test("usage defaults to the server's local today", () => {
  assert.equal(normalizeUsageSince(undefined, now), "2026-08-03");
});

test("usage accepts dates inside the rolling 31-day window", () => {
  assert.equal(normalizeUsageSince("2026-08-01", now), "2026-08-01");
  assert.equal(normalizeUsageSince("2026-07-04", now), "2026-07-04");
});

test("usage clamps older dates to at most 31 calendar days", () => {
  assert.equal(normalizeUsageSince("2020-01-01", now), "2026-07-04");
});

test("usage rejects invalid and future dates", () => {
  assert.equal(normalizeUsageSince("2026-02-30", now), "2026-08-03");
  assert.equal(normalizeUsageSince("2026-08-04", now), "2026-08-03");
  assert.equal(normalizeUsageSince("not-a-date", now), "2026-08-03");
});

test("session history returns newest files one page at a time", async () => {
  const originalHome = process.env.HOME;
  const home = await fs.promises.mkdtemp(path.join(os.tmpdir(), "termany-agent-sessions-"));
  try {
    process.env.HOME = home;
    const dir = path.join(home, ".codex", "sessions", "2026", "08", "03");
    await fs.promises.mkdir(dir, { recursive: true });
    for (let i = 1; i <= 3; i++) {
      const id = `session-${i}`;
      const file = path.join(dir, `rollout-${i}.jsonl`);
      await fs.promises.writeFile(
        file,
        [
          JSON.stringify({ type: "session_meta", payload: { id, cwd: home, git: { branch: "main" } } }),
          JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: `prompt ${i}` } }),
        ].join("\n")
      );
      const mtime = new Date(2026, 7, 3, 12, i, 0);
      await fs.promises.utimes(file, mtime, mtime);
    }

    const first = await listAgentSessions("codex", [], 0, 2);
    assert.deepEqual(first.sessions?.map((session) => session.sessionId), ["session-3", "session-2"]);
    assert.equal(first.nextCursor, "2");

    const second = await listAgentSessions("codex", [], Number(first.nextCursor), 2);
    assert.deepEqual(second.sessions?.map((session) => session.sessionId), ["session-1"]);
    assert.equal(second.nextCursor, null);
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await fs.promises.rm(home, { recursive: true, force: true });
  }
});

test("remote usage matches the local reader on the same transcripts", async () => {
  const originalHome = process.env.HOME;
  const home = await fs.promises.mkdtemp(path.join(os.tmpdir(), "termany-agent-usage-"));
  try {
    process.env.HOME = home;
    const ts = new Date().toISOString();
    const cwd = path.join(home, "proj \"quoted\"");
    const claudeDir = path.join(home, ".claude", "projects", "-proj");
    await fs.promises.mkdir(claudeDir, { recursive: true });
    const assistant = (id: string, text: string, input: number) =>
      JSON.stringify({
        type: "assistant",
        cwd,
        timestamp: ts,
        requestId: `req_${id}`,
        message: {
          id: `msg_${id}`,
          model: "claude-opus-4-5",
          content: [{ type: "text", text }],
          usage: { input_tokens: input, cache_creation_input_tokens: 7, cache_read_input_tokens: 11, output_tokens: 5 },
        },
      });
    await fs.promises.writeFile(
      path.join(claudeDir, "0123abcd-0000-4000-8000-0123456789ab.jsonl"),
      [
        JSON.stringify({ type: "user", cwd, timestamp: ts, message: { content: "x".repeat(200_000) } }),
        assistant("a", "é\\\"".repeat(5_000), 3),
        assistant("a", "duplicate block of the same message", 3),
        assistant("b", "short", 13),
      ].join("\n"),
    );
    const codexDir = path.join(home, ".codex", "sessions", "2026", "10", "08");
    await fs.promises.mkdir(codexDir, { recursive: true });
    await fs.promises.writeFile(
      path.join(codexDir, "rollout-1.jsonl"),
      [
        JSON.stringify({ type: "session_meta", payload: { id: "codex-1", cwd, base_instructions: "y".repeat(100_000) } }),
        JSON.stringify({ type: "turn_context", payload: { model: "gpt-5" } }),
        JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "z".repeat(50_000) } }),
        JSON.stringify({
          timestamp: ts,
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              total_token_usage: { input_tokens: 40, cached_input_tokens: 10, output_tokens: 4, total_tokens: 44 },
              last_token_usage: { input_tokens: 40, cached_input_tokens: 10, output_tokens: 4, total_tokens: 44 },
            },
          },
        }),
      ].join("\n"),
    );

    const exec = (script: string, args: string[]) =>
      new Promise<Buffer>((resolve, reject) =>
        execFile("sh", ["-c", script, "termany", ...args], { encoding: "buffer", maxBuffer: 64 << 20 }, (err, out) =>
          err ? reject(err) : resolve(out),
        ),
      );
    const local = await listAgentUsage();
    assert.equal(local.length, 2);
    assert.deepEqual(await listRemoteAgentUsage(exec, "host", undefined), local);
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await fs.promises.rm(home, { recursive: true, force: true });
  }
});
