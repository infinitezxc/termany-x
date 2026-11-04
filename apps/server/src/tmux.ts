import { parseIdentityOutput, TMUX_IDENTITY_SCRIPT, transcriptIdentity } from "./tmuxIdentity.js";
import { remoteSh } from "./remoteFs.js";
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
// with ":", which tmux never allows in a session name. The name goes last.
const LIST_FORMAT = [
  "#{session_id}", "#{session_windows}", "#{session_attached}", "#{session_created}",
  "#{@termany-agent}", "#{@termany-conversation}", "#{pane_pid}", "#{session_name}",
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

export function tmuxAttachCommand(name: string): string {
  return `exec tmux attach-session -t ${shellQuote(sessionTarget(name))}`;
}
export function parseTmuxSessions(output: string): TmuxSession[] {
  return output.trimEnd().split("\n").filter(Boolean).map(line => {
    const [id, windows, attached, created, agent, conversationId, panePid, ...name] = line.split(":");
    return {
      id, name: name.join(":"), windows: Number(windows), attached: Number(attached), created: Number(created),
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
export async function listTmux(args: string[]): Promise<TmuxSession[]> {
  const sessions = parseTmuxSessions((await remoteSh(args, LIST_SCRIPT, [LIST_FORMAT])).toString());
  for (const session of sessions) {
    const agent = session.agent ?? legacyAgent(session.name);
    if (agent) session.agent = agent;
  }
  const probed = sessions.filter(s => s.agent && Number.isSafeInteger(s.panePid) && s.panePid! > 1);
  if (!probed.length) return sessions;
  const identities = parseIdentityOutput(
    (await remoteSh(args, TMUX_IDENTITY_SCRIPT, probed.map(s => String(s.panePid)))).toString(),
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
export async function listTmuxWithConversations(args: string[], hostKey: string): Promise<TmuxSession[]> {
  const sessions = await listTmux(args);
  await Promise.all(SESSION_AGENTS.map(async (agent) => {
    const linked = sessions.filter((s) => s.agent === agent && s.conversationId);
    if (!linked.length) return;
    const found = await remoteAgentSessionsById(
      (script, scriptArgs) => remoteSh(args, script, scriptArgs), hostKey, agent,
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

export async function createTmux(args: string[], input: { name: unknown; cwd?: unknown; command?: unknown; agent?: unknown; conversationId?: unknown }) {
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
      ` \\; set-option -t ${target} @termany-conversation ${shellQuote(conversationId ?? "")}`
    : "";
  // $3, when set, is the session's command; without it tmux starts a shell.
  await remoteSh(args, CHECK +
    'name=$1; d=$2; case "$d" in "~") d=$HOME;; "~/"*) d=$HOME/${d#"~/"};; esac; ' +
    'if [ -n "$3" ]; then set -- "$3"; else set --; fi; ' +
    `tmux new-session -d -s "$name" -c "$d" "$@"${metadata}`,
    [name, cwd, command ? `exec "\${SHELL:-/bin/sh}" -lic ${shellQuote(command)}` : ""]);
  return name;
}

export async function killTmux(args: string[], name: unknown) {
  const session = tmuxName(name);
  await remoteSh(args, KILL_SCRIPT, [sessionTarget(session), paneTarget(session)]);
}

/** The agent a tmux session was started for: its label, else an older release's name. */
export async function tmuxSessionAgent(args: string[], name: string): Promise<SessionAgent | undefined> {
  const output = await remoteSh(args, CHECK + 'tmux display-message -p -t "$1" "#{@termany-agent}"', [paneTarget(name)]);
  const label = output.toString().trim();
  return SESSION_AGENTS.includes(label as SessionAgent) ? label as SessionAgent : legacyAgent(name);
}

export async function tmuxSessionCwd(args: string[], name: string): Promise<string> {
  const output = await remoteSh(args, CHECK + 'tmux display-message -p -t "$1" "#{pane_current_path}"', [paneTarget(name)]);
  const cwd = output.toString().trimEnd();
  if (!cwd.startsWith("/")) throw new Error("Cannot resolve the tmux session directory");
  return cwd;
}
