import { normalizeJobName } from "./foregroundJob.js";

/** Inspect only the owning shell and its terminal foreground group. */
export const REMOTE_FOREGROUND_SCRIPT =
  'ps -o pid= -o pgid= -o tpgid= -o comm= -p "$1"';

/** Unknown/missing jobs must never be interpreted as a returned shell. */
export function remoteForegroundIsShell(
  output: string,
  shellPid: number,
  shellName: string,
): boolean | undefined {
  const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([^\r\n]+)\s*$/.exec(output);
  if (!match || !normalizeJobName(shellName)) return undefined;
  const [pid, pgid, foreground] = match.slice(1, 4).map(Number);
  if (pid !== shellPid || ![pid, pgid, foreground].every((n) => Number.isSafeInteger(n) && n > 0)) return undefined;
  // `exec codex` preserves the shell's pid and process group. Verify the
  // executable name as well, so a replaced shell is never treated as idle.
  return pgid === foreground && normalizeJobName(match[4]) === normalizeJobName(shellName);
}

/** Startup OSC may arrive split across PTY chunks. */
export class RemoteShellIdentity {
  private tail = "";
  pid?: number;
  shellName?: string;

  noteOutput(data: string): void {
    if (this.pid) return;
    const input = this.tail + data;
    const match = /\x1b\]779;termany-shell;(\d+);([^;\x07\x1b\r\n]{1,128})(?:\x07|\x1b\\)/.exec(input);
    const pid = Number(match?.[1]);
    if (Number.isSafeInteger(pid) && pid > 0) {
      this.pid = pid;
      this.shellName = match![2];
      this.tail = "";
    } else {
      // Parse before bounding the retained tail: a complete marker can be at
      // the start of a large chunk containing the shell's startup output.
      this.tail = input.slice(-2048);
    }
  }
}
