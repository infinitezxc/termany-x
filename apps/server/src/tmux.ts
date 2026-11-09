import { parseIdentityOutput, TMUX_IDENTITY_SCRIPT, transcriptIdentity } from "./tmuxIdentity.js";
import { randomInt } from "node:crypto";
import { tmuxSh, type TmuxHost } from "./tmuxHost.js";
import { shellQuote } from "./remoteCommand.js";
import { remoteAgentSessionsById } from "./agentSessions.js";
import { UUID } from "./uuid.js";

/** The agents whose sessions are labelled with their conversation. */
const SESSION_AGENTS = ["claude", "codex"] as const;
type SessionAgent = (typeof SESSION_AGENTS)[number];
export interface TmuxSession {
  id: string; name: string; windows: number; attached: number; created: number;
  agent?: SessionAgent; conversationId?: string; panePid?: number;
  /** The conversation's title, first prompt and directory, filled in by the API. */
  title?: string; preview?: string; cwd?: string;
}

const CHECK = 'command -v tmux >/dev/null 2>&1 || { echo "tmux is not installed on this host" >&2; exit 1; }; ';
// tmux prints control characters in -F output as "_", so fields are joined
// with ":", which tmux never allows in a session name. The title goes last
// because it can contain colons.
const LIST_FORMAT = [
  "#{session_id}", "#{session_windows}", "#{session_attached}", "#{session_created}",
  "#{@termany-agent}", "#{@termany-conversation}", "#{pane_pid}", "#{session_name}", "#{pane_title}",
].join(":");
// A host with no tmux server yet has no sessions; anything else is an error.
const LIST_SCRIPT = CHECK +
  'out=$(tmux list-sessions -F "$1" 2>&1); code=$?; ' +
  'if [ "$code" = 0 ]; then printf "%s\\n" "$out"; exit 0; fi; ' +
  'case "$out" in *"no server running"*|*"No such file or directory"*) exit 0;; esac; ' +
  'printf "%s\\n" "$out" >&2; exit "$code"';
// Checked in the same command as the kill, so a stale client list cannot end
// a session someone is looking at. $1 is the session target, $2 the pane one.
const KILL_SCRIPT = CHECK +
  'n=$(tmux display-message -p -t "$2" "#{session_attached}") || exit 1; ' +
  'case "$n" in 0) ;; "") echo "No such tmux session" >&2; exit 1;; ' +
  '*) echo "This session is open in a terminal. Detach it before ending it." >&2; exit 1;; esac; ' +
  'tmux kill-session -t "$1"';

export function tmuxName(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 128 || /[\x00-\x1f\x7f:.]/.test(value)) throw new Error("Invalid tmux session name");
  return value;
}
/**
 * Exact-match targets. Session commands take `=name`, but commands that target
 * a pane (set-option, display-message) need `=name:`: given `=name` they find
 * nothing, and display-message then prints an empty string without failing.
 */
const sessionTarget = (name: string) => `=${tmuxName(name)}`;
const paneTarget = (name: string) => `${sessionTarget(name)}:`;

/**
 * Agent sessions attach drawn on the browser terminal's normal screen, so
 * output tmux scrolls off lands in xterm's scrollback (the alternate screen
 * has none: the wheel becomes arrow keys). `indn@` keeps tmux scrolling with
 * linefeeds, which xterm keeps; it drops lines scrolled by `CSI n S`. Other
 * sessions keep the alternate screen for full-screen programs, Codex among
 * them: it draws full screen by default, and drawn onto the normal screen its
 * redraws would reach the scrollback rather than the wheel reaching Codex.
 *
 * tmux reads overrides only when a client attaches, and runs one command's
 * parts back to back, so setting the entry, attaching and removing it in one
 * command keeps every other client from seeing it. has-session goes first
 * because tmux skips the rest of a command after a failure. The index is
 * random and well below 2^32, where tmux wraps to the user's low indexes; one
 * in use is left alone. Old tmux fails the check and attaches as before.
 *
 * $1 session target, $2 pane target, $3 a legacy name's agent, $4 index.
 * One line: csh-family shells reject newlines inside quotes.
 */
