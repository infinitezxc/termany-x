/**
 * Converts wheel events into whole terminal rows.
 *
 * xterm 5.5 handles a wheel tick by setting the viewport element's DOM
 * `scrollTop`. Its buffer position (`ydisp`) only catches up when the
 * asynchronous `scroll` event arrives, and streaming output can delay that
 * event. Any PTY write in that gap still sees "at bottom" and pulls the reader
 * back down. Scrolling with `term.scrollLines()` updates `ydisp` right away,
 * so no write can land in that gap and output never has to be held back.
 *
 * Trackpads report small pixel deltas, so the fraction left over is kept for
 * the next event instead of being rounded away.
 */

const DOM_DELTA_PIXEL = 0;
const DOM_DELTA_LINE = 1;
const DOM_DELTA_PAGE = 2;

export interface WheelLike {
  deltaY: number;
  deltaMode: number;
  altKey?: boolean;
}

export interface WheelLineOptions {
  rowHeight: number;
  rows: number;
  /** xterm's defaults: `scrollSensitivity` 1, Alt-modified `fastScrollSensitivity` 5. */
  sensitivity?: number;
  fastSensitivity?: number;
}

export class WheelLineAccumulator {
  private remainder = 0;
  private lastSign = 0;

  /** Whole rows to scroll for this event (negative = up). */
  lines(ev: WheelLike, opts: WheelLineOptions): number {
    if (!ev.deltaY || !(opts.rowHeight > 0)) return 0;
    const sensitivity = ev.altKey ? (opts.fastSensitivity ?? 5) : (opts.sensitivity ?? 1);
    let rowsDelta: number;
    if (ev.deltaMode === DOM_DELTA_LINE) rowsDelta = ev.deltaY;
    else if (ev.deltaMode === DOM_DELTA_PAGE) rowsDelta = ev.deltaY * opts.rows;
    else rowsDelta = ev.deltaY / opts.rowHeight; // DOM_DELTA_PIXEL
    rowsDelta *= sensitivity;

    // A reversed gesture should respond immediately, not first burn off the
    // fraction left over from the other direction.
    const sign = Math.sign(rowsDelta);
    if (sign !== this.lastSign) this.remainder = 0;
    this.lastSign = sign;

    this.remainder += rowsDelta;
    const whole = Math.trunc(this.remainder);
    this.remainder -= whole;
    return whole;
  }

  reset() {
    this.remainder = 0;
    this.lastSign = 0;
  }
}

export { DOM_DELTA_PIXEL, DOM_DELTA_LINE, DOM_DELTA_PAGE };
