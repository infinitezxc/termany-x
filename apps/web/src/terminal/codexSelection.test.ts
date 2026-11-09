import assert from "node:assert/strict";
import test from "node:test";
import type { Terminal } from "@xterm/xterm";
import { installCodexSelection } from "./codexSelection";

class Mouse {
  button = 0; buttons = 1; detail = 1; clientX = 0; clientY = 5;
  screenX = 0; screenY = 0; view = null;
  shiftKey = false; altKey = false; ctrlKey = false; metaKey = false;
  target: Target | null = null; stopped = false; prevented = false;
  constructor(public type: string, init: object = {}) { Object.assign(this, init); }
  preventDefault() { this.prevented = true; }
  stopImmediatePropagation() { this.stopped = true; }
}
class Target {
  listeners = new Map<string, Set<(event: Mouse) => void>>();
  replayed: Mouse[] = [];
  addEventListener(type: string, fn: (event: Mouse) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }
  removeEventListener(type: string, fn: (event: Mouse) => void) { this.listeners.get(type)?.delete(fn); }
  emit(event: Mouse) {
    event.target ??= this;
    for (const fn of this.listeners.get(event.type) ?? []) { fn(event); if (event.stopped) break; }
  }
  dispatchEvent(event: Mouse) { this.replayed.push(event); this.emit(event); return true; }
}

/** An 80x24 terminal of 10x20 cells on Codex's full-screen view. */
function harness() {
  const doc = new Target();
  const screen = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 480 }) };
  const element = Object.assign(new Target(), { ownerDocument: doc, querySelector: () => screen });
  let codex = true;
  let forget = () => {};
  const term = {
    element, cols: 80, rows: 24, focus() {}, modes: { mouseTrackingMode: "any" },
    onResize(fn: () => void) { forget = fn; return { dispose() {} }; },
    buffer: {
      onBufferChange() { return { dispose() {} }; },
      active: { type: "alternate", viewportY: 0, getLine: () => ({ getCell: () => ({ getWidth: () => 1 }) }) },
    },
  };
  const cleanup = installCodexSelection(term as unknown as Terminal, () => codex);
  const row = (n: number) => n * 20 + 5;
  const down = (x: number, y: number, extra = {}) => { const e = new Mouse("mousedown", { clientX: x, clientY: y, ...extra }); element.emit(e); return e; };
  const move = (x: number, y: number) => { const e = new Mouse("mousemove", { clientX: x, clientY: y }); doc.emit(e); return e; };
  const up = (x: number, y: number) => { const e = new Mouse("mouseup", { clientX: x, clientY: y, buttons: 0 }); doc.emit(e); return e; };
  return { term, element, doc, cleanup, row, down, move, up, forget: () => forget(), setCodex: (value: boolean) => { codex = value; } };
}

const nativeMouse = globalThis.MouseEvent;
test.before(() => { globalThis.MouseEvent = Mouse as unknown as typeof MouseEvent; });
test.after(() => { globalThis.MouseEvent = nativeMouse; });

test("a drag is Codex's, its press starting past the cell an upward drag would lose", () => {
  for (const [to, press] of [[12, 45], [8, 55]] as const) {
    const h = harness();
    assert.equal(h.down(42, h.row(10)).stopped, true, "the press is held back");
    h.move(43, h.row(10));
    assert.equal(h.element.replayed.length, 0, "not yet a drag");
    h.move(42, h.row(to));
    assert.deepEqual(h.element.replayed.map(e => [e.type, e.clientX, e.clientY]), [["mousedown", press, 210]]);
    assert.deepEqual(h.doc.replayed.map(e => [e.type, e.clientY]), [["mousemove", h.row(to)]], "the starting move is reported too");
    assert.equal(h.move(30, h.row(15)).stopped, false, "the rest of the drag reaches Codex");
    assert.equal(h.up(30, h.row(15)).stopped, false, "so does the release, for Codex to copy");
    h.cleanup.dispose();
  }
});

test("past the bottom Codex is shown its own last row first, once per visit", () => {
  const h = harness();
  h.down(42, h.row(10));
  for (const y of [405, 600, 700, 300, 600]) h.move(42, y);
  assert.deepEqual(h.doc.replayed.map(e => e.clientY), [405, 450, 450]);
  h.cleanup.dispose();
});

test("clicks are replayed once with their original coordinates", () => {
  const h = harness();
  h.down(42, h.row(3)); h.move(43, h.row(3));
  assert.equal(h.up(42, h.row(3)).stopped, true);
  assert.deepEqual(h.element.replayed.map(e => [e.type, e.clientX, e.clientY]), [["mousedown", 42, h.row(3)], ["mouseup", 42, h.row(3)]]);
});

test("modified, multi-click and other-button gestures, other agents and other screens pass through", () => {
  type Case = [string, (h: ReturnType<typeof harness>) => void, object?];
  const cases: Case[] = [
    ...[{ shiftKey: true }, { altKey: true }, { ctrlKey: true }, { metaKey: true }, { detail: 2 }, { button: 2 }]
      .map((extra): Case => [JSON.stringify(extra), () => {}, extra]),
    ["another agent", h => h.setCodex(false)],
    ["normal screen", h => { h.term.buffer.active.type = "normal"; }],
    ["no mouse reporting", h => { h.term.modes.mouseTrackingMode = "none"; }],
  ];
  for (const [name, setup, extra] of cases) {
    const h = harness();
    setup(h);
    assert.equal(h.down(42, h.row(10), extra).stopped, false, name);
    h.move(42, h.row(15)); h.up(42, h.row(15));
    assert.equal(h.element.replayed.length + h.doc.replayed.length, 0, name);
    h.cleanup.dispose();
  }
});

test("a held-back press is forgotten on resize, and disposal removes every listener", () => {
  const h = harness();
  h.down(42, h.row(10));
  h.forget();
  h.move(42, h.row(15));
  assert.equal(h.element.replayed.length, 0);
  h.cleanup.dispose();
  for (const target of [h.element, h.doc]) for (const set of target.listeners.values()) assert.equal(set.size, 0);
});
