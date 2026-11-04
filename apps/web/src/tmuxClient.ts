import { apiPath } from "./api";
import { buildAgentCommand, shellQuote } from "./agentCommand";
import { getLanguage, translate } from "./i18n";

export type SessionAgent = "claude" | "codex";
/** The agents whose sessions run in remote tmux, in picker order. */
export const SESSION_AGENTS: ReadonlyArray<{ id: SessionAgent; label: string }> = [
  { id: "codex", label: "Codex" },
  { id: "claude", label: "Claude Code" },
];
export const sessionAgentLabel = (id: string) => SESSION_AGENTS.find(a => a.id === id)?.label ?? id;

export interface RemoteSession {
  id: string; name: string; windows: number; attached: number;
  agent?: SessionAgent; conversationId?: string;
  /** The conversation's title, first prompt and directory, when the host has its transcript. */
  title?: string; preview?: string; cwd?: string;
}
export interface TmuxLaunch {
  name: string; command: string; agent: SessionAgent; conversationId?: string; cwd?: string | null;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const message = (key: string, params?: Record<string, string>) => translate(getLanguage(), key, params);

/**
 * The command that starts or resumes an agent, built from the user's binary
 * and launch args (Settings → Agents) so custom paths and flags apply to
 * resumed sessions too. `fork` gives Claude a new conversation ID instead of
 * appending to a transcript another process may still be writing.
 */
export function agentLaunch(
  config: { id: string; command: string; args: string },
  options: { resume?: string; fork?: boolean; newId?: string } = {},
): TmuxLaunch {
  if (config.id !== "claude" && config.id !== "codex") throw new Error(message("sessions.error.unsupportedAgent"));
  if (options.resume && !UUID.test(options.resume)) throw new Error(message("sessions.error.invalidId"));
  const fresh = options.newId ?? crypto.randomUUID();
  const fork = config.id === "claude" && !!options.resume && !!options.fork;
  const conversationId = config.id === "claude" ? (fork ? fresh : options.resume ?? fresh) : options.resume;
  const args = config.id === "claude"
    ? [
        options.resume ? `--resume ${shellQuote(options.resume)}` : "",
        fork ? "--fork-session" : "",
        !options.resume || fork ? `--session-id ${shellQuote(conversationId!)}` : "",
        config.args,
      ]
    : [options.resume ? `resume ${shellQuote(options.resume)}` : "", config.args];
  return {
    name: `termany-${config.id}-${conversationId ?? fresh}`, agent: config.id, conversationId,
    command: buildAgentCommand(config.command.trim() || config.id, args.filter(Boolean).join(" ")),
  };
}
export function matchingTmux(sessions: RemoteSession[], agent: string, id: string) {
  // Names are labels, not proof of which conversation a process is running.
  return sessions.find(s => s.agent === agent && s.conversationId === id);
}

/**
 * Whether resuming a conversation must fork it so two processes never append
 * to one transcript. A running session not yet linked to its conversation
 * might be this one, so Claude forks; Codex cannot fork, so it refuses only
 * when the conversation was recently active and could therefore be running.
 */
export function resumeFork(sessions: RemoteSession[], agent: string, live: boolean): boolean {
  const unlinked = sessions.some(s => s.agent === agent && !s.conversationId);
  if (agent === "claude") return live || unlinked;
  if (live && unlinked) throw new Error(message("sessions.error.unlinked", { agent: sessionAgentLabel(agent) }));
  return false;
}

async function request(path: string, init?: RequestInit) {
  const response = await fetch(apiPath(path), init);
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || String(response.status));
  return payload;
}
const post = (path: string, body: object) =>
  request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

/**
 * Run a host's conversation in tmux: the session already running it, or a new
 * one resuming it — forked where another process could share its transcript.
 */
export async function resumeOnHost(
  session: string,
  config: { id: string; command: string; args: string },
  options: { conversationId: string; live: boolean; cwd: string | null },
): Promise<{ name: string; conversationId?: string; created: boolean }> {
  const running = await listRemoteSessions(session);
  const existing = matchingTmux(running, config.id, options.conversationId);
  if (existing) return { name: existing.name, conversationId: existing.conversationId, created: false };
  const launch = agentLaunch(config, {
    resume: options.conversationId, fork: resumeFork(running, config.id, options.live),
  });
  const name = await createRemoteSession(session, { ...launch, cwd: options.cwd });
  return { name, conversationId: launch.conversationId, created: true };
}

export async function listRemoteSessions(session: string): Promise<RemoteSession[]> {
  return (await request(`/api/tmux?${new URLSearchParams({ session })}`)).sessions;
}
export async function createRemoteSession(session: string, launch: TmuxLaunch): Promise<string> {
  return (await post("/api/tmux/create", { ...launch, session })).name;
}
export async function endRemoteSession(session: string, name: string): Promise<void> {
  await post("/api/tmux/kill", { session, name });
}
