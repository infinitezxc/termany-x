import type { IBuffer, IBufferRange } from "@xterm/xterm";

const LEFT = "\x1b[D";
const RIGHT = "\x1b[C";
const BACKSPACE = "\x7f";

/**
 * Keystrokes that delete a terminal selection from the shell's input line, or
 * null when the selection is not something the shell can delete.
 *
 * A terminal has no editable text — output is history. What CAN be removed is
 * the command being typed, by driving the line editor the way a user would:
 * arrow the cursor to the selection's end, then backspace over it. So this
 * only applies when the selection lies on the cursor's own row of the normal
 * screen (full-screen apps own their own editing).
 *
 * The prompt is not knowable without shell integration, so a selection that
 * reaches into it just overshoots: the line editor refuses to backspace past
 * the start of input. The selection end is clamped to the line's content so
 * trailing blank cells never turn into backspaces that eat real input.
 * Columns are counted in characters, not cells, because arrow keys and
 * backspace step over a wide (CJK/emoji) character in one press.
 */
export function cutKeystrokes(buffer: IBuffer, range: IBufferRange): string | null {
  if (buffer.type !== "normal") return null;
  const row = buffer.baseY + buffer.cursorY;
  // `end.x` is exclusive.
  if (range.start.y !== row || range.end.y !== row) return null;
  const line = buffer.getLine(row);
  if (!line) return null;

  const cursor = buffer.cursorX;
  const contentEnd = Math.max(cursor, line.translateToString(true).length);
  const start = range.start.x;
  const end = Math.min(range.end.x, contentEnd);
  if (end <= start) return null;

  /** Characters (not cells) in columns [from, to). */
  const chars = (from: number, to: number) => {
    let n = 0;
    for (let x = from; x < to; x++) if (line.getCell(x)?.getWidth() !== 0) n++;
    return n;
  };

  const move = end >= cursor ? RIGHT.repeat(chars(cursor, end)) : LEFT.repeat(chars(end, cursor));
  return move + BACKSPACE.repeat(chars(start, end));
}
