import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFile } from "node:child_process";
import { deleteAgentSession, listAgentSessions, listAgentUsage, listRemoteAgentUsage, normalizeUsageRange, normalizeUsageSince } from "./agentSessions.js";

const now = new Date(2026, 7, 3, 12, 0, 0);

test("usage defaults to the server's local today", () => {
  assert.equal(normalizeUsageSince(undefined, now), "2026-08-03");
});

test("usage accepts dates inside the rolling 366-day window", () => {
  assert.equal(normalizeUsageSince("2026-08-01", now), "2026-08-01");
  assert.equal(normalizeUsageSince("2026-07-04", now), "2026-07-04");
  assert.equal(normalizeUsageSince("2025-08-03", now), "2025-08-03");
});

test("usage clamps older dates to at most 366 calendar days", () => {
  assert.equal(normalizeUsageSince("2020-01-01", now), "2025-08-03");
});

test("usage range is the request intersected with the supported window", () => {
  assert.deepEqual(normalizeUsageRange(undefined, undefined, now), { since: "2026-08-03", until: "2026-08-03" });
  assert.deepEqual(normalizeUsageRange("2026-07-01", undefined, now), { since: "2026-07-01", until: "2026-08-03" });
  assert.deepEqual(normalizeUsageRange("2026-07-01", "2026-07-15", now), { since: "2026-07-01", until: "2026-07-15" });
  assert.deepEqual(normalizeUsageRange("2026-07-01", "2026-07-01", now), { since: "2026-07-01", until: "2026-07-01" });
  assert.deepEqual(normalizeUsageRange("2020-01-01", "2025-09-01", now), { since: "2025-08-03", until: "2025-09-01" });
  assert.deepEqual(normalizeUsageRange("2026-08-01", "2027-01-01", now), { since: "2026-08-01", until: "2026-08-03" });
  assert.deepEqual(normalizeUsageRange("2026-07-01", "2026-02-30", now), { since: "2026-07-01", until: "2026-08-03" });
});

test("since-only usage requests keep the original fallbacks", () => {
  // Same results as normalizeUsageSince, through the path the API actually uses.
  for (const since of [undefined, "not-a-date", "2026-02-30", "2026-08-04", "2026-08-01", "2020-01-01"]) {
    assert.deepEqual(normalizeUsageRange(since, undefined, now), { since: normalizeUsageSince(since, now), until: "2026-08-03" });
  }
  assert.deepEqual(normalizeUsageRange("2026-08-04", undefined, now), { since: "2026-08-03", until: "2026-08-03" });
});

test("usage range is empty when nothing of it lies inside the window", () => {
  assert.equal(normalizeUsageRange("2024-01-01", "2024-01-31", now), null); // wholly before the window
  assert.equal(normalizeUsageRange("2026-07-15", "2026-07-01", now), null); // inverted
  assert.equal(normalizeUsageRange("2026-08-04", "2026-08-10", now), null); // wholly in the future
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
    const assistant = (id: string, text: string, input: number, model = "claude-opus-4-5", project = cwd) =>
      JSON.stringify({
        type: "assistant",
        cwd: project,
        timestamp: ts,
        requestId: `req_${id}`,
        message: {
          id: `msg_${id}`,
          model,
          content: [{ type: "text", text }],
          usage: { input_tokens: input, cache_creation_input_tokens: 7, cache_read_input_tokens: 11, output_tokens: 5 },
        },
      });
    const claudeSessionId = "0123abcd-0000-4000-8000-0123456789ab";
    await fs.promises.writeFile(
      path.join(claudeDir, `${claudeSessionId}.jsonl`),
      [
        JSON.stringify({ type: "user", cwd, timestamp: ts, message: { content: "x".repeat(200_000) } }),
        assistant("a", "é\\\"".repeat(5_000), 3),
        assistant("a", "duplicate block of the same message", 3),
        assistant("b", "short", 13),
      ].join("\n"),
    );
    const subagents = path.join(claudeDir, claudeSessionId, "subagents");
    await fs.promises.mkdir(subagents, { recursive: true });
    const subagentProject = path.join(cwd, "worktree");
    await fs.promises.writeFile(
      path.join(subagents, "agent-test.jsonl"),
      [
        assistant("a", "copied from the parent transcript", 3, "claude-opus-4-5", subagentProject),
        assistant("c", "subagent response", 23, "claude-opus-5-5", subagentProject),
        assistant("c", "duplicate subagent block", 23, "claude-opus-5-5", subagentProject),
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
    assert.equal(local.length, 3);
    assert.deepEqual(
      local.filter((row) => row.agent === "claude").map(({ model, project, input, output, cacheRead, cacheWrite }) =>
        ({ model, project, input, output, cacheRead, cacheWrite })),
      [
        { model: "claude-opus-4-5", project: cwd, input: 16, output: 10, cacheRead: 22, cacheWrite: 14 },
        { model: "claude-opus-5-5", project: subagentProject, input: 23, output: 5, cacheRead: 11, cacheWrite: 7 },
      ],
    );
    assert.deepEqual(await listRemoteAgentUsage(exec, "host", undefined), local);
    // A range wholly before the window must report nothing, not the newer usage.
    assert.deepEqual(await listAgentUsage("2024-01-01", "2024-01-31"), []);
    assert.deepEqual(await listRemoteAgentUsage(exec, "host", "2024-01-01", "2024-01-31"), []);
    // A range ending before today's usage excludes it, locally and over SSH.
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const y = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, "0")}-${String(yesterday.getDate()).padStart(2, "0")}`;
    assert.deepEqual(await listAgentUsage("2024-01-01", y), []);
    assert.deepEqual(await listRemoteAgentUsage(exec, "host", "2024-01-01", y), []);
    assert.deepEqual(await listRemoteAgentUsage(exec, "host", "2024-01-01", undefined), local);
    // A future since-only request falls back to today, as it always has.
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tm = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, "0")}-${String(tomorrow.getDate()).padStart(2, "0")}`;
    assert.deepEqual(await listAgentUsage(tm), local);
    assert.deepEqual(await listRemoteAgentUsage(exec, "host", tm), local);
    assert.deepEqual((await listAgentSessions("claude")).sessions?.map((session) => session.sessionId), [claudeSessionId]);
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await fs.promises.rm(home, { recursive: true, force: true });
  }
});

