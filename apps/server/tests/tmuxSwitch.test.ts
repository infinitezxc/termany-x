import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

test("the same SSH pane replaces a plain shell or a different tmux target instead of reattaching it", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "termany-tmux-switch-"));
  const bin = path.join(dir, "bin"); mkdirSync(bin);
  writeFileSync(path.join(bin, "ssh"), `#!/bin/sh
for arg; do last=$arg; done
case "$last" in
  *"tmux attach-session"*) printf 'ATTACHED:%s\\n' "$last";;
  *) printf 'PLAIN_SHELL\\n';;
esac
exec /bin/cat
`, { mode: 0o755 });
  const port = 42000 + process.pid % 5000;
  const server = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("../src/index.ts", import.meta.url))], {
    env: { ...process.env, HOME: dir, PATH: `${bin}:${process.env.PATH}`, TERMANY_PORT: String(port) }, stdio: "ignore",
  });
  const sockets: WebSocket[] = [];
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { ready = (await fetch(`http://127.0.0.1:${port}/api/state`)).ok; if (ready) break; } catch {}
      await new Promise(r => setTimeout(r, 100));
    }
    assert.ok(ready, "test server starts");
    async function connect(tmux?: string) {
      const params = new URLSearchParams({ session: "pane:ssh:host", ssh: "host" });
      if (tmux) params.set("tmux", tmux);
      const ws = new WebSocket(`ws://127.0.0.1:${port}/?${params}`); sockets.push(ws);
      return new Promise<string>((resolve, reject) => {
        let output = "";
        const timeout = setTimeout(() => { ws.close(); reject(new Error(`No target output: ${output}`)); }, 5000);
        ws.addEventListener("message", event => {
          if (typeof event.data !== "string") return;
          output += event.data;
          if (output.includes(tmux ? `=${tmux}` : "PLAIN_SHELL")) { clearTimeout(timeout); resolve(output); }
        });
      });
    }
    assert.match(await connect(), /PLAIN_SHELL/);
    assert.match(await connect("codex-one"), /ATTACHED:.*=codex-one/);
    assert.match(await connect("claude-two"), /ATTACHED:.*=claude-two/);
    assert.match(await connect(), /PLAIN_SHELL/);
  } finally {
    sockets.forEach(ws => ws.close()); server.kill("SIGTERM");
    await new Promise<void>(resolve => { if (server.exitCode !== null) resolve(); else server.once("exit", () => resolve()); });
    rmSync(dir, { recursive: true, force: true });
  }
});
