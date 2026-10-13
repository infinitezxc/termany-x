import type { IBuffer } from "@xterm/xterm";

/** Text up to the input cursor, joining soft-wrapped terminal rows. */
export function textBeforeCursor(buffer: IBuffer): string {
  const end = buffer.baseY + buffer.cursorY;
  let text = "";
  for (let y = Math.max(0, end - 200); y <= end; y++) {
    const line = buffer.getLine(y);
    if (!line) continue;
    if (y > 0 && !line.isWrapped) text += "\n";
    text += line.translateToString(y !== end, 0, y === end ? buffer.cursorX : undefined);
  }
  return text;
}

/** One unchanged paste; intervening edits must never delete older input. */
export class PasteUndo {
  private pending: string | null = null;
  private pasting = false;

  paste(text: string, send: (text: string) => void) {
    this.pending = text ? text.replace(/\r\n?/g, "\n") : null;
    this.pasting = true;
    try { send(text); } finally { this.pasting = false; }
  }

  input(data: string) {
    // Mouse/focus reports and terminal query replies do not edit the draft.
    if (this.pasting || /^\x1b\[(?:[<MIO]|[?\d;]*[cnR])/.test(data)) return;
    this.clear();
  }

  clear() { this.pending = null; }

  takeCodexUndo(beforeCursor: string): string | null {
    const text = this.pending;
    this.clear();
    if (!text) return null;
    // Codex and xterm can disagree by a cell on emoji width, leaving blank
    // padding before the reported cursor. Preserve actual pasted whitespace.
    if (!/\s$/.test(text)) beforeCursor = beforeCursor.trimEnd();
    const charCount = Array.from(text).length;
    const placeholder = /\[Pasted Content (\d+) chars\](?: #\d+)?$/.exec(beforeCursor);
    if (placeholder && Number(placeholder[1]) === charCount) {
      // Codex represents a large paste as one atomic textarea element.
      return "\x7f";
    }
    if (charCount > 1000) return null;
    // Codex draws a two-column gutter on continuation rows, including rows
    // it wraps itself rather than letting the terminal soft-wrap them.
    const escaped = Array.from(text, (char) => char === "\n"
      ? "\\n {2}"
      : char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    const renderedSuffix = new RegExp(escaped.join("(?:\\n {2})?") + "$");
    if (!beforeCursor.endsWith(text) && !renderedSuffix.test(beforeCursor)) return null;
    const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    return "\x7f".repeat(Array.from(graphemes.segment(text)).length);
  }
}
