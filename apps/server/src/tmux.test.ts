import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTmux, killTmux, listTmux, tmuxAttachCommand, tmuxName, tmuxSessionCwd, parseTmuxSessions } from "./tmux.js";

test("tmux names reject control characters and ambiguous target separators", () => {
  for (const value of ["", "a:b", "a.b", "a\nb", null, 12]) assert.throws(() => tmuxName(value));
  assert.equal(tmuxAttachCommand("work's $(echo unsafe)"), "exec tmux attach-session -t '=work'\\''s $(echo unsafe)'");
  assert.equal(tmuxAttachCommand("work"), "exec tmux attach-session -t '=work'");
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
const hasTmux = (() => { try { execFileSync("tmux", ["-V"]); return true; } catch { return false; } })();
test("remote tmux operations work against a real tmux server", { skip: !hasTmux && "tmux is not installed" }, async () => {
  // tmux sockets are limited to ~100 characters, so keep the directory short.
  const root = mkdtempSync(path.join(tmpdir().length > 60 ? "/tmp" : tmpdir(), "tx-"));
  const bin = path.join(root, "bin"); mkdirSync(bin);
  writeFileSync(path.join(bin, "ssh"), '#!/bin/sh\nfor arg; do last=$arg; done\nexec /bin/sh -c "$last"\n', { mode: 0o755 });
  const previous = { PATH: process.env.PATH, TMUX_TMPDIR: process.env.TMUX_TMPDIR, TMUX: process.env.TMUX, LC_ALL: process.env.LC_ALL };
  process.env.PATH = `${bin}:${previous.PATH}`;
  process.env.TMUX_TMPDIR = root;
  // SSH logins often have no UTF-8 locale; tmux then rewrites control
  // characters in its output, which once broke list parsing.
  process.env.LC_ALL = "C";
  delete process.env.TMUX;
  const conversationId = "12345678-1234-1234-1234-123456789012";
  try {
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
  } finally {
    try { execFileSync("tmux", ["kill-server"]); } catch { /* already gone */ }
    process.env.PATH = previous.PATH;
    if (previous.TMUX_TMPDIR === undefined) delete process.env.TMUX_TMPDIR; else process.env.TMUX_TMPDIR = previous.TMUX_TMPDIR;
    if (previous.TMUX !== undefined) process.env.TMUX = previous.TMUX;
    if (previous.LC_ALL === undefined) delete process.env.LC_ALL; else process.env.LC_ALL = previous.LC_ALL;
    rmSync(root, { recursive: true, force: true });
  }
});
