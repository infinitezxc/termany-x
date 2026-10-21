import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { WebSocketBackend } from "../../../packages/core/src/ws-backend.js";
import type { TerminalSnapshot } from "../../../packages/core/src/backend.js";

// An isolated server/SQLite database verifies the actual flush/reopen protocol.
test("rendered scrollback survives server restart and preserves unmounted panes", { timeout: 30000 }, async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "termany-history-"));
  const port = 57000 + process.pid % 3000;
  const base = `http://localhost:${port}`;
  let server: ChildProcess | undefined;
  async function stop() {
    if (!server || server.exitCode !== null) return;
    const exited = once(server, "exit");
    server.kill("SIGKILL");
    await exited;
  }
  t.after(async () => {
    await stop();
    await fs.rm(home, { recursive: true, force: true });
  });
  async function start() {
    let output = "";
    server = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("../src/index.ts", import.meta.url))], {
      env: { ...process.env, HOME: home, TERMANY_PORT: String(port), TERMANY_SHELL: "/bin/bash" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    server.stdout?.on("data", (chunk) => { output += chunk; });
    server.stderr?.on("data", (chunk) => { output += chunk; });
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        const res = await fetch(`${base}/api/scroll`);
        if (res.ok) return;
      } catch { /* wait for startup */ }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`history test server did not start: ${output}`);
  }
  async function post(route: string, body: unknown) {
    const res = await fetch(`${base}${route}`, {
      method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify(body),
    });
    assert.ok(res.ok, await res.text());
  }
  const until = async (predicate: () => boolean) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    assert.fail("timed out waiting for terminal output");
  };
  const connect = (id: string) => {
    const backend = new WebSocketBackend(`ws://localhost:${port}`, { session: id, restore: "1" });
    t.after(() => backend.dispose());
    const received = { snapshot: undefined as TerminalSnapshot | undefined, output: "", frames: [] as string[] };
    backend.onRestore((snapshot) => { received.snapshot = snapshot; received.frames.push("snapshot"); });
    backend.onData((data) => { received.output += data; received.frames.push("output"); });
    return { backend, received };
  };
  await start();
  const codex = connect("codex");
  codex.backend.resize(120, 40);
  codex.backend.write("printf 'OLDEST%s\\n' '_ANSWER'; for i in $(seq 1 180); do printf 'answer %s\\n' \"$i\"; done; printf 'HISTORY%s\\n' '_READY'\r");
  const background = connect("background");
  background.backend.write("printf 'BACKGROUND%s\\n' '_READY'\r");
  await until(() => codex.received.output.includes("HISTORY_READY") && background.received.output.includes("BACKGROUND_READY"));
  assert.equal(codex.received.frames[0], "snapshot");
  background.backend.dispose();
  await post("/api/scroll/flush", { screens: { legacy: "legacy final screen" } });
  const saved = await (await fetch(`${base}/api/scroll`)).json();
  await stop();
  await start();
  const restored = await (await fetch(`${base}/api/scroll`)).json();
  assert.deepEqual(restored.codex, saved.codex);
  assert.deepEqual(restored.background, saved.background);
  assert.match(restored.legacy, /legacy final screen/);

  // Restarted server: saved history arrives in the same handshake as live restores.
  const resumed = connect("codex");
  await until(() => !!resumed.received.snapshot);
  assert.equal(resumed.received.frames[0], "snapshot");
  assert.match(resumed.received.snapshot!.data, /OLDEST_ANSWER/);
  assert.match(resumed.received.snapshot!.data, /answer 180/);
  const legacy = connect("legacy");
  await until(() => !!legacy.received.snapshot);
  assert.match(legacy.received.snapshot!.data, /legacy final screen/);
  await post("/api/forget", { ids: ["codex"] });
  const forgotten = await (await fetch(`${base}/api/scroll`)).json();
  assert.equal(forgotten.codex, undefined);
  assert.deepEqual(forgotten.background, saved.background);

  // Exercise the same backend class the webview uses against a surviving PTY.
  const backend = new WebSocketBackend(`ws://localhost:${port}`, { session: "live", restore: "1" });
  t.after(() => backend.dispose());
  let output = "";
  backend.onData((data) => { output += data; });
  backend.resize(66, 46);
  backend.write("printf 'READY%s\\n' '_MARKER'\r");
  await until(() => output.includes("READY_MARKER"));
  backend.write("sleep 0.2; printf 'AFTER%s\\n' '_DETACH'\r");
  // Let the input reach the server, then close the webview while it runs.
  await new Promise((resolve) => setTimeout(resolve, 50));
  backend.dispose();
  await new Promise((resolve) => setTimeout(resolve, 300));
  const reattached = new WebSocketBackend(`ws://localhost:${port}`, { session: "live", restore: "1" });
  t.after(() => reattached.dispose());
  let restoredLive: TerminalSnapshot | undefined;
  const frames: string[] = [];
  reattached.onRestore((value) => { restoredLive = value; frames.push("snapshot"); });
  reattached.onData(() => frames.push("output"));
  await until(() => !!restoredLive);
  assert.equal(frames[0], "snapshot");
  assert.equal(restoredLive!.cols, 66);
  assert.equal(restoredLive!.rows, 46);
  assert.match(restoredLive!.data, /READY_MARKER/);
  assert.match(restoredLive!.data, /AFTER_DETACH/);
});
