import assert from "node:assert/strict";
import { test } from "node:test";
import xterm from "@xterm/headless";
import { CappedScrollDetector } from "./tmuxScrollback.js";
import { TerminalState } from "./terminalState.js";
import { createTmux, tmuxAttachCommand, tmuxPaneHistory } from "./tmux.js";
import { skipWithoutTmux, spawnClient, withTmuxServer } from "./tmuxTestServer.js";
import { restoreTerminalSnapshot } from "../../../packages/core/src/terminal-restore.js";
import type { TerminalSnapshot } from "../../../packages/core/src/backend.js";

// Shapes taken from tmux 3.4's output to a client on the normal screen.
test("a scroll as tall as its region is a capped one", () => {
  const capped = "\x1b[1;23r\x1b[23;1H" + "\n".repeat(23) + "\x1b[H118";
  assert.equal(new CappedScrollDetector().feed(capped), true);
  // Codex inserts history in a region above its own rows.
  assert.equal(new CappedScrollDetector().feed("\x1b[1;10r\x1b[10;1H" + "\n".repeat(10)), true);
  for (const uncapped of [
    "\x1b[1;23r\x1b[23;1H" + "\n".repeat(11) + "\x1b[11A140",
    "\x1b[1;10r\x1b[10;1H\n\n\x1b[AL228",
    // A region below the top row never feeds the scrollback.
    "\x1b[5;10r\x1b[10;1H" + "\n".repeat(6),
    "plain\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n\n",
  ]) assert.equal(new CappedScrollDetector().feed(uncapped), false, JSON.stringify(uncapped));
});

test("a capped scroll split across chunks is still seen, once", () => {
  const detector = new CappedScrollDetector();
  assert.equal(detector.feed("output\x1b[1;23"), false);
  assert.equal(detector.feed("r\x1b[23;1H" + "\n".repeat(12)), false);
  assert.equal(detector.feed("\n".repeat(11) + "\x1b[Hnext"), true);
  assert.equal(detector.feed("more output"), false);
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("a burst taller than the screen is restored from the pane's history", skipWithoutTmux, () => withTmuxServer(async () => {
  const state = new TerminalState();
  const reopened = new xterm.Terminal({ allowProposedApi: true, scrollback: 5000 });
  let pty: ReturnType<typeof spawnClient> | undefined;
  try {
    await createTmux([], { name: "agent", cwd: "/", command: "sleep 0.5; seq 1 300; sleep 60", agent: "codex" });
    state.resize(80, 24);
    const detector = new CappedScrollDetector();
    let capped = false;
    let last = Date.now();
    pty = spawnClient(tmuxAttachCommand("agent"));
    pty.onData((data) => {
      state.write(data);
      if (detector.feed(data)) capped = true;
      last = Date.now();
    });
    const deadline = Date.now() + 5000;
    while (!(capped && Date.now() - last > 300) && Date.now() < deadline) await wait(20);
    assert.ok(capped, "tmux capped the scroll");

    const lines = async () => {
      await restoreTerminalSnapshot(reopened, await new Promise<TerminalSnapshot>((r) => { void state.snapshot(r); }), true);
      const buffer = reopened.buffer.active;
      return Array.from({ length: buffer.length }, (_, y) => buffer.getLine(y)!.translateToString(true)).filter((l) => /^\d+$/.test(l));
    };
    const all = Array.from({ length: 300 }, (_, i) => String(i + 1));
    assert.notDeepEqual(await lines(), all, "tmux skipped lines");
    const history = await tmuxPaneHistory([], "agent");
    assert.ok(history);
    assert.equal(await state.replaceScrollback(history), true);
    assert.deepEqual(await lines(), all);
  } finally {
    pty?.kill();
    state.dispose(); reopened.dispose();
  }
}));
