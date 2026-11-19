import { captureHistory } from "./terminalHistory.js";
import xterm from "@xterm/headless";
import serialize from "@xterm/addon-serialize";
import type { TerminalSnapshot } from "../../../packages/core/src/backend.js";
import { restoreTerminalSnapshot } from "../../../packages/core/src/terminal-restore.js";

/** The running PTY's screen, retained even while no webview is attached. */
export class TerminalState {
  private readonly term = new xterm.Terminal({ scrollback: 5000, allowProposedApi: true });
  private readonly serializer = new serialize.SerializeAddon();
  private queue = Promise.resolve();

  private pendingWrites?: { data: string; rendered?: () => void }[];
  private pendingLength = 0;

  constructor(history?: string | TerminalSnapshot) {
    this.term.loadAddon(this.serializer);
    if (history) this.queue = restoreTerminalSnapshot(this.term, history);
    this.resize(80, 24);
  }

  write(data: string, rendered?: () => void): void {
    // Feed queued chunks to xterm together so redraw bursts share parser
    // time slices. Each callback still runs immediately after its own chunk.
    if (!this.pendingWrites || this.pendingLength + data.length > 64 * 1024) {
      const writes: { data: string; rendered?: () => void }[] = [];
      this.enqueue(() => new Promise<void>((resolve) => {
        if (this.pendingWrites === writes) this.pendingWrites = undefined;
        for (const [index, write] of writes.entries()) {
          this.term.write(write.data, () => {
            write.rendered?.();
            if (index === writes.length - 1) resolve();
          });
        }
      }));
      this.pendingWrites = writes;
      this.pendingLength = 0;
    }
    this.pendingWrites.push({ data, rendered });
    this.pendingLength += data.length;
  }

  private enqueue(operation: () => void | Promise<void>): Promise<void> {
    // Resizes and snapshots must observe exactly the writes preceding them.
    this.pendingWrites = undefined;
    this.queue = this.queue.then(operation);
    return this.queue;
  }

  onResponse(callback: (data: string) => void): void {
    this.term.onData(callback);
  }

  resize(cols: number, rows: number): void {
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1) return;
    this.enqueue(() => { this.term.resize(cols, rows); });
  }

  /** Runs between output writes: included output is never sent again as a delta. */
  snapshot(ready: (snapshot: TerminalSnapshot) => void): Promise<void> {
    return this.enqueue(() => {
      ready({ data: this.serializer.serialize() + this.liveState(), cols: this.term.cols, rows: this.term.rows });
    });
  }

  /** Replace the scrollback with `history`, keeping the screen, cursor and modes. */
  replaceScrollback(history: string): Promise<boolean> {
    let replaced = false;
    this.enqueue(async () => {
      if (this.term.buffer.active.type !== "normal") return;
      const screen = this.serializer.serialize({ scrollback: 0 }) + this.liveState();
      this.term.reset();
      // tmux carries attributes across lines, so the history is one stream.
      // Scrolling from the bottom row pushes it off without blank rows.
      const text = history.replace(/\n$/, "");
      if (text) await this.writeNow(text.replace(/\n/g, "\r\n") + "\x1b[0m\r\n");
      const onScreen = this.term.buffer.active.cursorY;
      await this.writeNow(`\x1b[${this.term.rows};1H${"\n".repeat(onScreen)}\x1b[H${screen}`);
      replaced = true;
    });
    return this.queue.then(() => replaced);
  }

  onNormalScreen(): boolean {
    return this.term.buffer.active.type === "normal";
  }

  private writeNow(data: string): Promise<void> {
    return new Promise((resolve) => this.term.write(data, resolve));
  }

  /**
   * SerializeAddon omits scroll margins, cursor visibility and mouse encoding.
   * These xterm 5.5 fields are needed when a live TUI continues with relative
   * cursor movement or scrolling after reattachment.
   */
  private liveState(): string {
    let data = "";
    const core = (this.term as unknown as { _core: {
      _bufferService: { buffer: { scrollTop: number; scrollBottom: number } };
      coreService: { isCursorHidden: boolean };
      coreMouseService: { activeEncoding: string };
    } })._core;
    const buffer = this.term.buffer.active;
    const { scrollTop, scrollBottom } = core._bufferService.buffer;
    if (scrollTop !== 0 || scrollBottom !== this.term.rows - 1 || this.term.modes.originMode) {
      data += `\x1b[?6l\x1b[${scrollTop + 1};${scrollBottom + 1}r`;
      if (this.term.modes.originMode) data += "\x1b[?6h";
      const row = buffer.cursorY - (this.term.modes.originMode ? scrollTop : 0) + 1;
      data += `\x1b[${row};${buffer.cursorX + 1}H`;
    }
    if (core.coreService.isCursorHidden) data += "\x1b[?25l";
    if (core.coreMouseService.activeEncoding === "SGR") data += "\x1b[?1006h";
    if (core.coreMouseService.activeEncoding === "SGR_PIXELS") data += "\x1b[?1016h";
    return data;
  }

  history(ready: (snapshot: TerminalSnapshot) => void): Promise<void> {
    return this.enqueue(() => { ready(captureHistory(this.term, this.serializer)); });
  }

  dispose(): void {
    void this.enqueue(() => this.term.dispose());
  }
}
