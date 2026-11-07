import { highlightingFor, syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { highlightTree } from "@lezer/highlight";
import { gitLineChanges } from "./fileGitChanges";
import { LINE_H, MinimapStrip, TEXT_ALPHA, TEXT_WIDTH, type MinimapMeasure } from "./minimapStrip";

/**
 * The editor's VS Code–style minimap: each document line drawn as tiny
 * syntax-colored blocks, lines added since HEAD tinted green, on the shared
 * strip (minimapStrip.ts). Only the lines inside the minimap's window are
 * drawn.
 */

/** Characters per minimap pixel column. */
const CHAR_W = 1;

/** Lines (1-based) carrying the git "added" decoration. */
export function addedLineNumbers(state: EditorState): number[] {
  const { decorations } = state.field(gitLineChanges, false) ?? { decorations: null };
  if (!decorations) return [];
  const lines: number[] = [];
  decorations.between(0, state.doc.length, (from) => {
    lines.push(state.doc.lineAt(from).number);
  });
  return lines;
}

/** Collapse sorted line numbers into [start, end] runs. */
export function lineRuns(lines: number[]): Array<[number, number]> {
  const runs: Array<[number, number]> = [];
  for (const line of lines) {
    const last = runs[runs.length - 1];
    if (last && line <= last[1] + 1) last[1] = Math.max(last[1], line);
    else runs.push([line, line]);
  }
  return runs;
}

class Minimap extends MinimapStrip {
  probe: HTMLDivElement;
  colors = new Map<string, string>();
  addedSet = new Set<number>();
  addedRuns: Array<[number, number]> = [];

  constructor(readonly view: EditorView) {
    super(view.dom, view.scrollDOM);
    // Highlight classes are scoped under the editor root; a hidden probe
    // inside it resolves each class to its actual color.
    this.probe = document.createElement("div");
    this.probe.className = "file-minimap-probe";
    this.dom.appendChild(this.probe);
    this.refreshAdded();
    this.schedule();
  }

  update(update: ViewUpdate) {
    // The field's value object is new on every transaction; its decoration set
    // keeps its identity unless the added lines (or their positions) changed.
    const gitChanged =
      update.startState.field(gitLineChanges, false)?.decorations !== update.state.field(gitLineChanges, false)?.decorations;
    if (gitChanged || update.docChanged) this.refreshAdded();
    if (
      gitChanged ||
      update.docChanged ||
      update.viewportChanged ||
      update.geometryChanged ||
      syntaxTree(update.startState) !== syntaxTree(update.state)
    ) this.schedule();
  }

  refreshAdded() {
    const added = addedLineNumbers(this.view.state);
    this.addedSet = new Set(added);
    this.addedRuns = lineRuns(added);
  }

  schedule() {
    this.view.requestMeasure({ key: this, read: (view) => this.read(view), write: (m) => this.draw(m) });
  }

  read(view: EditorView): MinimapMeasure {
    const scroller = view.scrollDOM;
    const height = scroller.clientHeight;
    const maxScroll = Math.max(0, scroller.scrollHeight - height);
    const ratio = maxScroll > 0 ? scroller.scrollTop / maxScroll : 0;
    const docTop = scroller.scrollTop - view.documentPadding.top;
    const lineAt = (y: number) => {
      const block = view.lineBlockAtHeight(Math.max(0, y));
      const frac = block.height > 0 ? Math.min(1, Math.max(0, (y - block.top) / block.height)) : 0;
      return view.state.doc.lineAt(block.from).number - 1 + frac;
    };
    return {
      top: scroller.offsetTop,
      height,
      scrollbar: scroller.offsetWidth - scroller.clientWidth,
      ratio,
      maxScroll,
      lines: view.state.doc.lines,
      rowsVisible: height / view.defaultLineHeight,
      topLine: lineAt(docTop),
      bottomLine: lineAt(docTop + height),
      // A lower bound (wrapping only adds rows), cheap to read on every measure.
      shown: view.state.doc.lines * view.defaultLineHeight > height,
      fg: getComputedStyle(view.contentDOM).color,
      addedColor: getComputedStyle(view.dom).getPropertyValue("--git-added").trim() || "#2ea043",
    };
  }

  colorFor(cls: string): string {
    let color = this.colors.get(cls);
    if (color === undefined) {
      const span = document.createElement("span");
      span.className = cls;
      this.probe.appendChild(span);
      color = getComputedStyle(span).color;
      span.remove();
      this.colors.set(cls, color);
    }
    return color;
  }

  /** Syntax-colored blocks for each line in the window, with added-line tint. */
  protected paintContent(ctx: CanvasRenderingContext2D, m: MinimapMeasure, offset: number) {
    const { state } = this.view;
    const { doc, tabSize } = state;
    const first = Math.max(1, Math.floor(offset / LINE_H) + 1);
    const last = Math.min(doc.lines, Math.ceil((offset + m.height) / LINE_H) + 1);
    const maxChars = Math.floor(TEXT_WIDTH / CHAR_W);
    const rowH = (window.devicePixelRatio || 1) >= 2 ? LINE_H - 0.5 : LINE_H;
    const tree = syntaxTree(state);
    const highlighter = { style: (tags: Parameters<typeof highlightingFor>[1]) => highlightingFor(state, tags) };

    for (let n = first; n <= last; n++) {
      const y = (n - 1) * LINE_H - offset;
      if (this.addedSet.has(n)) this.paintAddedRow(ctx, m, y, LINE_H);
      const line = doc.line(n);
      // Only the first `maxChars` characters can be drawn (tabs only widen
      // them), so a minified line never costs more than a short one.
      const end = Math.min(line.to, line.from + maxChars);
      const text = doc.sliceString(line.from, end);
      const spans: Array<{ from: number; to: number; cls: string }> = [];
      highlightTree(tree, highlighter, (f, t, cls) => spans.push({ from: f, to: t, cls }), line.from, end);

      ctx.globalAlpha = TEXT_ALPHA;
      let spanIndex = 0;
      let col = 0;
      let runStart = -1;
      let runColor = "";
      const flush = (endCol: number) => {
        if (runStart < 0) return;
        ctx.fillStyle = runColor;
        ctx.fillRect(2 + runStart * CHAR_W, y, (endCol - runStart) * CHAR_W, rowH);
        runStart = -1;
      };
      for (let i = 0; i < text.length && col < maxChars; i++) {
        const ch = text.charCodeAt(i);
        if (ch === 9 /* tab */ || ch === 32) {
          flush(col);
          col = ch === 9 ? (Math.floor(col / tabSize) + 1) * tabSize : col + 1;
          continue;
        }
        const pos = line.from + i;
        while (spanIndex < spans.length && spans[spanIndex].to <= pos) spanIndex++;
        const span = spans[spanIndex];
        const color = span && span.from <= pos ? this.colorFor(span.cls) : m.fg;
        if (runStart >= 0 && color !== runColor) flush(col);
        if (runStart < 0) {
          runStart = col;
          runColor = color;
        }
        col++;
      }
      flush(Math.min(col, maxChars));
    }
    ctx.globalAlpha = 1;
  }

  /** Every added range in the file, scaled to the full height. */
  protected paintRuler(ctx: CanvasRenderingContext2D, m: MinimapMeasure) {
    ctx.fillStyle = m.addedColor;
    const scale = m.height / m.lines;
    for (const [start, end] of this.addedRuns) this.paintRulerMark(ctx, (start - 1) * scale, (end - start + 1) * scale);
  }

  /** Inverse of `read`'s line measurement, so the slider stays under the pointer. */
  protected scrollToLine(line: number) {
    const { view } = this;
    const { doc } = view.state;
    const n = Math.min(doc.lines, Math.floor(line) + 1);
    const block = view.lineBlockAt(doc.line(n).from);
    const frac = Math.min(1, line - (n - 1));
    view.scrollDOM.scrollTop = block.top + frac * block.height + view.documentPadding.top;
  }

  protected wheelLineHeight() {
    return this.view.defaultLineHeight;
  }
}

export const fileMinimap = ViewPlugin.fromClass(Minimap);
