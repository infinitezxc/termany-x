import { UUID_PATTERN } from "./uuid.js";

/**
 * Report what identifies the conversation running under each tmux pane: the
 * files open in its process tree (Codex keeps its rollout open) and Claude's
 * per-process session record (Claude does not keep its transcript open).
 * Takes the pane pids as arguments; prints `=<pid>` before each pane's lines.
 */
export const TMUX_IDENTITY_SCRIPT = `
claude_dir=\${CLAUDE_CONFIG_DIR:-$HOME/.claude}
table=$(ps -A -o pid= -o ppid=)
for root; do
  printf '=%s\\n' "$root"
  pids=$(printf '%s\\n' "$table" | awk -v root="$root" '
{ parent[$1]=$2 }
END { for (pid in parent) { p=pid; for (i=0;i<128 && p>1;i++) { if (p==root) { print pid; break } p=parent[p] } } }')
  for pid in $pids; do
    # The record has no trailing newline; add one so sed's output ends a line.
    if [ -f "$claude_dir/sessions/$pid.json" ]; then
      { cat "$claude_dir/sessions/$pid.json"; echo; } | sed -n 's/.*"sessionId" *: *"\\([0-9a-fA-F-]*\\)".*/claude-session:\\1/p'
    fi
    if [ -d "/proc/$pid/fd" ]; then
      for fd in /proc/$pid/fd/*; do readlink "$fd" 2>/dev/null; done
    elif command -v lsof >/dev/null 2>&1; then
      lsof -a -p "$pid" -Fn 2>/dev/null | sed -n 's/^n//p'
    fi
  done
done
exit 0
`;

/** Split TMUX_IDENTITY_SCRIPT output into each pane pid's lines. */
export function parseIdentityOutput(output: string): Map<number, string> {
  const result = new Map<number, string>();
  let current: number | undefined;
  for (const line of output.split("\n")) {
    if (line.startsWith("=")) {
      current = Number(line.slice(1));
      result.set(current, "");
    } else if (current !== undefined && line) {
      result.set(current, `${result.get(current)}${line}\n`);
    }
  }
  return result;
}

const ID = UUID_PATTERN;
export function transcriptIdentity(paths: string, agent: "claude" | "codex"): string | undefined {
  const pattern = agent === "codex"
    ? new RegExp(`/rollout-[^/]*-(${ID})\\.jsonl$`, "i")
    : new RegExp(`^claude-session:(${ID})$|/projects/[^/]+/(${ID})\\.jsonl$`, "i");
  const ids = new Set(paths.split("\n").map(p => {
    const match = pattern.exec(p);
    return (match?.[1] ?? match?.[2])?.toLowerCase();
  }).filter((id): id is string => !!id));
  return ids.size === 1 ? [...ids][0] : undefined;
}
