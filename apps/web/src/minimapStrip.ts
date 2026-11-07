/**
 * The minimap strip shared by the file viewer's views — the CodeMirror editor
 * (fileMinimap.ts) and the rendered Markdown preview (markdownMinimap.ts):
 * placement beside the scroller's scrollbar, reveal on scroll or a resting
 * pointer, the slider and its dragging, wheel pass-through, and the ruler.
 *
 * Only offered when the content is taller than the pane, and then only
 * revealed while it scrolls or the pointer rests over the strip; it fades out
 * shortly after. Its space stays reserved so text never re-wraps as it comes
 * and goes. Nothing is drawn while it is hidden.
 */

/** Matches `.file-minimap` width in styles.css (and the content padding there). */
const MINIMAP_WIDTH = 80;
const RULER_WIDTH = 4;
export const LINE_H = 2;
export const TEXT_ALPHA = 0.75;
const MIN_SLIDER = 8;
/** Room for content left of the ruler (2px of it is the added-line edge). */
export const TEXT_WIDTH = MINIMAP_WIDTH - RULER_WIDTH - 2;
/** How long the pointer must rest over the strip before it appears. */
const HOVER_REVEAL_MS = 150;
/** How long it stays after scrolling or hovering stops. */
const HIDE_AFTER_MS = 1000;

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

export interface MinimapMeasure {
  top: number;
  height: number;
  scrollbar: number;
  ratio: number;
  maxScroll: number;
  /** Rows in the minimap's model (document lines, or line-height rows). */
  lines: number;
  topLine: number;
  bottomLine: number;
  rowsVisible: number;
  shown: boolean;
  /** Theme colors, read with the rest of the layout instead of while drawing. */
  fg: string;
  addedColor: string;
}

/**
 * The strip itself: placement beside the scrollbar, reveal on scroll or a
 * resting pointer, the slider and its dragging, and wheel pass-through. What
 * it draws, and how a row maps to a scroll position, come from the subclass.
 * Subclasses call `schedule()` once they are set up; the base constructor
 * can't, as their own fields aren't initialized yet.
 */
export abstract class MinimapStrip<M extends MinimapMeasure = MinimapMeasure> {
  dom: HTMLDivElement;
  canvas: HTMLCanvasElement;
  measured: M | null = null;
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

  constructor(host: HTMLElement, readonly scroller: HTMLElement) {
    this.dom = document.createElement("div");
    this.dom.className = "file-minimap";
    this.dom.setAttribute("aria-hidden", "true");
    this.canvas = document.createElement("canvas");
    this.dom.appendChild(this.canvas);
    host.appendChild(this.dom);

    this.dom.addEventListener("pointerdown", this.onPointerDown);
    this.dom.addEventListener("pointermove", this.onPointerMove);
    this.dom.addEventListener("pointerup", this.onPointerUp);
    this.dom.addEventListener("pointercancel", this.onPointerUp);
    this.dom.addEventListener("pointerenter", this.onHover);
    this.dom.addEventListener("pointerleave", this.onHover);
    this.dom.addEventListener("wheel", this.onWheel, { passive: false });
    scroller.addEventListener("scroll", this.onScroll, { passive: true });
  }

  /** Measure, then `draw`, in the next layout-safe moment. */
  abstract schedule(): void;
  /** Everything under the slider: the content inside the minimap's window. */
  protected abstract paintContent(ctx: CanvasRenderingContext2D, m: M, offset: number): void;
  /** Added regions across the whole document, scaled to the full height. */
  protected abstract paintRuler(ctx: CanvasRenderingContext2D, m: M): void;
  /** Scroll so (fractional, 0-based) row `line` is at the top. */
  protected abstract scrollToLine(line: number, m: M): void;
  /** Pixels per wheel "line" step. */
  protected abstract wheelLineHeight(): number;

  draw(m: M) {
    this.measured = m;
    this.dom.classList.toggle("file-minimap-visible", m.shown);
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
    const layout = minimapLayout(m);
    this.layout = layout;
    this.paintContent(ctx, m, layout.offset);
    this.paintSlider(ctx, m, layout);
    this.paintRuler(ctx, m);
  }

  /** Sit beside the scrollbar, below any top panels. */
  placeBox(m: M) {
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

  /** Green row tint with a solid left edge, as for an added source line. */
  paintAddedRow(ctx: CanvasRenderingContext2D, m: M, y: number, height: number) {
    ctx.globalAlpha = 0.28;
    ctx.fillStyle = m.addedColor;
    ctx.fillRect(0, y, TEXT_WIDTH + 2, height);
    ctx.globalAlpha = 1;
    ctx.fillRect(0, y, 2, height);
  }

  /** One ruler mark spanning [top, top + height) of the full box height. */
  paintRulerMark(ctx: CanvasRenderingContext2D, top: number, height: number) {
    ctx.fillRect(MINIMAP_WIDTH - RULER_WIDTH + 1, top, RULER_WIDTH - 1, Math.max(2, height));
  }

  paintSlider(ctx: CanvasRenderingContext2D, m: M, layout: MinimapLayout) {
    ctx.fillStyle = m.fg;
    ctx.globalAlpha = this.drag ? 0.32 : this.hover ? 0.24 : 0.16;
    ctx.fillRect(0, layout.sliderTop, MINIMAP_WIDTH - RULER_WIDTH, layout.sliderHeight);
    ctx.globalAlpha = 1;
  }

  reveal() {
    clearTimeout(this.revealTimer);
    if (!this.active) {
      this.active = true;
      this.dom.classList.add("file-minimap-active");
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
    this.dom.classList.remove("file-minimap-active");
  }

  onScroll = () => {
    if (this.measured?.shown) this.reveal();
    this.schedule();
  };

  scrollToSliderTop(sliderTop: number) {
    const m = this.measured;
    const layout = this.layout;
    if (!m || !layout) return;
    const target = sliderTarget(sliderTop, layout, m.lines, m.height);
    if ("ratio" in target) this.scroller.scrollTop = target.ratio * m.maxScroll;
    else this.scrollToLine(target.line, m);
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
      event.deltaMode === WheelEvent.DOM_DELTA_LINE ? this.wheelLineHeight()
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? this.scroller.clientHeight
          : 1;
    this.scroller.scrollTop += event.deltaY * unit;
  };

  destroy() {
    clearTimeout(this.revealTimer);
    clearTimeout(this.hideTimer);
    this.scroller.removeEventListener("scroll", this.onScroll);
    this.dom.remove();
  }
}
