import { sharedGitDiffWorker } from "./gitDiffWorkerClient";
import { StateEffect, StateField, type Text } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";

export const setGitBase = StateEffect.define<string | null>();
export const setGitLines = StateEffect.define<{ base: string; doc: Text; lines: number[] | undefined }>();
const addedLine = Decoration.line({ attributes: { class: "cm-git-added-line" } });
export const gitLineChanges = StateField.define<{ base: string | null; decorations: DecorationSet }>({
  create: () => ({ base: null, decorations: Decoration.none }),
  update(value, tr) {
    let base = value.base;
    // Cheap mapping keeps the previous highlights aligned during typing.
    let decorations = value.decorations.map(tr.changes);
    for (const effect of tr.effects) {
      if (effect.is(setGitBase)) base = effect.value;
      if (effect.is(setGitLines) && effect.value.base === base && effect.value.doc === tr.newDoc && effect.value.lines) {
        decorations = Decoration.set(effect.value.lines
          .filter((line) => line <= tr.newDoc.lines)
          .map((line) => addedLine.range(tr.newDoc.line(line).from)));
      }
    }
    return { base, decorations: base === null ? Decoration.none : decorations };
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
});

/** Debounce edits; one shared worker computes diffs off the UI thread. Late results
 * never apply to a newer document, changed baseline, or destroyed editor. */
export class GitDiffUpdater {
  timer: ReturnType<typeof setTimeout> | undefined;
  generation = 0;
  constructor(readonly view: EditorView) { this.schedule(); }
  update(update: ViewUpdate) {
    if (update.docChanged || update.startState.field(gitLineChanges).base !== update.state.field(gitLineChanges).base) this.schedule();
  }
  schedule() {
    clearTimeout(this.timer);
    sharedGitDiffWorker.cancel(this);
    const generation = ++this.generation;
    this.timer = setTimeout(() => {
      const { state } = this.view;
      const { base } = state.field(gitLineChanges);
      if (base === null || base.length > 512 * 1024 || state.doc.length > 512 * 1024) return;
      void sharedGitDiffWorker.request(this, base, state.doc.toString()).then((lines) => {
        if (generation !== this.generation) return;
        this.view.dispatch({ effects: setGitLines.of({ base, doc: state.doc, lines }) });
      });
    }, 150);
  }
  destroy() {
    clearTimeout(this.timer);
    this.generation++;
    sharedGitDiffWorker.cancel(this);
  }
}

export const gitDiffUpdates = ViewPlugin.fromClass(GitDiffUpdater);
