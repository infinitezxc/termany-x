import { indentWithTab } from "@codemirror/commands";
import { defaultHighlightStyle, LanguageDescription, syntaxHighlighting } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { search } from "@codemirror/search";
import { Annotation, Compartment, EditorState, StateEffect } from "@codemirror/state";
import { oneDark } from "@codemirror/theme-one-dark";
import { EditorView, keymap } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { useEffect, useRef } from "react";
import { applyTextInputProps } from "../textInputProps";
import { gitLineChanges, gitDiffUpdates, setGitBase } from "../fileGitChanges";
import { createFindPanel } from "./EditorFindPanel";
import { fileMinimap } from "../fileMinimap";

/** Match the app's own chrome instead of CodeMirror's default white/dark-blue
 *  chrome, so the editor reads as part of the pane, not an embedded widget. */
const appTheme = EditorView.theme({
  "&": { height: "100%", backgroundColor: "transparent" },
  ".cm-content": { fontFamily: "Menlo, monospace", fontSize: "12.5px", caretColor: "var(--fg)" },
  ".cm-gutters": {
    backgroundColor: "transparent",
    color: "var(--fg-dim)",
    border: "none",
  },
  ".cm-activeLineGutter": { backgroundColor: "var(--bg-3)" },
  ".cm-activeLine": { backgroundColor: "var(--bg-3)" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { overflow: "auto" },
});

/** Marks the edit that swaps in a fresh copy of the file from disk, so it
 *  doesn't count as the user's own (unsaved) change. */
const fromDisk = Annotation.define<boolean>();

/** An editor as it was when torn down — see CodeEditor's `onUnmount`. */
export interface EditorSnapshot {
  state: EditorState;
  scroll: StateEffect<unknown>;
}

/**
 * An editable, syntax-highlighted view of a file's content — CodeMirror 6
 * under a thin React wrapper. Uncontrolled by design: React never re-renders
 * on keystrokes (that'd fight the editor's own cursor/selection/undo state).
 * It creates one CodeMirror instance per `path` and tears it down when the
 * file changes; ⌘S hands the current text to `onSave`, and any edit at all
 * reports through `onDirtyChange` so the pane can show an unsaved indicator.
 * A new `loadedAt` (the file was re-read from disk) swaps its `content` into
 * the live editor in place, keeping cursor, scroll and undo.
 * `onUnmount` hands over a snapshot of the editor as it goes away (doc,
 * selection, undo history, scroll); handing it back through `takeRestore`
 * brings a later editor back exactly as it was — unsaved edits included —
 * instead of fresh from `content`.
 */
export function CodeEditor({
  path,
  content,
  loadedAt,
  dark,
  readOnly = false,
  gitBase = null,
  onSave,
  onDirtyChange,
  takeRestore,
  onUnmount,
}: {
  path: string;
  content: string;
  /** When `content` was read from disk — a change means "show this now". */
  loadedAt?: number;
  dark: boolean;
  /** Blocks edits entirely — for previews that are only a truncated prefix of
   *  a too-large file, where saving would silently discard the rest of it. */
  readOnly?: boolean;
  /** Last committed text; empty for new files, null when unavailable. */
  gitBase?: string | null;
  onSave: (text: string) => void;
  onDirtyChange: (dirty: boolean) => void;
  /** Hands over (and forgets) a snapshot from an earlier editor's
   *  `onUnmount` to resume from; it counts as unsaved. Called when the editor
   *  is created — not during render, which on a remount comes before the old
   *  editor has handed its snapshot over. */
  takeRestore?: () => EditorSnapshot | undefined;
  /** Called once, when the editor really goes away (not on a rebuild). */
  onUnmount?: (snapshot: EditorSnapshot) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  const onDirtyChangeRef = useRef(onDirtyChange);
  onDirtyChangeRef.current = onDirtyChange;
  const onUnmountRef = useRef(onUnmount);
  onUnmountRef.current = onUnmount;
  const takeRestoreRef = useRef(takeRestore);
  takeRestoreRef.current = takeRestore;
  // The `content`/`loadedAt` the doc last took in. Only a newer pair is
  // synced in — so a restored draft isn't overwritten by the very content
  // it was restored over.
  const syncedRef = useRef<{ content: string; loadedAt?: number } | null>(null);
  // The previous instance's state when the editor is only being rebuilt in
  // place (a theme switch), so the rebuild doesn't lose edits or undo either.
  const carryRef = useRef<EditorSnapshot | null>(null);

  // Declared before the creation effect so this cleanup runs first, while
  // the view is still there; with no deps, only a real unmount reaches it.
  useEffect(() => () => {
    const view = viewRef.current;
    if (view) onUnmountRef.current?.({ state: view.state, scroll: view.scrollSnapshot() });
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    const languageConf = new Compartment();

    const extensions = [
      basicSetup,
      gitLineChanges,
      gitDiffUpdates,
      fileMinimap,
      search({ top: true, createPanel: createFindPanel }),
      keymap.of([
        indentWithTab,
        {
          key: "Mod-s",
          run: (v) => {
            onSaveRef.current(v.state.doc.toString());
            return true;
          },
        },
      ]),
      languageConf.of([]),
      dark ? [oneDark] : [syntaxHighlighting(defaultHighlightStyle)],
      appTheme,
      // Soft-wrap long lines to the pane width instead of clipping them
      // behind a horizontal scroll when the pane is narrowed.
      EditorView.lineWrapping,
      EditorState.readOnly.of(readOnly),
      EditorView.updateListener.of((update) => {
        if (update.docChanged && !update.transactions.some((tr) => tr.annotation(fromDisk))) {
          onDirtyChangeRef.current(true);
        }
      }),
    ];
    // A restored snapshot keeps its doc, selection and undo history; only
    // its configuration is swapped for this instance's (theme, language…).
    const carried = carryRef.current;
    carryRef.current = null;
    // Always take it, even when rebuilding from `carried`: a draft must not
    // linger in the store while an editor for that file is live.
    const stored = takeRestoreRef.current?.();
    const snapshot = carried ?? stored;
    if (!carried) syncedRef.current = { content, loadedAt };
    const initialState = snapshot
      ? snapshot.state.update({ effects: StateEffect.reconfigure.of(extensions) }).state
      : EditorState.create({ doc: content, extensions });

    const view = new EditorView({
      parent: host,
      state: initialState,
    });
    viewRef.current = view;
    if (snapshot) view.dispatch({ effects: snapshot.scroll });
    // A draft is unsaved edits by definition.
    if (snapshot && !carried) onDirtyChangeRef.current(true);

    // Auto-detect the language from the filename and load it in async — a
    // plain view first, then upgraded in place once the language support
    // (parser + highlighting queries) finishes loading.
    const desc = LanguageDescription.matchFilename(languages, path);
    desc?.load().then((support) => {
      if (cancelled) return;
      view.dispatch({ effects: languageConf.reconfigure(support) });
    });

    return () => {
      cancelled = true;
      viewRef.current = null;
      // Kept for a rebuild in place; a real unmount just drops it.
      carryRef.current = { state: view.state, scroll: view.scrollSnapshot() };
      view.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `content` seeds
    // the doc only at creation; re-running on every keystroke would fight
    // CodeMirror's own state.
  }, [path, dark, readOnly]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: setGitBase.of(gitBase) });
  }, [gitBase, path, dark, readOnly]);

  // A re-read from disk replaces only the span that actually differs, so the
  // cursor and scroll position stay put around it. This discards any unsaved
  // edits — the caller only reloads a dirty file when asked to.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const synced = syncedRef.current;
    if (synced && synced.content === content && synced.loadedAt === loadedAt) return;
    syncedRef.current = { content, loadedAt };
    const doc = view.state.doc.toString();
    if (doc !== content) {
      let from = 0;
      const max = Math.min(doc.length, content.length);
      while (from < max && doc.charCodeAt(from) === content.charCodeAt(from)) from++;
      let end = 0;
      while (
        end < max - from &&
        doc.charCodeAt(doc.length - 1 - end) === content.charCodeAt(content.length - 1 - end)
      ) end++;
      view.dispatch({
        changes: { from, to: doc.length - end, insert: content.slice(from, content.length - end) },
        annotations: fromDisk.of(true),
      });
    }
    onDirtyChangeRef.current(false);
  }, [content, loadedAt]);

  return (
    <div
      className="code-editor"
      ref={hostRef}
      onFocusCapture={(event) => {
        // CodeMirror creates its search/replace fields outside React.
        if (event.target.matches("input, textarea, [contenteditable]")) {
          applyTextInputProps(event.target);
        }
      }}
    />
  );
}
