import assert from "node:assert/strict";
import test from "node:test";
import { parseSrcRange, rangeHasAdded, srcRange } from "./markdownMinimap";

test("source ranges round-trip through data-src", () => {
  assert.equal(srcRange(4), "4-4");
  assert.deepEqual(parseSrcRange(srcRange(3, 9)), [3, 9]);
  assert.equal(parseSrcRange(undefined), null);
  assert.equal(parseSrcRange("3"), null);
});

test("a block is added when any of its source lines is", () => {
  const added = [2, 7, 8, 15];
  assert.equal(rangeHasAdded(added, 3, 6), false);
  assert.equal(rangeHasAdded(added, 3, 7), true);
  assert.equal(rangeHasAdded(added, 8, 8), true);
  assert.equal(rangeHasAdded(added, 16, 40), false);
  assert.equal(rangeHasAdded(added, 1, 1), false);
  assert.equal(rangeHasAdded([], 1, 100), false);
});
