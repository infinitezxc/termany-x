/**
 * The shell-exit wire protocol, end to end against a real server and a real PTY.
 *
 * The frontend decides whether a dead shell should take its pane with it (see
 * apps/web/src/terminal/shellExit.ts). That decision is only as good as the exit
 * status reaching it, and the status travels on the WebSocket CLOSE frame — a
 * path no unit test covers, since it involves node-pty, the ws server, and the
 * browser's CloseEvent semantics all agreeing.
 *
 * Runs the server under a throwaway HOME so it never touches ~/.termany.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const SHELL_EXIT_CLOSE_CODE = 4000;
// Offset by pid so concurrent runs (or a leftover server from a killed run)
// can't collide on the port.
const PORT = 51000 + (process.pid % 4000);
const SERVER_ENTRY = fileURLToPath(new URL("../src/index.ts", import.meta.url));

let server: ChildProcess;
let home: string;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "termany-shell-exit-"));
  server = spawn(process.execPath, ["--import", "tsx", SERVER_ENTRY], {
    env: {
      ...process.env,
      HOME: home,
      TERMANY_PORT: String(PORT),
      // bash rather than the developer's own shell: the assertions below depend
      // on POSIX `exit`/EOF status semantics, not on someone's zsh config.
      TERMANY_SHELL: "/bin/bash",
    },
    stdio: "ignore",
  });
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(`http://localhost:${PORT}/api/health`);
      return;
    } catch {
      await sleep(200);
    }
  }
  throw new Error(`server did not start on port ${PORT}`);
});

after(() => {
  server?.kill("SIGKILL");
  if (home) fs.rmSync(home, { recursive: true, force: true });
});

/**
 * Type `command` into a fresh session and report how the CLOSE frame described
 * the shell's death. Uses Node's built-in WHATWG WebSocket, so the CloseEvent
 * observed here is the one WebSocketBackend sees in the browser.
 */
async function exitStatusOf(session: string, command: string): Promise<unknown> {
  const closed = new Promise<{ code: number; reason: string }>((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/?session=${session}`);
    const timer = setTimeout(() => reject(new Error(`${session} never closed`)), 20_000);
    ws.addEventListener("open", () => {
      // Let bash finish its startup and print a prompt before typing at it.
      setTimeout(() => ws.send(JSON.stringify({ type: "input", data: command })), 1200);
    });
    ws.addEventListener("close", (event) => {
      clearTimeout(timer);
      resolve({ code: event.code, reason: event.reason });
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error(`${session} socket error`));
    });
  });
  const { code, reason } = await closed;
  assert.equal(code, SHELL_EXIT_CLOSE_CODE, `expected a shell-exit close frame, got ${code}`);
  return JSON.parse(reason);
}

test("a deliberate exit reports a clean status", async () => {
  assert.deepEqual(await exitStatusOf("test-clean-exit", "true\nexit\n"), {
    exitCode: 0,
    signal: 0,
  });
});

test("EOF after a failed command reports that command's status", async () => {
  // Ctrl+D is still the user asking to close the pane, but bash hands back the
  // last command's status — so the frontend must NOT read a non-zero code here
  // as "crashed". Locking the behaviour in: this is the case that makes an
  // exit-code-only rule wrong.
  assert.deepEqual(await exitStatusOf("test-eof-after-failure", "false\n\x04"), {
    exitCode: 1,
    signal: 0,
  });
});

test("a signalled kill is distinguishable from a clean exit", async () => {
  // The exit code alone is 0 here — identical to a graceful `exit`. Only the
  // signal separates "the OS killed my shell" from "the user closed the pane",
  // which is why it has to survive the trip to the frontend.
  assert.deepEqual(await exitStatusOf("test-signalled", "kill -9 $$\n"), {
    exitCode: 0,
    signal: 9,
  });
});

test("replacing a pane shell keeps the replacement available for reattachment", async () => {
  const session = "test-history-replacement";
  const sockets: WebSocket[] = [];
  const connect = async () => {
    const ws = new WebSocket(`ws://localhost:${PORT}/?session=${session}`);
    sockets.push(ws);
    let output = "";
    ws.addEventListener("message", (event) => { output += String(event.data); });
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", () => reject(new Error("connection failed")), { once: true });
    });
    // A prompt confirms the new shell has finished starting, or that an
    // existing shell's replay has arrived. The PID distinguishes those cases.
    for (let i = 0; i < 200 && !/[#$] /.test(output); i++) await sleep(50);
    output = "";
    ws.send(JSON.stringify({ type: "input", data: 'printf "__PANE_PID__%s\\n" "$$"\n' }));
    for (let i = 0; i < 200; i++) {
      const pid = output.match(/__PANE_PID__(\d+)/)?.[1];
      if (pid) return pid;
      await sleep(50);
    }
    throw new Error("shell did not report its PID");
  };
  try {
    const original = await connect();
    const forgotten = await fetch(`http://localhost:${PORT}/api/forget`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: [session], paneIds: [session] }),
    });
    assert.equal(forgotten.ok, true);
    const replacement = await connect();
    assert.notEqual(replacement, original, "history resume must start a fresh shell");
    await sleep(200);
    assert.equal(await connect(), replacement, "late exit must not discard the replacement");
  } finally {
    for (const ws of sockets) ws.close();
  }
});
