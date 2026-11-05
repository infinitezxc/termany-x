import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTmux, killTmux, listTmux, tmuxAttachCommand, tmuxName, tmuxSessionCwd, parseTmuxSessions } from "./tmux.js";
import { attachOnce, onAlternateScreen, skipWithoutTmux, withTmuxServer } from "./tmuxTestServer.js";

test("tmux names reject control characters and ambiguous target separators", () => {
  for (const value of ["", "a:b", "a.b", "a\nb", null, 12]) assert.throws(() => tmuxName(value));
  // The name reaches the script as an argument, never as script text.
  assert.match(tmuxAttachCommand("work's $(echo unsafe)", 5),
    / 'sh' '=work'\\''s \$\(echo unsafe\)' '=work'\\''s \$\(echo unsafe\):' '' '5'$/);
  assert.match(tmuxAttachCommand("codex-1", 5), / 'sh' '=codex-1' '=codex-1:' '1' '5'$/);
  // Each attach has its own slot.
  assert.notEqual(tmuxAttachCommand("work"), tmuxAttachCommand("work"));
});

test("remote tmux operations preserve arguments and distinguish empty servers from errors", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "termany-tmux-test-"));
  const bin = path.join(root, "bin"); mkdirSync(bin);
  const log = path.join(root, "args");
  const previous = process.env.PATH;
  process.env.PATH = `${bin}:${previous}`;
  process.env.TERMANY_TMUX_TEST_LOG = log;
  writeFileSync(path.join(bin, "ssh"), '#!/bin/sh\nfor arg; do last=$arg; done\nexec /bin/sh -c "$last"\n', { mode: 0o755 });
  writeFileSync(path.join(bin, "tmux"), `#!/bin/sh
printf '%s\\n' "$@" > "$TERMANY_TMUX_TEST_LOG"
case "$1" in
display-message)
  for arg; do last=$arg; done
  if [ "$last" = '#{session_attached}' ]; then echo "\${TERMANY_TMUX_TEST_ATTACHED:-0}"; exit 0; fi
  printf '/project/current dir\\n';;
list-sessions)
  case "$TERMANY_TMUX_TEST_MODE" in
    empty) echo 'no server running on /tmp/tmux-test/default' >&2; exit 1;;
    error) echo 'permission denied' >&2; exit 1;;
  esac
  printf '$1:2:1:1700000000::::work space\\n';;
esac
`, { mode: 0o755 });
  try {
    assert.deepEqual(await listTmux([]), [{ id: "$1", windows: 2, attached: 1, created: 1700000000, name: "work space" }]);
    await createTmux([], { name: "work space", cwd: "/tmp/a'$(touch should-not-exist)", command: "codex resume 'a b'" });
    const args = readFileSync(log, "utf8");
    assert.ok(args.includes("\nwork space\n-c\n/tmp/a'$(touch should-not-exist)\n"));
    assert.ok(args.includes('exec "${SHELL:-/bin/sh}" -lic'));
    assert.equal(await tmuxSessionCwd([], "work space"), "/project/current dir");
    assert.equal(readFileSync(log, "utf8"), "display-message\n-p\n-t\n=work space:\n#{pane_current_path}\n");
    const conversationId = "12345678-1234-1234-1234-123456789012";
    await createTmux([], { name: "tracked", command: "claude", agent: "claude", conversationId });
    const metadataArgs = readFileSync(log, "utf8");
    assert.ok(metadataArgs.includes("\n;\nset-option\n-t\n=tracked:\n@termany-agent\nclaude\n"));
    assert.ok(metadataArgs.includes(`@termany-conversation\n${conversationId}\n`));
    assert.equal(parseTmuxSessions(`$2:1:0:10:claude:${conversationId}:123:label`)[0].conversationId, conversationId);
    await killTmux([], "work space");
    assert.equal(readFileSync(log, "utf8"), "kill-session\n-t\n=work space\n");
    process.env.TERMANY_TMUX_TEST_ATTACHED = "1";
    await assert.rejects(killTmux([], "work space"), /open in a terminal/);
    assert.ok(readFileSync(log, "utf8").startsWith("display-message"), "an attached session is never killed");
    delete process.env.TERMANY_TMUX_TEST_ATTACHED;
    process.env.TERMANY_TMUX_TEST_MODE = "empty";
    assert.deepEqual(await listTmux([]), []);
    process.env.TERMANY_TMUX_TEST_MODE = "error";
    await assert.rejects(listTmux([]), /permission denied/);
    await assert.rejects(createTmux([], { name: "-bad" }), /Use letters/);
    await assert.rejects(createTmux([], { name: "safe", command: "codex\nrm x" }), /Invalid/);
    rmSync(path.join(bin, "tmux"));
    symlinkSync("/bin/sh", path.join(bin, "sh"));
    symlinkSync("/bin/sleep", path.join(bin, "sleep"));
    process.env.PATH = bin;
    await assert.rejects(listTmux([]), /tmux is not installed/);
  } finally {
    process.env.PATH = previous;
    delete process.env.TERMANY_TMUX_TEST_LOG;
    delete process.env.TERMANY_TMUX_TEST_MODE;
    delete process.env.TERMANY_TMUX_TEST_ATTACHED;
    rmSync(root, { recursive: true, force: true });
  }
});