test("session history shows each agent's own title above the first prompt", async () => {
  const originalHome = process.env.HOME;
  const home = await fs.promises.mkdtemp(path.join(os.tmpdir(), "termany-agent-titles-"));
  try {
    process.env.HOME = home;
    // Claude appends its AI title again every few turns; the last one is current.
    const claudeDir = path.join(home, ".claude", "projects", "-proj");
    await fs.promises.mkdir(claudeDir, { recursive: true });
    const aiTitle = (aiTitle: string) => JSON.stringify({ type: "ai-title", aiTitle, sessionId: "x" });
    const filler = Array.from({ length: 60 }, () => JSON.stringify({ type: "assistant", message: { content: "ok" } }));
    await fs.promises.writeFile(
      path.join(claudeDir, "11111111-1111-1111-1111-111111111111.jsonl"),
      [
        JSON.stringify({ type: "user", cwd: home, message: { content: "fix the flaky login test" } }),
        aiTitle("Login test"),
        ...filler,
        aiTitle("Fix flaky login test"),
      ].join("\n") + "\n",
    );
    const claude = await listAgentSessions("claude");
    assert.deepEqual(claude.sessions?.map((s) => [s.title, s.preview]), [["Fix flaky login test", "fix the flaky login test"]]);

    // Codex names threads in an index: first after the prompt cut short, then properly.
    const codexDir = path.join(home, ".codex", "sessions", "2026", "08", "03");
    await fs.promises.mkdir(codexDir, { recursive: true });
    for (const [id, prompt] of [["named", "why does the build fail on arm64"], ["unnamed", "check disk"]]) {
      await fs.promises.writeFile(
        path.join(codexDir, `rollout-${id}.jsonl`),
        [
          JSON.stringify({ type: "session_meta", payload: { id, cwd: home } }),
          JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: prompt } }),
        ].join("\n"),
      );
    }
    await fs.promises.writeFile(
      path.join(home, ".codex", "session_index.jsonl"),
      [
        { id: "named", thread_name: "why does the build fa" },
        { id: "unnamed", thread_name: "check disk" },
        { id: "named", thread_name: "Diagnose arm64 build" },
      ].map((e) => JSON.stringify(e)).join("\n") + "\n",
    );
    const codex = await listAgentSessions("codex");
    assert.deepEqual(
      codex.sessions?.map((s) => [s.sessionId, s.title]).sort(),
      [["named", "Diagnose arm64 build"], ["unnamed", undefined]],
    );
  } finally {
    process.env.HOME = originalHome;
    await fs.promises.rm(home, { recursive: true, force: true });
  }
});

test("deleting a session removes its transcript and folder, unless it was just active", async () => {
  const originalHome = process.env.HOME;
  const home = await fs.promises.mkdtemp(path.join(os.tmpdir(), "termany-agent-delete-"));
  try {
    process.env.HOME = home;
    const dir = path.join(home, ".claude", "projects", "-proj");
    const old = "11111111-1111-1111-1111-111111111111";
    const live = "22222222-2222-2222-2222-222222222222";
    await fs.promises.mkdir(path.join(dir, old, "tool-results"), { recursive: true });
    for (const id of [old, live]) {
      await fs.promises.writeFile(path.join(dir, `${id}.jsonl`), JSON.stringify({ type: "user", cwd: home, message: { content: id } }) + "\n");
    }
    const hourAgo = new Date(Date.now() - 60 * 60_000);
    await fs.promises.utimes(path.join(dir, `${old}.jsonl`), hourAgo, hourAgo);

    await deleteAgentSession("claude", old);
    assert.equal(fs.existsSync(path.join(dir, `${old}.jsonl`)), false);
    assert.equal(fs.existsSync(path.join(dir, old)), false);
    assert.deepEqual((await listAgentSessions("claude")).sessions?.map((s) => s.sessionId), [live]);

    await assert.rejects(deleteAgentSession("claude", live), /active in the last 2 minutes/);
    assert.equal(fs.existsSync(path.join(dir, `${live}.jsonl`)), true);
    await assert.rejects(deleteAgentSession("claude", "33333333-3333-3333-3333-333333333333"), /not found/);
  } finally {
    process.env.HOME = originalHome;
    await fs.promises.rm(home, { recursive: true, force: true });
  }
});
