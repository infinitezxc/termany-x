import type { AgentScreenView } from "./agentIdleWatcher";

type TerminalBuffer = {
  baseY: number;
  cursorY: number;
  length: number;
  type: string;
  getLine(row: number): { isWrapped: boolean; translateToString(trimRight?: boolean): string } | undefined;
};

/** Read the process's live screen, independently of the user's scroll position. */
export function readAgentScreen(term: { rows: number; buffer: { active: TerminalBuffer } }): AgentScreenView {
  const buffer = term.buffer.active;
  const start = Math.max(0, buffer.baseY);
  const end = Math.min(buffer.length, start + term.rows);
  const lines: string[] = [];
  for (let row = start; row < end; row++) {
    const line = buffer.getLine(row);
    const text = line?.translateToString(false) ?? "";
    // A narrow split pane can wrap the prompt or footer over multiple rows.
    if (line?.isWrapped && lines.length) lines[lines.length - 1] += text;
    else lines.push(text);
  }
  return {
    visible: lines.map((line) => line.trimEnd()).join("\n"),
    cursorLine: buffer.getLine(buffer.baseY + buffer.cursorY)?.translateToString(true).trimEnd() ?? "",
    isAlternate: buffer.type === "alternate",
  };
}
