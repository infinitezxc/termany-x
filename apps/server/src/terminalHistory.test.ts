import assert from "node:assert/strict";
import test from "node:test";
import xtermPkg from "@xterm/headless";
import serializePkg from "@xterm/addon-serialize";
import { captureHistory } from "./terminalHistory.js";

const { Terminal } = xtermPkg as unknown as { Terminal: any };
const { SerializeAddon } = serializePkg;
const write = (term: any, data: string) => new Promise<void>((resolve) => term.write(data, resolve));
function terminal(cols = 80, rows = 24) {
  const term = new Terminal({ cols, rows, scrollback: 5000, allowProposedApi: true });
  const serializer = new SerializeAddon();
  term.loadAddon(serializer);
  return { term, serializer };
}
function text(term: any): string {
  const buf = term.buffer.normal;
  return Array.from({ length: buf.length }, (_, row) => buf.getLine(row)?.translateToString(true)).join("\n");
}

test("Codex-style redraws restore multiple pages, colors, and earlier scrollback", async () => {
  const original = terminal();
  const restored = terminal();
  try {
    await write(original.term, "\x1b[31moldest answer\x1b[0m\r\n" +
      Array.from({ length: 180 }, (_, n) => `answer ${n}\r\n`).join(""));
    // Spinner redraws exhaust the old 512 KiB raw ring without adding history.
    await write(original.term, "\rworking\x1b[K".repeat(50000));
    const snapshot = captureHistory(original.term, original.serializer);
    assert.ok(snapshot.data.length < 10000);
    await write(restored.term, snapshot.data);
    assert.match(text(restored.term), /oldest answer/);
    assert.match(text(restored.term), /answer 0\n/);
    assert.match(text(restored.term), /answer 179/);
    assert.equal(restored.term.buffer.normal.getLine(0).getCell(0).getFgColor(), 1);
    assert.ok(restored.term.buffer.normal.baseY > 150);
  } finally {
    original.term.dispose(); restored.term.dispose();
  }
});

test("restores at the saved dimensions before reflowing wrapped wide characters", async () => {
  const original = terminal(20, 8);
  const restored = terminal();
  try {
    await write(original.term, ("a wrapped answer 你好 ".repeat(12)) + "\r\nlast answer");
    const snapshot = captureHistory(original.term, original.serializer);
    restored.term.resize(snapshot.cols, snapshot.rows);
    await write(restored.term, snapshot.data);
    assert.equal(text(restored.term), text(original.term));
    restored.term.resize(80, 24);
    assert.match(text(restored.term), /你好/);
    assert.match(text(restored.term), /last answer/);
  } finally {
    original.term.dispose(); restored.term.dispose();
  }
});

test("a fullscreen view retains the primary scrollback on repeated restores", async () => {
  const original = terminal();
  const restored = terminal();
  const reopened = terminal();
  try {
    await write(original.term, "older shell history\r\n" + "output\r\n".repeat(100));
    await write(original.term, "\x1b[?1049h\x1b[Hlatest fullscreen answer\r\ninput prompt");
    const snapshot = captureHistory(original.term, original.serializer);
    await write(restored.term, snapshot.data);
    assert.equal(restored.term.buffer.active.type, "normal");
    assert.match(text(restored.term), /older shell history/);
    assert.match(text(restored.term), /latest fullscreen answer/);
    await write(reopened.term, captureHistory(restored.term, restored.serializer).data);
    assert.equal(text(reopened.term), text(restored.term));
  } finally {
    original.term.dispose(); restored.term.dispose(); reopened.term.dispose();
  }
});
