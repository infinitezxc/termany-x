import type { TerminalSnapshot } from "./backend.js";

export const STALE_MODE_RESET =
  "\x1b[r\x1b[?1000;1002;1003;1006l\x1b[?1004l\x1b[?2004l\x1b[?6l\x1b[?7h" +
  "\x1b[?1l\x1b>\x1b[?25h\x1b(B\x0f\x1b[0m";

interface ReplayTerminal {
  reset(): void;
  resize(cols: number, rows: number): void;
  write(data: string, callback: () => void): void;
  buffer: { active: { type: string; cursorY: number } };
}

/** Live reattachment must preserve the process's cursor, modes and active buffer. */
export async function restoreTerminalSnapshot(
  term: ReplayTerminal,
  snapshot: string | TerminalSnapshot,
  live = false,
): Promise<void> {
  const write = (data: string) => new Promise<void>((resolve) => term.write(data, resolve));
  if (live) term.reset();
  if (typeof snapshot !== "string") term.resize(snapshot.cols, snapshot.rows);
  await write(typeof snapshot === "string" ? snapshot : snapshot.data);
  if (live) return;
  // A dead process's saved screen becomes history above a new shell.
  if (term.buffer.active.type === "alternate") await write("\x1b[?1049l");
  const row = term.buffer.active.cursorY + 1;
  await write(STALE_MODE_RESET + `\x1b[${row};1H\x1b7\r\n`);
}

