import assert from "node:assert/strict";
import test from "node:test";
import xtermPkg from "@xterm/headless";
import type { IBuffer, IBufferRange } from "@xterm/xterm";
import { cutKeystrokes } from "./cutSelection";

const { Terminal } = xtermPkg;

const LEFT = "\x1b[D";
const RIGHT = "\x1b[C";
const BS = "\x7f";

/** A terminal whose screen shows `text`, with the cursor where it leaves off. */
async function screen(text: string) {
  const term = new Terminal({ cols: 40, rows: 5, allowProposedApi: true });
  await new Promise<void>((resolve) => term.write(text, resolve));
  return term.buffer.active as unknown as IBuffer;
}

/** Selection of columns [from, to) on `row`. */
const sel = (row: number, from: number, to: number): IBufferRange => ({
  start: { x: from, y: row },
  end: { x: to, y: row },
});

test("deletes a selection left of the cursor", async () => {
  const buf = await screen("$ git status"); // cursor at col 12
  assert.equal(cutKeystrokes(buf, sel(0, 2, 5)), LEFT.repeat(7) + BS.repeat(3));
});

test("deletes a selection right of the cursor", async () => {
  const buf = await screen("$ git status\x1b[4G"); // cursor at col 3
  assert.equal(cutKeystrokes(buf, sel(0, 6, 12)), RIGHT.repeat(9) + BS.repeat(6));
});

test("clamps trailing blank cells so they never eat input", async () => {
  const buf = await screen("$ ls"); // cursor at col 4
  assert.equal(cutKeystrokes(buf, sel(0, 2, 20)), BS.repeat(2));
  assert.equal(cutKeystrokes(buf, sel(0, 6, 20)), null);
});

test("counts wide characters once", async () => {
  const buf = await screen("$ 你好x"); // cells: 你=2,3 好=4,5 x=6, cursor 7
  assert.equal(cutKeystrokes(buf, sel(0, 2, 6)), LEFT + BS.repeat(2));
});

test("only copies selections off the cursor row", async () => {
  const buf = await screen("old output\r\n$ ls");
  assert.equal(cutKeystrokes(buf, sel(0, 0, 3)), null);
  assert.equal(cutKeystrokes(buf, { start: { x: 0, y: 0 }, end: { x: 2, y: 1 } }), null);
});

test("leaves full-screen apps alone", async () => {
  const buf = await screen("\x1b[?1049hvim text");
  assert.equal(cutKeystrokes(buf, sel(0, 0, 3)), null);
});