const ATTACH_SCRIPT = [
  `slot="terminal-overrides[$4]"; o='*:smcup@:rmcup@:indn@'`,
  `a=$(tmux display-message -p -t "$2" '#{@termany-agent}' 2>/dev/null); [ -n "$a" ] || a=$3`,
  `case "$a" in ""|codex) exec tmux attach-session -t "$1";; esac`,
  `v=$(tmux show-options -sv "$slot" 2>/dev/null) && [ -z "$v" ] || exec tmux attach-session -t "$1"`,
  `tmux has-session -t "$1" \\; set-option -s "$slot" "$o" \\; attach-session -t "$1" \\; set-option -su "$slot"; s=$?`,
  `[ "$(tmux show-options -sv "$slot" 2>/dev/null)" = "$o" ] && tmux set-option -su "$slot"`,
  `exit "$s"`,
].join("; ");

/** The command an SSH pane runs on the host to attach to a session. */
export function tmuxAttachCommand(name: string, slot = randomInt(1_000_000, 2_000_000_000)): string {
  const args = [ATTACH_SCRIPT, "sh", sessionTarget(name), paneTarget(name), legacyAgent(name) ?? "", String(slot)];
  return `exec sh -c ${args.map(shellQuote).join(" ")}`;
}
export function parseTmuxSessions(output: string): TmuxSession[] {
  return output.trimEnd().split("\n").filter(Boolean).map(line => {
    const [id, windows, attached, created, agent, conversationId, panePid, name, ...paneTitle] = line.split(":");
    // The transcript may not exist locally (Codex can use its app-server),
    // while the CLI still publishes its conversation title through OSC.
    // Recognize each agent's format so a shell hostname is never a title.
    const kind = agent || legacyAgent(name);
    const oscTitle = paneTitle.join(":").trim();
    const title = kind === "claude"
      ? /^[·✢✳∗✻✽]\s+(.+)$/.exec(oscTitle)?.[1].trim()
      : kind === "codex"
        ? /^(.*?)\s+\|\s+.+$/.exec(oscTitle)?.[1].replace(/^[\u2800-\u28ff]\s+/, "").trim()
        : undefined;
    return {
      id, name, windows: Number(windows), attached: Number(attached), created: Number(created),
      ...(title && title !== "Claude Code" && !/^codex$/i.test(title) ? { title } : {}),
      ...(SESSION_AGENTS.includes(agent as SessionAgent) ? { agent: agent as SessionAgent } : {}),
      ...(UUID.test(conversationId) ? { conversationId } : {}),
      ...(panePid ? { panePid: Number(panePid) } : {}),
    };
  });
}

/** Older releases named sessions without metadata; infer only the agent kind. */
function legacyAgent(name: string): SessionAgent | undefined {
  if (/^(?:termany-)?claude-/.test(name)) return "claude";
  if (/^(?:termany-)?codex-/.test(name)) return "codex";
  return undefined;
}

/**
 * Lists sessions without changing them. The conversation a pane is actually
 * running wins over the ID recorded at launch, which goes stale when the user
 * resumes or clears inside the agent.
 */
export async function listTmux(args: TmuxHost): Promise<TmuxSession[]> {
  const sessions = parseTmuxSessions((await tmuxSh(args, LIST_SCRIPT, [LIST_FORMAT])).toString());
  for (const session of sessions) {
    const agent = session.agent ?? legacyAgent(session.name);
    if (agent) session.agent = agent;
  }
  const probed = sessions.filter(s => s.agent && Number.isSafeInteger(s.panePid) && s.panePid! > 1);
  if (!probed.length) return sessions;
  const identities = parseIdentityOutput(
    (await tmuxSh(args, TMUX_IDENTITY_SCRIPT, probed.map(s => String(s.panePid)))).toString(),
  );
  for (const session of probed) {
    const actual = transcriptIdentity(identities.get(session.panePid!) ?? "", session.agent!);
    if (actual) session.conversationId = actual;
  }
  return sessions;
}

/**
 * listTmux, with each agent session labelled by its conversation's title,
 * first prompt and directory, as the history list shows them. `hostKey` keeps
 * this host's transcripts apart in the parse cache. A failed lookup only
 * costs the labels.
 */
export async function listTmuxWithConversations(args: TmuxHost, hostKey: string): Promise<TmuxSession[]> {
  const sessions = await listTmux(args);
  await Promise.all(SESSION_AGENTS.map(async (agent) => {
    const linked = sessions.filter((s) => s.agent === agent && s.conversationId);
    if (!linked.length) return;
    const found = await remoteAgentSessionsById(
      (script, scriptArgs) => tmuxSh(args, script, scriptArgs), hostKey, agent,
      linked.map((s) => s.conversationId!),
    ).catch(() => new Map());
    for (const s of linked) {
      const conversation = found.get(s.conversationId!.toLowerCase());
      if (!conversation) continue;
      if (conversation.title) s.title = conversation.title;
      if (conversation.preview) s.preview = conversation.preview;
      if (conversation.cwd) s.cwd = conversation.cwd;
    }
  }));
  return sessions;
}

