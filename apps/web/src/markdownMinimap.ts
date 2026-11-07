import { LINE_H, MinimapStrip, TEXT_ALPHA, TEXT_WIDTH, type MinimapMeasure } from "./minimapStrip";

/**
 * The file viewer's minimap for a rendered Markdown preview. There are no
 * editor lines here, so the minimap is a thumbnail of the laid-out page: every
 * rendered text line, image and code/table box scaled down (one line-height
 * row becomes one minimap row, as in the editor's minimap). Blocks rendered
 * from source lines added since HEAD are tinted green, and the ruler maps them
 * to the full height, using the `data-src="start-end"` source line range each
 * block carries.
 *
 * The page geometry is collected only while the minimap is revealed and only
 * after the content, width, or an image changed — scrolling just repaints.
 */

/** `data-src` value for 1-based source lines `start`…`end`. */
export function srcRange(start: number, end = start): string {
  return `${start}-${end}`;
}

export function parseSrcRange(value: string | null | undefined): [number, number] | null {
  const match = /^(\d+)-(\d+)$/.exec(value ?? "");
  return match ? [Number(match[1]), Number(match[2])] : null;
}

/** Whether sorted `lines` has any line within [start, end]. */
export function rangeHasAdded(lines: readonly number[], start: number, end: number): boolean {
  let lo = 0;
  let hi = lines.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid] < start) lo = mid + 1;
    else hi = mid;
  }
  return lo < lines.length && lines[lo] <= end;
}

/** A painted rectangle, in page (scroll content) pixels. */
interface Mark {
  top: number;
  height: number;
  left: number;
  width: number;
  color: string;
  alpha: number;
}

interface Block {
  top: number;
  height: number;
  start: number;
  end: number;
}

/** Rows here are line-height bands of the page, not source lines. */
interface PreviewMeasure extends MinimapMeasure {
  lineHeight: number;
  scrollHeight: number;
}

/** Boxes drawn as a faint backdrop behind their text. */
const BOX_SELECTOR = ".markdown-preview-code, .markdown-preview-table, blockquote";

export class MarkdownMinimap extends MinimapStrip<PreviewMeasure> {
  marks: Mark[] = [];
  blocks: Block[] = [];
  addedBlocks: Block[] = [];
  added: number[] = [];
  /** The page changed since `marks` / `blocks` were collected. */
  dirty = true;
  frame = 0;
  resize: ResizeObserver;

  constructor(host: HTMLElement, scroller: HTMLElement) {
    super(host, scroller);
    this.resize = new ResizeObserver(() => this.invalidate());
    this.resize.observe(scroller);
    // Images change the page height as they arrive; `load` doesn't bubble.
    scroller.addEventListener("load", this.invalidate, true);
    this.schedule();
  }

  /** The rendered page changed — re-collect its geometry before painting. */
  invalidate = () => {
    this.dirty = true;
    this.schedule();
  };

  /** 1-based source lines added since HEAD. */
  setAdded(lines: readonly number[]) {
    this.added = [...lines].sort((a, b) => a - b);
    this.refreshAddedBlocks();
    this.schedule();
  }

  refreshAddedBlocks() {
    this.addedBlocks = this.added.length
      ? this.blocks.filter((block) => rangeHasAdded(this.added, block.start, block.end))
      : [];
  }

