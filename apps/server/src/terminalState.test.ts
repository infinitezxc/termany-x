import assert from "node:assert/strict";
import test from "node:test";
import xterm from "@xterm/headless";
import { TerminalState } from "./terminalState.js";
import { restoreTerminalSnapshot } from "../../../packages/core/src/terminal-restore.js";
import type { TerminalSnapshot } from "../../../packages/core/src/backend.js";

const write = (term: InstanceType<typeof xterm.Terminal>, data: string) => new Promise<void>((r) => term.write(data, r));
const snapshot = (state: TerminalState) => new Promise<TerminalSnapshot>((r) => { void state.snapshot(r); });
function screen(term: InstanceType<typeof xterm.Terminal>) {
  const buffer = term.buffer.active;
  return {
    type: buffer.type, baseY: buffer.baseY, cursorX: buffer.cursorX, cursorY: buffer.cursorY,
    lines: Array.from({ length: buffer.length }, (_, y) => buffer.getLine(y)?.translateToString(true)),
  };
}

test("reattached Codex redraws match the uninterrupted terminal without extra rows", async () => {
  const state = new TerminalState();
  const original = new xterm.Terminal({ cols: 66, rows: 46, scrollback: 5000, allowProposedApi: true });
  const reopened = new xterm.Terminal({ allowProposedApi: true, scrollback: 5000 });
  try {
    state.resize(66, 46);
    const output = "earlier answer\r\n".repeat(100) + "\x1b[2;1H\x1b[Janswer before quit\r\n› prompt\x1b[?2004h";
    state.write(output);
    await write(original, output);
    // Output while the app is closed must be included in the live snapshot.
    const detached = "\x1b[2;1H\x1b[Janswer while closed\r\n› prompt";
    state.write(detached);
    await write(original, detached);
    await restoreTerminalSnapshot(reopened, await snapshot(state), true);
    assert.deepEqual(screen(reopened), screen(original));
    assert.equal(reopened.modes.bracketedPasteMode, true);
    const redraw = "\x1b[46;1H\r\n\x1b[2;1H\x1b[Jnext answer\r\n› prompt";
    await write(original, redraw);
    await write(reopened, redraw);
    assert.deepEqual(screen(reopened), screen(original));
  } finally { state.dispose(); original.dispose(); reopened.dispose(); }
});

test("live alternate-screen reattachment keeps the active buffer and primary history", async () => {
  const state = new TerminalState();
  const reopened = new xterm.Terminal({ allowProposedApi: true, scrollback: 5000 });
  try {
    state.write("shell history\r\n".repeat(100) + "\x1b[?1049h\x1b[Hfullscreen editor\x1b[5;4H\x1b[?2004h");
    await restoreTerminalSnapshot(reopened, await snapshot(state), true);
    assert.equal(reopened.buffer.active.type, "alternate");
    assert.equal(reopened.buffer.active.cursorY, 4);
    assert.equal(reopened.buffer.active.cursorX, 3);
    assert.equal(reopened.modes.bracketedPasteMode, true);
    assert.match(reopened.buffer.normal.getLine(0)!.translateToString(true), /shell history/);
    await write(reopened, "\x1b[?1049l");
    assert.equal(reopened.buffer.active.type, "normal");
  } finally { state.dispose(); reopened.dispose(); }
});

test("snapshot is a barrier between included output and subsequent deltas", async () => {
  const state = new TerminalState();
  const events: string[] = [];
  state.write("before\r\n", () => events.push("before"));
  const captured = snapshot(state).then((value) => { events.push("snapshot"); return value; });
  state.write("after", () => events.push("after"));
  await snapshot(state);
  const value = await captured;
  assert.deepEqual(events, ["before", "snapshot", "after"]);
  assert.match(value.data, /before/);
  assert.doesNotMatch(value.data, /after/);
  state.dispose();
});

test("reattachment preserves scroll margins, origin mode and hidden cursor", async () => {
  const state = new TerminalState();
  const original = new xterm.Terminal({ allowProposedApi: true });
  const reopened = new xterm.Terminal({ allowProposedApi: true });
  try {
    const setup = "\x1b[3;10r\x1b[?6h\x1b[8;1Hbottom of region\x1b[?25l\x1b[?1002h\x1b[?1006h";
    state.write(setup);
    await write(original, setup);
    const saved = await snapshot(state);
    await restoreTerminalSnapshot(reopened, saved, true);
    assert.deepEqual(screen(reopened), screen(original));
    assert.match(saved.data, /\x1b\[\?25l/);
    assert.match(saved.data, /\x1b\[\?1006h/);
    await write(original, "\r\nnext region line");
    await write(reopened, "\r\nnext region line");
    assert.deepEqual(screen(reopened), screen(original));
  } finally { state.dispose(); original.dispose(); reopened.dispose(); }
});

test("the retained screen can answer cursor queries while the app is closed", async () => {
  const state = new TerminalState();
  const replies: string[] = [];
  state.onResponse((data) => replies.push(data));
  state.write("\x1b[5;7H\x1b[6n");
  await snapshot(state);
  assert.deepEqual(replies, ["\x1b[5;7R"]);
  state.dispose();
});
