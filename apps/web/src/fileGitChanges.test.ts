import assert from "node:assert/strict";
import test from "node:test";
import type { EditorView, ViewUpdate } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { addedGitLines } from "./fileGitDiff";
import { sharedGitDiffWorker } from "./gitDiffWorkerClient";
import { gitLineChanges, setGitBase, setGitLines, GitDiffUpdater } from "./fileGitChanges";

test("inline Git changes mark only current added/replacement lines", async () => {
  assert.deepEqual(await addedGitLines("a\nb\nc\n", "a\nnew\nb\nc\n"), [2]);
  assert.deepEqual(await addedGitLines("a\nb\nc\n", "a\nc\n"), []);
  assert.deepEqual(await addedGitLines("a\nb\nc\n", "a\nreplacement\nc\n"), [2]);
  assert.deepEqual(await addedGitLines("", "new\nfile\n"), [1, 2]);
  assert.deepEqual(await addedGitLines("same\r\n", "same\n"), []);
  assert.deepEqual(await addedGitLines("same\n", "same\n"), []);
  assert.deepEqual(await addedGitLines("", ""), []);
  assert.deepEqual(await addedGitLines("", "x".repeat(512 * 1024 + 1)), undefined);
});

test("decorations survive unavailable diffs and reject late results", () => {
  let state = EditorState.create({ doc: "a\nb\n", extensions: [gitLineChanges] });
  state = state.update({ effects: setGitBase.of("a\n") }).state;
  const initialDoc = state.doc;
  state = state.update({ effects: setGitLines.of({ base: "a\n", doc: state.doc, lines: [2] }) }).state;
  assert.equal(state.field(gitLineChanges).decorations.size, 1);
  state = state.update({ changes: { from: 0, insert: "intro\n" } }).state;
  const decoration = state.field(gitLineChanges).decorations.iter();
  assert.equal(decoration.from, state.doc.line(3).from);
  state = state.update({ effects: setGitLines.of({ base: "a\n", doc: state.doc, lines: undefined }) }).state;
  assert.equal(state.field(gitLineChanges).decorations.size, 1);
  state = state.update({ effects: setGitLines.of({ base: "a\n", doc: initialDoc, lines: [] }) }).state;
  assert.equal(state.field(gitLineChanges).decorations.size, 1);
  state = state.update({ effects: setGitLines.of({ base: "wrong baseline", doc: state.doc, lines: [] }) }).state;
  assert.equal(state.field(gitLineChanges).decorations.size, 1);
  // A successful empty diff really does clear the highlights.
  state = state.update({ effects: setGitLines.of({ base: "a\n", doc: state.doc, lines: [] }) }).state;
  assert.equal(state.field(gitLineChanges).decorations.size, 0);
  assert.equal(state.doc.toString(), "intro\na\nb\n");
});

test("diff updates debounce typing and cancel when the editor is destroyed", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(sharedGitDiffWorker, "request", async (_owner: object, base: string, current: string) => addedGitLines(base, current));
  let state = EditorState.create({ doc: "first\n", extensions: [gitLineChanges] });
  state = state.update({ effects: setGitBase.of("") }).state;
  let applied = 0;
  const view = {
    get state() { return state; },
    dispatch(spec: Parameters<EditorState["update"]>[0]) {
      applied++;
      state = state.update(spec).state;
    },
  } as unknown as EditorView;
  const updater = new GitDiffUpdater(view);
  t.mock.timers.tick(100);
  const oldState = state;
  state = state.update({ changes: { from: 0, insert: "second\n" } }).state;
  updater.update({ docChanged: true, startState: oldState, state } as ViewUpdate);
  t.mock.timers.tick(100);
  await Promise.resolve();
  assert.equal(applied, 0);
  t.mock.timers.tick(50);
  await Promise.resolve();
  assert.equal(applied, 1);
  assert.equal(state.field(gitLineChanges).decorations.size, 2);
  updater.schedule();
  updater.destroy();
  t.mock.timers.tick(200);
  await Promise.resolve();
  assert.equal(applied, 1);
});

test("large untracked files keep their decorations on the keystroke path", async () => {
  const doc = "new line\n".repeat(50_000);
  let state = EditorState.create({ doc, extensions: [gitLineChanges] });
  state = state.update({ effects: setGitBase.of("") }).state;
  const lines = await addedGitLines("", doc);
  assert.equal(lines?.length, 50_000);
  state = state.update({ effects: setGitLines.of({ base: "", doc: state.doc, lines }) }).state;
  state = state.update({ changes: { from: 0, insert: "x" } }).state;
  assert.equal(state.field(gitLineChanges).decorations.size, 50_000);
});

test("many modified lines receive the same decoration as inserted lines", async () => {
  const base = Array.from({ length: 80 }, (_, i) => `original ${i}\nunchanged ${i}\n`).join("");
  const current = Array.from({ length: 80 }, (_, i) => `changed ${i}\nunchanged ${i}\n`).join("") + "added line\n";
  const lines = await addedGitLines(base, current);
  assert.deepEqual(lines, [...Array.from({ length: 80 }, (_, i) => i * 2 + 1), 161]);
  let state = EditorState.create({ doc: current, extensions: [gitLineChanges] });
  state = state.update({ effects: setGitBase.of(base) }).state;
  state = state.update({ effects: setGitLines.of({ base, doc: state.doc, lines }) }).state;
  const decorations = state.field(gitLineChanges).decorations;
  assert.equal(decorations.size, 81);
  const classes = new Set<string>();
  decorations.between(0, state.doc.length, (_from, _to, decoration) => {
    classes.add(decoration.spec.attributes.class);
  });
  assert.deepEqual([...classes], ["cm-git-added-line"]);
});
