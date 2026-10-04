import assert from "node:assert/strict";
import test from "node:test";
import { SHELL_EXIT_CLOSE_CODE, encodeShellExit, parseShellExit } from "@termany/core";
import { RESTART_HEALTHY_MS, shellExitDisposition, sshExitDisposition } from "./shellExit";

const LONG_LIVED = RESTART_HEALTHY_MS + 1;
const JUST_SPAWNED = 120;

test("a shell the user exited on purpose closes its pane", () => {
  // `exit` / Ctrl+D at an interactive prompt, last command succeeded.
  assert.equal(shellExitDisposition({ exitCode: 0 }, LONG_LIVED), "close-pane");
});

test("Ctrl+D after a failed command still closes the pane", () => {
  // Both bash and zsh exit with the LAST command's status on EOF, so a
  // deliberate Ctrl+D after `grep` finds nothing arrives here as code 1.
  // Judging that by exit code alone would respawn the pane the user just
  // asked to close — which is the whole bug this logic exists to fix.
  assert.equal(shellExitDisposition({ exitCode: 1 }, LONG_LIVED), "close-pane");
  assert.equal(shellExitDisposition({ exitCode: 127 }, LONG_LIVED), "close-pane");
});

test("a shell that dies instantly restarts instead of closing the pane", () => {
  // The crash-loop case the auto-restart was built for: a bad rc file or a
  // missing shell binary kills every spawn within milliseconds.
  assert.equal(shellExitDisposition({ exitCode: 1 }, JUST_SPAWNED), "restart");
  assert.equal(shellExitDisposition({ exitCode: 0 }, JUST_SPAWNED), "restart");
});

test("a shell killed by a signal restarts however long it lived", () => {
  // Segfault, OOM killer, `kill -9` — never something the user asked for, so
  // the pane stays and gets a fresh shell.
  assert.equal(shellExitDisposition({ exitCode: 0, signal: 9 }, LONG_LIVED), "restart");
  assert.equal(shellExitDisposition({ exitCode: 139, signal: 11 }, LONG_LIVED), "restart");
});

test("signal 0 is 'not signalled', not signal number zero", () => {
  // node-pty reports 0/undefined for a plain exit; only a real signal number
  // counts as an abnormal kill.
  assert.equal(shellExitDisposition({ exitCode: 0, signal: 0 }, LONG_LIVED), "close-pane");
  assert.equal(shellExitDisposition({ exitCode: 0, signal: undefined }, LONG_LIVED), "close-pane");
});

test("an exit with no payload restarts rather than closing the pane", () => {
  // The socket closed without the server reporting how the shell ended (server
  // shutdown, or a second connection displacing this one). Closing a pane is
  // destructive and irreversible, so it needs positive evidence — without it,
  // fall back to the pre-existing auto-restart behaviour.
  assert.equal(shellExitDisposition(undefined, LONG_LIVED), "restart");
  assert.equal(shellExitDisposition(undefined, JUST_SPAWNED), "restart");
});

test("the healthy-uptime boundary is exclusive", () => {
  assert.equal(shellExitDisposition({ exitCode: 0 }, RESTART_HEALTHY_MS), "restart");
  assert.equal(shellExitDisposition({ exitCode: 0 }, RESTART_HEALTHY_MS + 1), "close-pane");
});

// --- the wire format the disposition above is fed from ----------------------

test("an exit status survives the round trip through a close frame", () => {
  for (const exit of [{ exitCode: 0 }, { exitCode: 1 }, { exitCode: 137, signal: 9 }]) {
    const encoded = encodeShellExit(exit);
    assert.ok(
      Buffer.byteLength(encoded, "utf8") <= 123,
      "close reasons are capped at 123 bytes by the WebSocket spec"
    );
    assert.deepEqual(parseShellExit(SHELL_EXIT_CLOSE_CODE, encoded), {
      exitCode: exit.exitCode,
      signal: exit.signal ?? 0,
    });
  }
});

test("only the shell-exit close code carries a status", () => {
  const payload = encodeShellExit({ exitCode: 0 });
  // 1000/1001/1006 are ordinary transport closes — the server shutting down, a
  // newer connection taking over, a dropped socket. None of them says anything
  // about how the shell ended, so none may be read as a clean exit.
  assert.equal(parseShellExit(1000, payload), undefined);
  assert.equal(parseShellExit(1006, ""), undefined);
  assert.equal(parseShellExit(1001, payload), undefined);
});

test("a malformed payload reads as unknown rather than as a clean exit", () => {
  // Anything that would otherwise default exitCode to 0 must not: "unknown"
  // keeps the pane, "clean" destroys it.
  for (const bad of ["", "not json", "{}", "null", "[]", '{"exitCode":"0"}']) {
    assert.equal(parseShellExit(SHELL_EXIT_CLOSE_CODE, bad), undefined, `payload: ${bad}`);
  }
});

test("a decoded close frame drives the disposition end to end", () => {
  const decode = (exitCode: number, signal?: number) =>
    parseShellExit(SHELL_EXIT_CLOSE_CODE, encodeShellExit({ exitCode, signal }));
  assert.equal(shellExitDisposition(decode(0), LONG_LIVED), "close-pane");
  assert.equal(shellExitDisposition(decode(1), LONG_LIVED), "close-pane");
  // A SIGKILL reports exitCode 0 (verified against a real PTY in
  // apps/server/tests/shellExit.test.ts) — indistinguishable from a graceful
  // exit unless the signal survives the trip.
  assert.equal(shellExitDisposition(decode(0, 9), LONG_LIVED), "restart");
});

test("an SSH pane whose remote shell exited goes back to a local shell", () => {
  assert.equal(sshExitDisposition({ exitCode: 0 }), "go-local");
  // Ctrl+D after a failed remote command: ssh passes the shell's status through.
  assert.equal(sshExitDisposition({ exitCode: 1 }), "go-local");
});

test("an SSH pane whose connection dropped stays remote and waits to reconnect", () => {
  // OpenSSH exits 255 when the link fails or drops.
  assert.equal(sshExitDisposition({ exitCode: 255 }), "reconnect");
  assert.equal(sshExitDisposition({ exitCode: 0, signal: 9 }), "reconnect");
  assert.equal(sshExitDisposition(undefined), "reconnect");
});
