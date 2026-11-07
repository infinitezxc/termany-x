import { diffLines, type ChangeObject } from "diff";

export interface GitDiffRequest { id: number; base: string; current: string }
export interface GitDiffResponse { id: number; lines: number[] | undefined }

function currentAddedLines(changes: ChangeObject<string>[]): number[] {
  const lines: number[] = [];
  let line = 1;
  for (const change of changes) {
    if (change.removed) continue;
    if (change.added) {
      for (let offset = 0; offset < change.count; offset++) lines.push(line + offset);
    }
    line += change.count;
  }
  return lines;
}

/** undefined means unavailable, never "no changes". */
export function addedGitLines(base: string, current: string): number[] | undefined {
  if (base.length > 512 * 1024 || current.length > 512 * 1024) return undefined;
  base = base.replace(/\r\n/g, "\n");
  current = current.replace(/\r\n/g, "\n");
  if (base === current || !current) return [];
  // Untracked files need no diff search, even when they contain many lines.
  if (!base) return Array.from({ length: current.split("\n").length - (current.endsWith("\n") ? 1 : 0) }, (_, i) => i + 1);
  const changes = diffLines(base, current, { timeout: 250, maxEditLength: 2000 });
  return changes && currentAddedLines(changes);
}
