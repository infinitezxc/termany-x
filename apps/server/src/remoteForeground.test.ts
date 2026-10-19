import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node-pty";
import { execFileSync } from "node:child_process";
import { RemoteShellIdentity, remoteForegroundIsShell } from "./remoteForeground.js";
import { sshRemoteDirCommand } from "./ssh.js";

test("remote foreground comparison ignores every background process", () => {
  assert.equal(remoteForegroundIsShell("100 100 100 zsh\n", 100, "zsh"), true);
  assert.equal(remoteForegroundIsShell("100 100 200 zsh\n", 100, "zsh"), false);
  assert.equal(remoteForegroundIsShell("100 100 100 codex\n", 100, "zsh"), false);
  assert.equal(remoteForegroundIsShell("100 100 100 /bin/zsh\n", 100, "-zsh"), true);
  for (const value of ["", "100 100 -1", "100 100 0", "200 100 100", "error", "100 100"]) {
    assert.equal(remoteForegroundIsShell(value, 100, "zsh"), undefined);
  }
});

test("remote shell identity survives split startup output", () => {
  const identity = new RemoteShellIdentity();
  for (const char of "welcome\r\n\x1b]779;termany-shell;1234;sh\x07") identity.noteOutput(char);
  assert.equal(identity.pid, 1234);
  assert.equal(identity.shellName, "sh");
  identity.noteOutput("\x1b]779;termany-shell;5678;zsh\x07");
  assert.equal(identity.pid, 1234);
});

test("remote shell marker is parsed before a large startup chunk is truncated", () => {
  for (const split of [false, true]) {
    const identity = new RemoteShellIdentity();
    const marker = "\x1b]779;termany-shell;1234;zsh\x1b\\";
    if (split) identity.noteOutput(marker.slice(0, 15));
    identity.noteOutput((split ? marker.slice(15) : marker) + "banner\n".repeat(2000));
    assert.equal(identity.pid, 1234);
    assert.equal(identity.shellName, "zsh");
  }
});

test("real remote-style PTY reports shell foreground despite a background job", {
  skip: process.platform === "win32",
}, async () => {
  const pty = spawn("/bin/sh", ["-c", sshRemoteDirCommand("", true)], {
    name: "xterm-256color", cols: 80, rows: 24,
    env: { ...process.env, SHELL: "/bin/sh", PS1: "$ " },
  });
  const identity = new RemoteShellIdentity();
  let output = "";
  pty.onData((data) => { identity.noteOutput(data); output += data; });
  const waitFor = async (predicate: () => boolean) => {
    const deadline = Date.now() + 3000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error("PTY did not reach expected state");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  const read = () => remoteForegroundIsShell(execFileSync("ps", ["-o", "pid=", "-o", "pgid=", "-o", "tpgid=", "-o", "comm=", "-p", String(identity.pid)], { encoding: "utf8" }), identity.pid!, identity.shellName!);
  try {
    await waitFor(() => !!identity.pid && /\$ /.test(output));
    assert.equal(read(), true);
    pty.write("sleep 20 &\r");
    await waitFor(() => /\[1\]/.test(output));
    assert.equal(read(), true, "background sleep must not own the foreground");
    pty.write("sleep 20\r");
    await waitFor(() => read() === false);
    pty.write("\x03");
    await waitFor(() => read() === true);
    // Replacing the shell preserves its pid and foreground process group.
    // A foreground executable must still be reported as a command.
    pty.write("kill %1 2>/dev/null; exec sleep 20\r");
    await waitFor(() => read() === false);
    const replaced = execFileSync("ps", ["-o", "pid=", "-o", "pgid=", "-o", "tpgid=", "-o", "comm=", "-p", String(identity.pid)], { encoding: "utf8" });
    assert.match(replaced, /sleep/);
  } finally {
    pty.write("kill %1 2>/dev/null; exit\r");
    pty.kill();
  }
});