  schedule() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      const m = this.read();
      if (m.shown && this.active && this.dirty && m.height > 0) this.collect();
      this.draw(m);
    });
  }

  read(): PreviewMeasure {
    const s = this.scroller;
    const style = getComputedStyle(s);
    const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.2 || 20;
    const height = s.clientHeight;
    const scrollHeight = s.scrollHeight;
    const maxScroll = Math.max(0, scrollHeight - height);
    return {
      top: s.offsetTop,
      height,
      scrollbar: s.offsetWidth - s.clientWidth,
      ratio: maxScroll > 0 ? s.scrollTop / maxScroll : 0,
      maxScroll,
      lines: scrollHeight / lineHeight,
      topLine: s.scrollTop / lineHeight,
      bottomLine: (s.scrollTop + height) / lineHeight,
      rowsVisible: height / lineHeight,
      shown: scrollHeight > height + 1,
      fg: style.color,
      addedColor: style.getPropertyValue("--git-added").trim() || "#2ea043",
      lineHeight,
      scrollHeight,
    };
  }

  /** Every text line, image and backdrop box of the page, plus source blocks. */
  collect() {
    this.dirty = false;
    const s = this.scroller;
    const base = s.getBoundingClientRect();
    const originY = base.top - s.scrollTop;
    const originX = base.left - s.scrollLeft;
    const marks: Mark[] = [];
    const colors = new Map<Element, string>();
    const colorOf = (el: Element) => {
      let color = colors.get(el);
      if (color === undefined) {
        color = getComputedStyle(el).color;
        colors.set(el, color);
      }
      return color;
    };
    const push = (r: DOMRect, color: string, alpha: number) => {
      if (r.width <= 0 || r.height <= 0) return;
      marks.push({ top: r.top - originY, height: r.height, left: r.left - originX, width: r.width, color, alpha });
    };
    const range = document.createRange();
    // The code block's copy button is chrome, not content: skip its subtree.
    const walker = document.createTreeWalker(s, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => (node as Element).tagName === "BUTTON" ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
    });
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.nodeType === Node.TEXT_NODE) {
        const parent = node.parentElement;
        if (!parent || !node.nodeValue?.trim()) continue;
        range.selectNodeContents(node);
        const color = colorOf(parent);
        for (const r of range.getClientRects()) push(r, color, TEXT_ALPHA);
        continue;
      }
      const el = node as Element;
      if (el.tagName === "IMG" || el.tagName === "HR") push(el.getBoundingClientRect(), colorOf(el), 0.35);
      else if (el.matches(BOX_SELECTOR)) push(el.getBoundingClientRect(), colorOf(el), 0.08);
    }
    this.marks = marks;

    const blocks: Block[] = [];
    for (const el of s.querySelectorAll<HTMLElement>("[data-src]")) {
      const src = parseSrcRange(el.dataset.src);
      if (!src) continue;
      const r = el.getBoundingClientRect();
      blocks.push({ top: r.top - originY, height: r.height, start: src[0], end: src[1] });
    }
    this.blocks = blocks;
    this.refreshAddedBlocks();
  }

  protected paintContent(ctx: CanvasRenderingContext2D, m: PreviewMeasure, offset: number) {
    const vs = LINE_H / m.lineHeight;
    const hs = TEXT_WIDTH / Math.max(1, this.scroller.clientWidth);
    const lo = offset / vs;
    const hi = (offset + m.height) / vs;
    for (const block of this.addedBlocks) {
      if (block.top + block.height < lo || block.top > hi) continue;
      this.paintAddedRow(ctx, m, block.top * vs - offset, Math.max(LINE_H, block.height * vs));
    }
    for (const mark of this.marks) {
      if (mark.top + mark.height < lo || mark.top > hi) continue;
      ctx.globalAlpha = mark.alpha;
      ctx.fillStyle = mark.color;
      ctx.fillRect(
        2 + mark.left * hs,
        mark.top * vs - offset,
        Math.min(TEXT_WIDTH, Math.max(1, mark.width * hs)),
        Math.max(1, mark.height * vs - 0.5),
      );
    }
    ctx.globalAlpha = 1;
  }

  protected paintRuler(ctx: CanvasRenderingContext2D, m: PreviewMeasure) {
    ctx.fillStyle = m.addedColor;
    const scale = m.height / Math.max(1, m.scrollHeight);
    for (const block of this.addedBlocks) this.paintRulerMark(ctx, block.top * scale, block.height * scale);
  }

  protected scrollToLine(line: number, m: PreviewMeasure) {
    this.scroller.scrollTop = line * m.lineHeight;
  }

  protected wheelLineHeight() {
    return this.measured?.lineHeight ?? 20;
  }

  destroy() {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.resize.disconnect();
    this.scroller.removeEventListener("load", this.invalidate, true);
    super.destroy();
  }
}