// The fake tmux above only checks arguments; this runs the same operations on
// a real, private tmux server, where target syntax actually matters.
test("remote tmux operations work against a real tmux server", skipWithoutTmux, () => withTmuxServer(async (root) => {
  const conversationId = "12345678-1234-1234-1234-123456789012";
  await createTmux([], { name: "work", cwd: root, command: "sleep 60", agent: "claude", conversationId });
  // A prefix of another session's name must not match it.
  await createTmux([], { name: "work two", cwd: "/", command: "sleep 60" });
  const work = (await listTmux([])).find(s => s.name === "work");
  assert.equal(work?.windows, 1);
  assert.equal(work?.agent, "claude");
  assert.equal(work?.conversationId, conversationId);
  assert.equal(await tmuxSessionCwd([], "work"), root);
  await killTmux([], "work");
  assert.deepEqual((await listTmux([])).map(s => s.name), ["work two"]);
  await assert.rejects(killTmux([], "missing"), /can't find session|No such tmux session/);
}));

test("only agent sessions attach on the normal screen, and only their own client", skipWithoutTmux, () => withTmuxServer(async () => {
  const overrides = () => execFileSync("tmux", ["show-options", "-s", "terminal-overrides"]).toString();
  await createTmux([], { name: "agent", cwd: "/", command: "sleep 60", agent: "codex" });
  execFileSync("tmux", ["set-option", "-s", "terminal-overrides[0]", "mine:foo"]);
  await createTmux([], { name: "plain", cwd: "/", command: "sleep 60" });
  const agent = await attachOnce("agent", tmuxAttachCommand("agent"));
  assert.ok(agent.includes("\x1b[?25h"), "the client drew the session");
  assert.ok(!onAlternateScreen(agent));
  assert.ok(onAlternateScreen(await attachOnce("plain", tmuxAttachCommand("plain"))));

  // No other client attaches while the entry exists: under load, every
  // Termany client is on the normal screen, and every other client is not.
  const load = Array.from({ length: 8 }, (_, i) => i);
  for (const i of load) {
    await createTmux([], { name: `ours ${i}`, cwd: "/", command: "sleep 60", agent: "codex" });
    await createTmux([], { name: `theirs ${i}`, cwd: "/", command: "sleep 60", agent: "codex" });
  }
  for (let round = 0; round < 3; round++) {
    const [ours, theirs] = await Promise.all([
      Promise.all(load.map(i => attachOnce(`ours ${i}`, tmuxAttachCommand(`ours ${i}`)))),
      Promise.all(load.map(i => attachOnce(`theirs ${i}`, `exec tmux attach-session -t '=theirs ${i}'`))),
    ]);
    for (const client of ours) assert.ok(!onAlternateScreen(client));
    for (const client of theirs) assert.ok(onAlternateScreen(client));
  }

  // A slot already in use is left as it is, and that client goes without.
  execFileSync("tmux", ["set-option", "-s", "terminal-overrides[1000000]", "theirs:bar"]);
  assert.ok(onAlternateScreen(await attachOnce("agent", tmuxAttachCommand("agent", 1_000_000))));
  assert.equal(execFileSync("tmux", ["show-options", "-sv", "terminal-overrides[1000000]"]).toString(), "theirs:bar\n");
  execFileSync("tmux", ["set-option", "-su", "terminal-overrides[1000000]"]);
  assert.equal(overrides(), "terminal-overrides[0] mine:foo\n");
}));

test("an attach to a session that has ended never sets the entry", skipWithoutTmux, () => withTmuxServer(async (root) => {
  // tmux skips the rest of a command after a failure, so an entry set before
  // a failing attach would outlive it, for other clients to pick up.
  const log = path.join(root, "set-option.log");
  await createTmux([], { name: "keep", cwd: "/", command: "sleep 60" });
  execFileSync("tmux", ["set-hook", "-g", "after-set-option", `run-shell 'echo set >> ${log}'`]);
  assert.throws(() => execFileSync("/bin/sh", ["-c", tmuxAttachCommand("codex-ended")], { stdio: "pipe" }));
  await new Promise((r) => setTimeout(r, 200)); // run-shell runs in the background
  assert.equal(existsSync(log), false);
  assert.equal(execFileSync("tmux", ["show-options", "-s", "terminal-overrides"]).toString(), "terminal-overrides\n");
}));
