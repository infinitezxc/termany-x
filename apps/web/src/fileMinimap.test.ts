import assert from "node:assert/strict";
import test from "node:test";
import { EditorState } from "@codemirror/state";
import { gitLineChanges, setGitBase, setGitLines } from "./fileGitChanges";
import { addedLineNumbers, lineRuns } from "./fileMinimap";
import { minimapLayout, sliderTarget } from "./minimapStrip";

test("lineRuns merges consecutive added lines", () => {
  assert.deepEqual(lineRuns([]), []);
  assert.deepEqual(lineRuns([1, 2, 3, 7, 9, 10]), [[1, 3], [7, 7], [9, 10]]);
});

test("a long file's slider round-trips exactly through the scroll ratio", () => {
  // 3000 lines in a 600px box: the minimap overflows and scrolls along.
  for (const ratio of [0, 0.1, 0.37, 0.5, 0.92, 1]) {
    // Wrapped lines make topLine disagree with the ratio; the slider must not care.
    const topLine = ratio * 2000;
    const layout = minimapLayout({ lines: 3000, height: 600, ratio, topLine, bottomLine: topLine + 12, rowsVisible: 33 });
    assert.equal(layout.overflow, true);
    assert.equal(layout.sliderHeight, 66);
    const target = sliderTarget(layout.sliderTop, layout, 3000, 600);
    assert.ok("ratio" in target);
    assert.ok(Math.abs(target.ratio - ratio) < 1e-9, `ratio ${ratio} -> ${target.ratio}`);
    // The minimap stays inside its content and puts the top line under the slider.
    assert.ok(layout.offset >= 0 && layout.offset <= 3000 * 2 - 600);
  }
  const mid = minimapLayout({ lines: 3000, height: 600, ratio: 0.5, topLine: 1500, bottomLine: 1533, rowsVisible: 33 });
  assert.equal(1500 * 2 - mid.offset, mid.sliderTop);
  // Dragging past either end clamps.
  assert.deepEqual(sliderTarget(-50, mid, 3000, 600), { ratio: 0 });
  assert.deepEqual(sliderTarget(9999, mid, 3000, 600), { ratio: 1 });
});

test("a short file's slider covers the visible lines and maps back to them", () => {
  const layout = minimapLayout({ lines: 200, height: 600, ratio: 0.3, topLine: 57.5, bottomLine: 90, rowsVisible: 33 });
  assert.equal(layout.overflow, false);
  assert.equal(layout.offset, 0);
  assert.equal(layout.sliderTop, 115);
  assert.equal(layout.sliderHeight, 65);
  assert.deepEqual(sliderTarget(layout.sliderTop, layout, 200, 600), { line: 57.5 });
  assert.deepEqual(sliderTarget(9999, layout, 200, 600), { line: 200 });
});

test("addedLineNumbers reads the git added-line decorations", () => {
  let state = EditorState.create({ doc: "a\nb\nc\nd", extensions: [gitLineChanges] });
  assert.deepEqual(addedLineNumbers(state), []);
  state = state.update({ effects: setGitBase.of("a\nd") }).state;
  state = state.update({ effects: setGitLines.of({ base: "a\nd", doc: state.doc, lines: [2, 3] }) }).state;
  assert.deepEqual(addedLineNumbers(state), [2, 3]);
});

test("a selection-only transaction keeps the added-line set's identity", () => {
  // The minimap re-scans added lines only when this identity changes.
  let state = EditorState.create({ doc: "a\nb\nc", extensions: [gitLineChanges] });
  state = state.update({ effects: setGitBase.of("a") }).state;
  state = state.update({ effects: setGitLines.of({ base: "a", doc: state.doc, lines: [2, 3] }) }).state;
  const before = state.field(gitLineChanges);
  const after = state.update({ selection: { anchor: 3 } }).state.field(gitLineChanges);
  assert.notEqual(after, before);
  assert.equal(after.decorations, before.decorations);
});