export async function createTmux(args: TmuxHost, input: { name: unknown; cwd?: unknown; command?: unknown; agent?: unknown; conversationId?: unknown }) {
  const name = tmuxName(input.name);
  if (!/^[\p{L}\p{N}_ -]+$/u.test(name) || name.startsWith("-")) throw new Error("Use letters, numbers, spaces, underscores or hyphens for the name");
  const { agent, conversationId } = input;
  const cwd = input.cwd || "~";
  const command = input.command || "";
  if (typeof cwd !== "string" || /[\x00\r\n]/.test(cwd)) throw new Error("Invalid directory");
  if (typeof command !== "string" || /[\x00\r\n]/.test(command)) throw new Error("Invalid command");
  if (agent !== undefined && !SESSION_AGENTS.includes(agent as SessionAgent)) throw new Error("Invalid agent");
  if (conversationId !== undefined && (typeof conversationId !== "string" || !UUID.test(conversationId))) throw new Error("Invalid conversation ID");
  // The metadata is set in the same tmux command as the new session, so no
  // other client can see the session before it is labelled.
  const target = shellQuote(paneTarget(name));
  const metadata = agent
    ? ` \\; set-option -t ${target} @termany-agent ${shellQuote(agent as string)}` +
      ` \\; set-option -t ${target} @termany-conversation ${shellQuote(conversationId ?? "")}` +
      // Codex asks for mouse reporting only when tmux's mouse is on; with it,
      // the wheel reaches Codex and scrolls its transcript by line.
      (agent === "codex" ? ` \\; set-option -t ${target} mouse on` : "")
    : "";
  // $3, when set, is the session's command; without it tmux starts a shell.
  await tmuxSh(args, CHECK +
    'name=$1; d=$2; case "$d" in "~") d=$HOME;; "~/"*) d=$HOME/${d#"~/"};; esac; ' +
    'if [ -n "$3" ]; then set -- "$3"; else set --; fi; ' +
    `tmux new-session -d -s "$name" -c "$d" "$@"${metadata}`,
    [name, cwd, command ? `exec "\${SHELL:-/bin/sh}" -lic ${shellQuote(command)}` : ""]);
  return name;
}

export async function killTmux(args: TmuxHost, name: unknown) {
  const session = tmuxName(name);
  await tmuxSh(args, KILL_SCRIPT, [sessionTarget(session), paneTarget(session)]);
}

/**
 * A single-pane session's history, escape-coded with wrapped lines joined, or
 * null for a split window, whose pane is narrower than the client. With no
 * history, `-E -1` would yield the screen, so it is not asked.
 */
const HISTORY_SCRIPT = CHECK +
  `info=$(tmux display-message -p -t "$1" '#{window_panes}:#{history_size}') || exit 1; ` +
  'case "$info" in 1:0) exit 0;; 1:*) ;; *) echo split; exit 0;; esac; ' +
  'printf "full\\n"; exec tmux capture-pane -p -e -J -S - -E -1 -t "$1"';

export async function tmuxPaneHistory(args: TmuxHost, name: string): Promise<string | null> {
  const output = (await tmuxSh(args, HISTORY_SCRIPT, [paneTarget(name)])).toString("utf8");
  if (output.startsWith("split")) return null;
  return output.startsWith("full\n") ? output.slice(5) : "";
}

/** The agent a tmux session was started for: its label, else an older release's name. */
export async function tmuxSessionAgent(args: TmuxHost, name: string): Promise<SessionAgent | undefined> {
  const output = await tmuxSh(args, CHECK + 'tmux display-message -p -t "$1" "#{@termany-agent}"', [paneTarget(name)]);
  const label = output.toString().trim();
  return SESSION_AGENTS.includes(label as SessionAgent) ? label as SessionAgent : legacyAgent(name);
}

export async function tmuxSessionCwd(args: TmuxHost, name: string, timeoutMs?: number): Promise<string> {
  const output = await tmuxSh(args, CHECK + 'tmux display-message -p -t "$1" "#{pane_current_path}"', [paneTarget(name)], { timeoutMs });
  const cwd = output.toString().trimEnd();
  if (!cwd.startsWith("/")) throw new Error("Cannot resolve the tmux session directory");
  return cwd;
}
