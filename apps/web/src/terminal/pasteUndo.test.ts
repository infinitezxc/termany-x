import assert from "node:assert/strict";
import test from "node:test";
import headless from "@xterm/headless";
import type { IBuffer } from "@xterm/xterm";
import { PasteUndo, textBeforeCursor } from "./pasteUndo";

function paste(text: string) {
  const undo = new PasteUndo();
  undo.paste(text, (value) => undo.input(`\x1b[200~${value}\x1b[201~`));
  return undo;
}

test("undo preserves existing Codex input and consumes the paste once", () => {
  const undo = paste("pasted");
  assert.equal(undo.takeCodexUndo("› existing pasted"), "\x7f".repeat(6));
  assert.equal(undo.takeCodexUndo("› existing pasted"), null);
});

test("typing, submission, cursor movement and deletion invalidate paste undo", () => {
  for (const input of ["a", "\r", "\x1b[D", "\x7f"]) {
    const undo = paste("pasted");
    undo.input(input);
    assert.equal(undo.takeCodexUndo("› pasted"), null);
  }
});

test("focus and mouse reports leave paste undo available", () => {
  const undo = paste("pasted");
  for (const input of ["\x1b[I", "\x1b[O", "\x1b[<35;2;2M", "\x1b[12;20R"]) undo.input(input);
  assert.equal(undo.takeCodexUndo("› pasted"), "\x7f".repeat(6));
});

test("only removes a matching large Codex paste placeholder", () => {
  for (const suffix of ["", " #2"]) {
    assert.equal(paste("x".repeat(1001)).takeCodexUndo(`› before [Pasted Content 1001 chars]${suffix}`), "\x7f");
  }
  assert.equal(paste("x".repeat(1001)).takeCodexUndo("› [Pasted Content 2000 chars]"), null);
});

test("rejects changed output and explicitly cleared records", () => {
  assert.equal(paste("pasted").takeCodexUndo("› something else"), null);
  const undo = paste("pasted");
  undo.clear();
  assert.equal(undo.takeCodexUndo("› pasted"), null);
});

test("counts Unicode graphemes and normalizes pasted line endings", () => {
  assert.equal(paste("中👨‍👩‍👧e\u0301").takeCodexUndo("› 中👨‍👩‍👧e\u0301"), "\x7f".repeat(3));
  assert.equal(paste("a\r\nb").takeCodexUndo("› a\nb"), "\x7f".repeat(3));
  assert.equal(paste("中文🙂").takeCodexUndo("› 中文🙂 "), "\x7f".repeat(3));
});

test("matches Codex continuation gutters and its own wrapping", () => {
  assert.equal(paste("first\nsecond").takeCodexUndo("› beforefirst\n  second"), "\x7f".repeat(12));
  assert.equal(paste("longword").takeCodexUndo("› beforelong\n  word"), "\x7f".repeat(8));
});

test("reads Unicode text across soft terminal wraps without inventing newlines", async () => {
  const term = new headless.Terminal({ cols: 10, rows: 5, allowProposedApi: true });
  try {
    await new Promise<void>((resolve) => term.write("› before 中pasted", resolve));
    assert.equal(textBeforeCursor(term.buffer.active as unknown as IBuffer).trimStart(), "› before 中pasted");
  } finally { term.dispose(); }
});
