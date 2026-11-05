// Test support: a private, real tmux server reached the way the app reaches a
// host, for tests where tmux's own behavior is what matters.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, type IPty } from "node-pty";

export const hasTmux = (() => { try { execFileSync("tmux", ["-V"]); return true; } catch { return false; } })();
export const skipWithoutTmux = { skip: !hasTmux && "tmux is not installed" };

const ENV = ["PATH", "TMUX_TMPDIR", "TMUX", "LC_ALL", "SHELL"] as const;

/**
 * Run `body` against a tmux server of its own. `ssh` runs its command here, so
 * remote operations given no connection arguments reach this server.
 */
export async function withTmuxServer(body: (root: string) => Promise<void>): Promise<void> {
  // tmux sockets are limited to ~100 characters, so keep the directory short.
  const root = mkdtempSync(path.join(tmpdir().length > 60 ? "/tmp" : tmpdir(), "tx-"));
  const bin = path.join(root, "bin"); mkdirSync(bin);
  writeFileSync(path.join(bin, "ssh"), '#!/bin/sh\nfor arg; do last=$arg; done\nexec /bin/sh -c "$last"\n', { mode: 0o755 });
  const previous = Object.fromEntries(ENV.map((key) => [key, process.env[key]]));
  process.env.PATH = `${bin}:${previous.PATH}`;
  process.env.TMUX_TMPDIR = root;
  // SSH logins often have no UTF-8 locale; tmux then rewrites control
  // characters in its output, which once broke list parsing.
  process.env.LC_ALL = "C";
  // Session commands run through the login shell; keep it quick.
  process.env.SHELL = "/bin/sh";
  delete process.env.TMUX;
  try {
    await body(root);
  } finally {
    try { execFileSync("tmux", ["kill-server"]); } catch { /* already gone */ }
    for (const key of ENV) {
      if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    }
    rmSync(root, { recursive: true, force: true });
  }
}

/** Run an attach command in a terminal, as an SSH pane does. */
export function spawnClient(command: string, cols = 80, rows = 24): IPty {
  return spawn("/bin/sh", ["-c", command], { name: "xterm-256color", cols, rows, env: process.env as Record<string, string> });
}

/** Attach with `command`, wait for tmux to draw, then detach: what the client was sent. */
export async function attachOnce(session: string, command: string): Promise<string> {
  const pty = spawnClient(command);
  let output = "";
  pty.onData((data) => { output += data; });
  const exited = new Promise<void>((resolve) => pty.onExit(() => resolve()));
  // tmux shows the cursor once it has drawn the session.
  for (let i = 0; i < 100 && !output.includes("\x1b[?25h"); i++) await new Promise((r) => setTimeout(r, 20));
  execFileSync("tmux", ["detach-client", "-s", `=${session}`]);
  await exited;
  return output;
}

/** Whether a client was drawn on the alternate screen. */
export const onAlternateScreen = (output: string) => output.includes("\x1b[?1049h");
