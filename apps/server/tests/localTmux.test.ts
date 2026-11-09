import assert from "node:assert/strict";
import test from "node:test";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

let tmux: string | undefined;
try { tmux = execFileSync("which", ["tmux"], { encoding: "utf8" }).trim(); } catch {}

test("local tmux survives server restart, restores history, tracks cwd and releases attachments", { skip: !tmux, timeout: 30_000 }, async () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "tl-")));
  const cwd = path.join(dir, "working directory"); mkdirSync(cwd);
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: dir, SHELL: "/bin/sh", TMUX_TMPDIR: dir, TMUX: "", TERMANY_PORT: String(46000 + process.pid % 1000) };
  const base = `http://127.0.0.1:${env.TERMANY_PORT}`;
  const name = "termany-codex-local-test";
  let server: ChildProcess | undefined;
  const sockets: WebSocket[] = [];
  const delay = () => new Promise(r => setTimeout(r, 50));
  async function until(check: () => Promise<boolean> | boolean, message: string) {
    for (let i = 0; i < 160; i++) { if (await check()) return; await delay(); }
    assert.fail(message);
  }
  const api = async (route: string, body?: object) => {
    const response = await fetch(base + route, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : undefined);
    const text = await response.text();
    assert.equal(response.status, 200, `${route}: ${text}`);
    const result = JSON.parse(text);
    return result;
  };
  async function start() {
    server = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("../src/index.ts", import.meta.url))], { env, stdio: "ignore" });
    await until(async () => { try { return (await fetch(base + "/api/state")).ok; } catch { return false; } }, "server starts");
  }
  async function stop() {
    if (!server || server.exitCode !== null) return;
    const exited = new Promise(resolve => server!.once("exit", resolve));
    server.kill("SIGTERM"); await exited;
  }
  function connect() {
    const ws = new WebSocket(`${base.replace("http", "ws")}/?${new URLSearchParams({ session: "local-pane", tmux: name })}`);
    sockets.push(ws);
    let output = "";
    let restored = "";
    ws.addEventListener("message", async e => {
      if (typeof e.data === "string") output += e.data;
      else {
        const message = JSON.parse(await e.data.text());
        if (message.type === "restore") restored = message.snapshot.data;
      }
    });
    return { ws, output: () => output, restored: () => restored };
  }
  const inspect = (format: string) => execFileSync(tmux!, ["display-message", "-p", "-t", `=${name}:`, format], { env, encoding: "utf8" }).trim();
  try {
    await start();
    assert.equal((await api("/api/tmux/available")).available, true);
    await api("/api/tmux/create", { session: "local-pane", name, cwd, agent: "claude", command: "exec /bin/sh" });
    const pid = inspect("#{pane_pid}");
    const first = connect();
    await until(() => first.ws.readyState === WebSocket.OPEN && inspect("#{session_attached}") === "1", "local client attaches");
    first.ws.send(JSON.stringify({ type: "input", data: "printf 'LOCAL_AGENT_READY\\n'; i=0; while [ $i -lt 100 ]; do echo SCROLLBACK_$i; i=$((i+1)); done\r" }));
    await until(() => first.output().includes("SCROLLBACK_99"), "agent emits history");
    const sessions = (await api("/api/tmux?session=local-pane")).sessions;
    assert.ok(sessions.some((s: any) => s.name === name && s.agent === "claude"));
    assert.equal((await api("/api/fs/list?session=local-pane")).path, cwd);
    // An attached session cannot be deleted through the picker.
    const denied = await fetch(base + "/api/tmux/kill", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ session: "local-pane", name }) });
    assert.equal(denied.status, 400);
    await stop();
    await until(() => inspect("#{session_attached}") === "0", "server shutdown detaches its client");
    assert.equal(inspect("#{pane_pid}"), pid, "agent process survives");
    await start();
    const second = connect();
    await until(() => second.ws.readyState === WebSocket.OPEN && inspect("#{session_attached}") === "1", "client reconnects after restart");
    assert.equal(inspect("#{pane_pid}"), pid, "reattaches the original process");
    await until(() => second.restored().includes("SCROLLBACK_0"), "tmux scrollback reaches the reconnected client");
    second.ws.send(JSON.stringify({ type: "input", data: "printf 'RECONNECTED_OK\\n'\r" }));
    await until(() => second.output().includes("RECONNECTED_OK"), "reattached terminal accepts input");
    const history = execFileSync(tmux!, ["capture-pane", "-p", "-S", "-", "-t", `=${name}:`], { env, encoding: "utf8" });
    assert.match(history, /SCROLLBACK_0/);
    await stop();
    await start();
    await api("/api/tmux/kill", { session: "local-pane", name });
    assert.deepEqual((await api("/api/tmux?session=local-pane")).sessions, []);
    // A stale SSH pane must never accidentally operate on local sessions.
    assert.equal((await fetch(base + "/api/tmux?session=gone:ssh:host")).status, 400);
    await stop();
    const emptyBin = path.join(dir, "empty-bin"); mkdirSync(emptyBin);
    const shell = path.join(dir, "path-shell");
    writeFileSync(shell, '#!/bin/sh\nprintf "__termany_shell__%s\\n" "$PATH"\n', { mode: 0o755 });
    env.SHELL = shell;
    env.PATH = emptyBin;
    await start();
    assert.equal((await api("/api/tmux/available")).available, false);
    assert.deepEqual((await api("/api/tmux?session=local-pane")).sessions, []);
  } finally {
    sockets.forEach(ws => ws.close());
    await stop();
    try { execFileSync(tmux!, ["kill-server"], { env, stdio: "ignore" }); } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
});
