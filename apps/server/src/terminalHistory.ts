import type { Terminal } from "@xterm/headless";
import type { SerializeAddon } from "@xterm/addon-serialize";
import type { TerminalSnapshot } from "../../../packages/core/src/backend.js";

/** Save rendered scrollback, rather than the raw stream of repeated TUI redraws. */
export function captureHistory(term: Terminal, serializer: SerializeAddon): TerminalSnapshot {
  let data = serializer.serialize({ excludeAltBuffer: true, excludeModes: true });
  if (term.buffer.active.type === "alternate") {
    const lines: string[] = [];
    for (let row = 0; row < term.rows; row++) {
      lines.push(term.buffer.active.getLine(row)?.translateToString(true) ?? "");
    }
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    // Keep the last fullscreen view as ordinary history after the normal
    // buffer. Re-entering the alternate buffer would discard it on restore.
    data += `\x1b[0m\x1b[${term.rows};1H\r\n${lines.join("\r\n")}`;
  }
  return { data, cols: term.cols, rows: term.rows };
}
