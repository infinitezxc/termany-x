import { useAgentConfigs, type AgentConfig } from "../agents";
import { useI18n } from "../i18n";
import { findTmuxPane, openSessionPane, showsAgent } from "../sessionNavigation";
import type { SessionOpenMode } from "../sessionOpenPolicy";
import type { RemoteSessionList, SessionAction } from "../sessionPickerState";
import { tildify } from "../tildify";
import { agentLaunch, createRemoteSession, endRemoteSession, sessionAgentLabel, type RemoteSession } from "../tmuxClient";
import { NewPaneIcon, RefreshIcon, SpinnerIcon, TerminalIcon, TrashIcon } from "./icons";
import { NewSessionButtons } from "./NewSessionButtons";
import "./SessionPicker.css";

/**
 * The tmux sessions on an SSH pane's host, with actions to open, create and
 * end them. Opening shows a session in the picker's pane, or in a new pane;
 * one already open in a pane is shown there instead. The list and the action
 * state belong to the picker, which also resumes history into these sessions.
 */
export function RemoteSessions({ host, sourcePaneId, remote, action, query = "", onOpened }: {
  /** `session` is the SSH pane's terminal session, which the tmux API runs through. */
  host: { session: string; target: string; label?: string };
  sourcePaneId?: string;
  remote: RemoteSessionList;
  action: SessionAction;
  query?: string;
  onOpened?: () => void;
}) {
  const { t } = useI18n();
  const agents = useAgentConfigs();
  const busy = action.busy || remote.loading;

  /** The agent's title, else the first prompt; generated names are only a fallback. */
  const agentLabel = (agent: string) => t("tmux.agentSession", { agent: sessionAgentLabel(agent) });
  const labelFor = (s: RemoteSession) => s.title || s.preview || (s.agent ? agentLabel(s.agent) : s.name);

  const open = async (sessionName: string, title: string, mode: SessionOpenMode = "switch") => {
    await openSessionPane({
      mode, sourcePaneId,
      destination: { title, sshTarget: host.target, sshLabel: host.label, tmuxSession: sessionName },
    });
    onOpened?.();
  };
  const create = (agent: AgentConfig) => action.run(async () => {
    if (agent.id !== "codex" && agent.id !== "claude") throw new Error(t("sessions.error.noAgent", { agent: sessionAgentLabel(agent.id) }));
    // Decided before the reload, from the list the picker showed.
    const mode = showsAgent(sourcePaneId, remote.sessions) ? "new" : "switch";
    const name = await createRemoteSession(host.session, agentLaunch(agent));
    await remote.reload();
    await open(name, agentLabel(agent.id), mode);
  });
  const end = (name: string) => action.run(async () => {
    await endRemoteSession(host.session, name);
    await remote.reload();
  });

  const q = query.toLowerCase();
  const visible = remote.sessions.filter(s => `${s.name} ${labelFor(s)} ${s.preview ?? ""} ${s.cwd ?? ""}`.toLowerCase().includes(q));
  return <section className="remote-sessions">
    <div className="session-section-head">
      <span className="session-section-label">{t("sessions.running")}</span>
      <span className="session-section-host" title={host.target}>{host.label || host.target}</span>
      <button className="session-icon-btn" disabled={busy} title={t("tmux.refresh")} aria-label={t("tmux.refresh")}
        onClick={() => void action.run(remote.reload)}>
        {busy ? <SpinnerIcon /> : <RefreshIcon />}
      </button>
      <NewSessionButtons agents={agents} busy={busy} onCreate={agent => void create(agent)} />
    </div>
    <div className="tmux-list">{visible.map(s => {
      const rowLabel = labelFor(s);
      const icon = agents.find(a => a.id === s.agent)?.icon;
      // Like a history row: the conversation's title, its first prompt, then its details.
      const meta = [
        s.preview && s.agent ? sessionAgentLabel(s.agent) : null,
        s.cwd ? tildify(s.cwd) : null,
        rowLabel === s.name ? null : s.name,
        s.windows === 1 ? null : t("tmux.windows", { n: s.windows }),
      ].filter(Boolean);
      const shown = !!findTmuxPane(host.target, s.name);
      return <div className="session-row" key={s.id}>
        <button className="search-row" disabled={busy} title={t(shown ? "history.badge.openTitle" : "sessions.switch")}
          onClick={() => void action.run(() => open(s.name, rowLabel))}>
          <span className="search-row-ico">{icon ? <img className="history-tab-icon" src={icon} alt="" aria-hidden="true" /> : <TerminalIcon />}</span>
          <span className="search-row-main">
            <span className="search-row-label">{rowLabel}</span>
            {s.title && s.preview && <span className="search-row-breadcrumb">{s.preview}</span>}
            <span className="search-row-breadcrumb">{meta.join(" · ")}</span>
          </span>
          {s.attached > 0 && <span className="history-badge open">{t("tmux.attachedBadge")}</span>}
        </button>
        {!shown && <button className="session-icon-btn session-row-action" disabled={busy}
          title={t("sessions.openNewPane")} aria-label={t("sessions.openNewPane")}
          onClick={() => void action.run(() => open(s.name, rowLabel, "new"))}>
          <NewPaneIcon />
        </button>}
        {/* A session someone is looking at cannot be ended from here; the server checks too. */}
        <button className="session-icon-btn session-row-action" disabled={busy || s.attached > 0}
          title={t(s.attached > 0 ? "tmux.endAttached" : "tmux.end")} aria-label={t("tmux.end")}
          onClick={() => void end(s.name)}>
          <TrashIcon />
        </button>
      </div>;
    })}</div>
    {!remote.sessions.length && !busy && !remote.error && <p className="session-note">{t("tmux.empty")}</p>}
    {remote.error && <p role="alert" className="session-error">{remote.error}</p>}
  </section>;
}
