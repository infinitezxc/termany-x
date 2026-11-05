/**
 * tmux sends a burst's scrolls as one run of linefeeds capped at the scroll
 * region's height, so lines past the cap never reach the client. This spots
 * the cap: a region from the top row and a run as long as it is tall (a burst
 * of exactly that size looks the same and costs a needless restore).
 */
export class CappedScrollDetector {
  /** Recent output, for a scroll split across chunks. */
  private tail = "";

  feed(data: string): boolean {
    const text = this.tail + data;
    const seen = this.tail.length;
    this.tail = text.slice(-TAIL);
    for (const match of text.matchAll(CAPPED_SCROLL)) {
      if (match.index! + match[0].length <= seen) continue;
      const top = Number(match[1]);
      const bottom = Number(match[2]);
      if (top === 1 && match[3].length >= bottom - top + 1) return true;
    }
    return false;
  }
}

const CAPPED_SCROLL = /\x1b\[(\d+);(\d+)r(?:\x1b\[\d+;\d+H)?(\n+)/g;
const TAIL = 512;

export interface ScrollbackPane {
  onNormalScreen(): boolean;
  /** Null when the history cannot stand in for the scrollback. */
  fetchHistory(): Promise<string | null>;
  replaceScrollback(history: string): Promise<boolean>;
  replaced(): void;
}

/**
 * Once output settles after a capped scroll, replaces the scrollback with the
 * pane's history. Output during the fetch makes it stale, so it is refetched.
 */
export class TmuxScrollbackRestorer {
  private readonly detector = new CappedScrollDetector();
  private chunks = 0;
  private pending = false;
  private fetching = false;
  private disposed = false;
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly pane: ScrollbackPane, private readonly settleMs = 300) {}

  noteOutput(data: string): void {
    this.chunks++;
    if (this.detector.feed(data) && this.pane.onNormalScreen()) this.pending = true;
    if (this.pending) this.schedule();
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.timer);
  }

  private schedule(): void {
    clearTimeout(this.timer);
    if (!this.disposed) this.timer = setTimeout(() => void this.restore(), this.settleMs);
  }

  private async restore(): Promise<void> {
    if (this.disposed) return;
    if (this.fetching) return this.schedule();
    this.fetching = true;
    const seen = this.chunks;
    try {
      const history = await this.pane.fetchHistory();
      if (this.disposed) return;
      if (this.chunks !== seen) return this.schedule();
      this.pending = false;
      if (history !== null && await this.pane.replaceScrollback(history) && !this.disposed) this.pane.replaced();
    } catch {
      this.pending = false;
    } finally {
      this.fetching = false;
    }
  }
}
