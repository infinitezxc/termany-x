export type TableAlignment = "left" | "center" | "right" | undefined;

/** Split only unescaped pipes; escaped pipes also work inside inline code. */
function splitRow(line: string): string[] | null {
  const source = line.trim();
  const cells: string[] = [];
  let cell = "";
  let hasPipe = false;
  for (let i = 0; i < source.length; i++) {
    if (source[i] === "\\" && source[i + 1] === "\\") {
      cell += "\\\\";
      i++;
    } else if (source[i] === "\\" && source[i + 1] === "|") {
      cell += "|";
      i++;
    } else if (source[i] === "|") {
      cells.push(cell.trim());
      cell = "";
      hasPipe = true;
    } else {
      cell += source[i];
    }
  }
  cells.push(cell.trim());
  if (!hasPipe) return null;
  if (source.startsWith("|")) cells.shift();
  // An empty final cell means the last pipe was a delimiter, not escaped.
  if (source.endsWith("|") && cell === "") cells.pop();
  return cells;
}

export function parseMarkdownTable(lines: string[], start: number): {
  headers: string[];
  alignments: TableAlignment[];
  rows: string[][];
  nextIndex: number;
} | null {
  const headers = splitRow(lines[start] ?? "");
  const delimiters = splitRow(lines[start + 1] ?? "");
  if (!headers?.length || !delimiters || headers.length !== delimiters.length ||
      !delimiters.every((cell) => /^:?-+:?$/.test(cell))) return null;

  const alignments = delimiters.map((cell): TableAlignment =>
    cell.endsWith(":") ? (cell.startsWith(":") ? "center" : "right") :
      cell.startsWith(":") ? "left" : undefined);
  const rows: string[][] = [];
  let nextIndex = start + 2;
  for (; nextIndex < lines.length; nextIndex++) {
    const line = lines[nextIndex];
    if (!line.trim() || /^\s*(?:```|~~~|#{1,6}\s|>|[-*+]\s|\d+[.)]\s)/.test(line)) break;
    const cells = splitRow(line);
    if (!cells) break;
    rows.push(headers.map((_, index) => cells[index] ?? ""));
  }
  return { headers, alignments, rows, nextIndex };
}
