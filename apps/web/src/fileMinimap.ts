import { highlightingFor, syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { highlightTree } from "@lezer/highlight";
import { gitLineChanges } from "./fileGitChanges";

/**
 * A VS Code–style minimap beside the file viewer's scrollbar: each document
 * line drawn as tiny syntax-colored blocks, lines added since HEAD tinted
 * green, and a slider for the visible region that can be clicked or dragged.
 * A thin ruler at its right edge maps the whole file's added lines to the full
 * height, so changes outside the minimap's own window are still visible.
 *
 * Only offered when the file has more lines than fit in the pane, and then
 * only revealed while the editor scrolls or the pointer rests over its strip;
 * it fades out shortly after. Its space stays reserved so text never re-wraps
 * as it comes and goes. Only the lines inside the minimap's window are drawn,
 * and nothing is drawn while it is hidden.
 */

/** Matches `.cm-minimap` width in styles.css (and the content padding there). */
const MINIMAP_WIDTH = 80;
const RULER_WIDTH = 4;
const LINE_H = 2;
const CHAR_W = 1;
const TEXT_ALPHA = 0.75;
const MIN_SLIDER = 8;
/** How long the pointer must rest over the strip before it appears. */
const HOVER_REVEAL_MS = 150;
/** How long it stays after scrolling or hovering stops. */
const HIDE_AFTER_MS = 1000;

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

export interface MinimapLayout {
  /** Minimap pixels scrolled off its top. */
  offset: number;
  sliderTop: number;
  sliderHeight: number;
  /** The minimap is taller than its box and scrolls along with the editor. */
  overflow: boolean;
}

/**
 * Where the minimap content and its slider sit for a scroll position.
 *
 * When every line fits, the slider covers exactly the visible lines. When the
 * minimap is taller than its box, the slider's position comes straight from
 * the scroll ratio (a fixed-height slider travelling the box), and the minimap
 * is offset so the visible lines sit under it. Deriving the slider from the
 * ratio — not from line positions — keeps dragging exact even when wrapped
 * lines make editor height and line count disagree.
 */
export function minimapLayout(o: {
  lines: number;
  height: number;
  ratio: number;
  topLine: number;
  bottomLine: number;
  rowsVisible: number;
}): MinimapLayout {
  const total = o.lines * LINE_H;
  if (total <= o.height) {
    return {
      offset: 0,
      sliderTop: o.topLine * LINE_H,
      sliderHeight: Math.max(MIN_SLIDER, (o.bottomLine - o.topLine) * LINE_H),
      overflow: false,
    };
  }
  const sliderHeight = Math.min(o.height, Math.max(MIN_SLIDER, o.rowsVisible * LINE_H));
  const sliderTop = o.ratio * (o.height - sliderHeight);
  const offset = Math.min(total - o.height, Math.max(0, o.topLine * LINE_H - sliderTop));
  return { offset, sliderTop, sliderHeight, overflow: true };
}

/** The scroll target for dragging the slider's top to `sliderTop`. */
export function sliderTarget(sliderTop: number, layout: MinimapLayout, lines: number, height: number):
  { ratio: number } | { line: number } {
  if (layout.overflow) {
    const travel = height - layout.sliderHeight;
    return { ratio: travel > 0 ? Math.min(1, Math.max(0, sliderTop / travel)) : 0 };
  }
  return { line: Math.min(lines, Math.max(0, sliderTop / LINE_H)) };
}

interface Measure {
  top: number;
  height: number;
  scrollbar: number;
  ratio: number;
  topLine: number;
  bottomLine: number;
  maxScroll: number;
  rowsVisible: number;
  shown: boolean;
  /** Theme colors, read with the rest of the layout instead of while drawing. */
  fg: string;
  addedColor: string;
}

class Minimap {
  dom: HTMLDivElement;
  canvas: HTMLCanvasElement;
  probe: HTMLDivElement;
  colors = new Map<string, string>();
  addedSet = new Set<number>();
  addedRuns: Array<[number, number]> = [];
  measured: Measure | null = null;
  layout: MinimapLayout | null = null;
  drag: { grab: number } | null = null;
  hover = false;
  /** Revealed (visible and interactive); hidden it is only a hover target. */
  active = false;
  /** A paint was skipped while hidden; repaint on reveal. */
  stale = true;
  revealTimer: ReturnType<typeof setTimeout> | undefined;
  hideTimer: ReturnType<typeof setTimeout> | undefined;
  /** Last box written to `dom.style`, so steady scrolling writes no styles. */
  box = "";

  constructor(readonly view: EditorView) {
    this.dom = document.createElement("div");
    this.dom.className = "cm-minimap";
    this.dom.setAttribute("aria-hidden", "true");
    this.canvas = document.createElement("canvas");
    this.dom.appendChild(this.canvas);
    // Highlight classes are scoped under the editor root; a hidden probe
    // inside it resolves each class to its actual color.
    this.probe = document.createElement("div");
    this.probe.className = "cm-minimap-probe";
    this.dom.appendChild(this.probe);
    view.dom.appendChild(this.dom);

    this.dom.addEventListener("pointerdown", this.onPointerDown);
    this.dom.addEventListener("pointermove", this.onPointerMove);
    this.dom.addEventListener("pointerup", this.onPointerUp);
    this.dom.addEventListener("pointercancel", this.onPointerUp);
    this.dom.addEventListener("pointerenter", this.onHover);
    this.dom.addEventListener("pointerleave", this.onHover);
    this.dom.addEventListener("wheel", this.onWheel, { passive: false });
    view.scrollDOM.addEventListener("scroll", this.onScroll, { passive: true });
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

  schedule = () => {
    this.view.requestMeasure({ key: this, read: (view) => this.read(view), write: (m) => this.draw(m) });
  };

  read(view: EditorView): Measure {
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
      rowsVisible: height / view.defaultLineHeight,
      topLine: lineAt(docTop),
      bottomLine: lineAt(docTop + height),
      // Wrapping only adds rows, so this lower bound never flips the minimap
      // on and off as its own padding re-wraps the text.
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

  draw(m: Measure) {
    this.measured = m;
    this.dom.classList.toggle("cm-minimap-visible", m.shown);
    if (!m.shown || m.height <= 0) {
      // The file got short: drop any reveal now. A strip that vanished under
      // the pointer may never get its pointerleave, which would otherwise
      // leave `hover` set and the minimap stuck on next time it applies.
      this.hover = false;
      this.hide();
      return;
    }
    // Placed even while hidden: the invisible strip is the hover target.
    this.placeBox(m);
    if (!this.active) {
      this.stale = true;
      return;
    }
    this.stale = false;
    const ctx = this.prepareCanvas(m.height);
    if (!ctx) return;
    const layout = minimapLayout({ ...m, lines: this.view.state.doc.lines });
    this.layout = layout;
    this.paintLines(ctx, m, layout.offset);
    this.paintSlider(ctx, m, layout);
    this.paintRuler(ctx, m);
  }

  /** Sit beside the scrollbar, below any top panels. */
  placeBox(m: Measure) {
    const box = `${m.top},${m.scrollbar},${m.height}`;
    if (box === this.box) return;
    this.box = box;
    this.dom.style.top = `${m.top}px`;
    this.dom.style.right = `${m.scrollbar}px`;
    this.dom.style.height = `${m.height}px`;
  }

  prepareCanvas(height: number): CanvasRenderingContext2D | null {
    const dpr = window.devicePixelRatio || 1;
    const pw = Math.round(MINIMAP_WIDTH * dpr);
    const ph = Math.round(height * dpr);
    if (this.canvas.width !== pw || this.canvas.height !== ph) {
      this.canvas.width = pw;
      this.canvas.height = ph;
      this.canvas.style.width = `${MINIMAP_WIDTH}px`;
      this.canvas.style.height = `${height}px`;
    }
    const ctx = this.canvas.getContext("2d");
    if (!ctx) return null;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, MINIMAP_WIDTH, height);
    return ctx;
  }

  /** Syntax-colored blocks for each line in the window, with added-line tint. */
  paintLines(ctx: CanvasRenderingContext2D, m: Measure, offset: number) {
    const { state } = this.view;
    const { doc, tabSize } = state;
    const first = Math.max(1, Math.floor(offset / LINE_H) + 1);
    const last = Math.min(doc.lines, Math.ceil((offset + m.height) / LINE_H) + 1);
    const textWidth = MINIMAP_WIDTH - RULER_WIDTH - 2;
    const maxChars = Math.floor(textWidth / CHAR_W);
    const rowH = (window.devicePixelRatio || 1) >= 2 ? LINE_H - 0.5 : LINE_H;
    const tree = syntaxTree(state);
    const highlighter = { style: (tags: Parameters<typeof highlightingFor>[1]) => highlightingFor(state, tags) };

    for (let n = first; n <= last; n++) {
      const y = (n - 1) * LINE_H - offset;
      if (this.addedSet.has(n)) {
        ctx.globalAlpha = 0.28;
        ctx.fillStyle = m.addedColor;
        ctx.fillRect(0, y, textWidth + 2, LINE_H);
        ctx.globalAlpha = 1;
        ctx.fillRect(0, y, 2, LINE_H);
      }
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

  paintSlider(ctx: CanvasRenderingContext2D, m: Measure, layout: MinimapLayout) {
    ctx.fillStyle = m.fg;
    ctx.globalAlpha = this.drag ? 0.32 : this.hover ? 0.24 : 0.16;
    ctx.fillRect(0, layout.sliderTop, MINIMAP_WIDTH - RULER_WIDTH, layout.sliderHeight);
    ctx.globalAlpha = 1;
  }

  /** Every added range in the file, scaled to the full height. */
  paintRuler(ctx: CanvasRenderingContext2D, m: Measure) {
    ctx.fillStyle = m.addedColor;
    const scale = m.height / this.view.state.doc.lines;
    for (const [start, end] of this.addedRuns) {
      ctx.fillRect(MINIMAP_WIDTH - RULER_WIDTH + 1, (start - 1) * scale, RULER_WIDTH - 1, Math.max(2, (end - start + 1) * scale));
    }
  }

  reveal() {
    clearTimeout(this.revealTimer);
    if (!this.active) {
      this.active = true;
      this.dom.classList.add("cm-minimap-active");
      if (this.stale) this.schedule();
    }
    this.scheduleHide();
  }

  /** Fade out after a quiet spell, unless the pointer is still on it. */
  scheduleHide() {
    clearTimeout(this.hideTimer);
    if (this.hover || this.drag) return;
    this.hideTimer = setTimeout(() => this.hide(), HIDE_AFTER_MS);
  }

  hide() {
    clearTimeout(this.revealTimer);
    clearTimeout(this.hideTimer);
    this.active = false;
    this.dom.classList.remove("cm-minimap-active");
  }

  onScroll = () => {
    if (this.measured?.shown) this.reveal();
    this.schedule();
  };

  scrollToSliderTop(sliderTop: number) {
    const m = this.measured;
    const layout = this.layout;
    if (!m || !layout) return;
    const { view } = this;
    const { doc } = view.state;
    const target = sliderTarget(sliderTop, layout, doc.lines, m.height);
    if ("ratio" in target) {
      view.scrollDOM.scrollTop = target.ratio * m.maxScroll;
      return;
    }
    // Inverse of `read`'s line measurement, so the slider stays under the pointer.
    const n = Math.min(doc.lines, Math.floor(target.line) + 1);
    const block = view.lineBlockAt(doc.line(n).from);
    const frac = Math.min(1, target.line - (n - 1));
    view.scrollDOM.scrollTop = block.top + frac * block.height + view.documentPadding.top;
  }

  localY(event: PointerEvent) {
    return event.clientY - this.dom.getBoundingClientRect().top;
  }

  onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0 || !this.measured?.shown) return;
    event.preventDefault();
    // A click on the hidden strip only reveals it; jumping through the file
    // from an empty-looking margin would be a surprise.
    if (!this.active) {
      this.reveal();
      return;
    }
    const y = this.localY(event);
    const { sliderTop: top, sliderHeight: height } = this.layout ?? { sliderTop: 0, sliderHeight: 0 };
    // Grabbing the slider keeps its offset; clicking elsewhere centers it there.
    const grab = y >= top && y <= top + height ? y - top : height / 2;
    this.drag = { grab };
    this.dom.setPointerCapture(event.pointerId);
    this.scrollToSliderTop(y - grab);
    this.schedule();
  };

  onPointerMove = (event: PointerEvent) => {
    if (!this.drag) return;
    this.scrollToSliderTop(this.localY(event) - this.drag.grab);
  };

  onPointerUp = (event: PointerEvent) => {
    if (!this.drag) return;
    this.drag = null;
    if (this.dom.hasPointerCapture(event.pointerId)) this.dom.releasePointerCapture(event.pointerId);
    this.scheduleHide();
    this.schedule();
  };

  onHover = (event: PointerEvent) => {
    this.hover = event.type === "pointerenter";
    clearTimeout(this.revealTimer);
    if (this.hover) {
      clearTimeout(this.hideTimer);
      // Passing over the strip on the way somewhere else should not flash it.
      if (!this.active) this.revealTimer = setTimeout(() => this.reveal(), HOVER_REVEAL_MS);
    } else {
      this.scheduleHide();
    }
    // Hover only shades the slider; nothing to repaint while hidden.
    if (this.active) this.schedule();
  };

  onWheel = (event: WheelEvent) => {
    // The minimap sits outside the scroller; pass wheel scrolling through.
    event.preventDefault();
    const unit =
      event.deltaMode === WheelEvent.DOM_DELTA_LINE ? this.view.defaultLineHeight
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? this.view.scrollDOM.clientHeight
          : 1;
    this.view.scrollDOM.scrollTop += event.deltaY * unit;
  };

  destroy() {
    clearTimeout(this.revealTimer);
    clearTimeout(this.hideTimer);
    this.view.scrollDOM.removeEventListener("scroll", this.onScroll);
    this.dom.remove();
  }
}

export const fileMinimap = ViewPlugin.fromClass(Minimap);
