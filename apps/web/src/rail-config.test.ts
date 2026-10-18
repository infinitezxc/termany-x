import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_RAIL_VISIBILITY,
  normalizeRailVisibility,
  RAIL_ITEM_IDS,
} from "./rail-config";

test("rail icons default to visible", () => {
  assert.deepEqual(normalizeRailVisibility(null), DEFAULT_RAIL_VISIBILITY);
  assert.equal(RAIL_ITEM_IDS.every((id) => DEFAULT_RAIL_VISIBILITY[id]), true);
});

test("rail visibility keeps known booleans and ignores invalid values", () => {
  const visibility = normalizeRailVisibility({
    terminal: false,
    history: false,
    usage: "false",
    unknown: false,
  });

  assert.equal(visibility.terminal, false);
  assert.equal(visibility.history, false);
  assert.equal(visibility.usage, true);
  assert.equal(Object.hasOwn(visibility, "unknown"), false);
});

test("new or missing rail entries remain visible", () => {
  const visibility = normalizeRailVisibility({ terminal: false });
  assert.equal(visibility.terminal, false);
  assert.equal(visibility.monitor, true);
  assert.equal(visibility.usage, true);
});

test("removed rail entries are dropped from saved preferences", () => {
  assert.deepEqual(Object.keys(normalizeRailVisibility({ web: true, agents: true, providers: true })),
    ["terminal", "files", "git", "history", "usage", "monitor"]);
});
