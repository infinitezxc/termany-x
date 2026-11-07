import { test } from "node:test";
import assert from "node:assert/strict";
import { DOM_DELTA_LINE, DOM_DELTA_PAGE, DOM_DELTA_PIXEL, WheelLineAccumulator } from "./wheelScroll";

const opts = { rowHeight: 20, rows: 30 };

test("pixel deltas accumulate fractional rows across trackpad events", () => {
  const acc = new WheelLineAccumulator();
  assert.equal(acc.lines({ deltaY: 8, deltaMode: DOM_DELTA_PIXEL }, opts), 0);
  assert.equal(acc.lines({ deltaY: 8, deltaMode: DOM_DELTA_PIXEL }, opts), 0);
  assert.equal(acc.lines({ deltaY: 8, deltaMode: DOM_DELTA_PIXEL }, opts), 1);
  assert.equal(acc.lines({ deltaY: 100, deltaMode: DOM_DELTA_PIXEL }, opts), 5);
});

test("reversing direction drops the leftover fraction", () => {
  const acc = new WheelLineAccumulator();
  assert.equal(acc.lines({ deltaY: 15, deltaMode: DOM_DELTA_PIXEL }, opts), 0);
  assert.equal(acc.lines({ deltaY: -20, deltaMode: DOM_DELTA_PIXEL }, opts), -1);
});

test("line and page modes and the Alt fast-scroll multiplier", () => {
  const acc = new WheelLineAccumulator();
  assert.equal(acc.lines({ deltaY: -3, deltaMode: DOM_DELTA_LINE }, opts), -3);
  assert.equal(acc.lines({ deltaY: 1, deltaMode: DOM_DELTA_PAGE }, opts), 30);
  assert.equal(acc.lines({ deltaY: 3, deltaMode: DOM_DELTA_LINE, altKey: true }, opts), 15);
  assert.equal(acc.lines({ deltaY: 0, deltaMode: DOM_DELTA_LINE }, opts), 0);
  assert.equal(acc.lines({ deltaY: 40, deltaMode: DOM_DELTA_PIXEL }, { rowHeight: 0, rows: 30 }), 0);
});
