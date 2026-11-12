import { useState } from "react";
import { agentLaunchCommand, useAgentConfigs, type AgentConfig } from "../agents";
import { useI18n } from "../i18n";
import { findSessionPane, openSessionPane, pageTitleOf, showsAgent } from "../sessionNavigation";
import { useStore } from "../state/store";
import { queueCommandWhenShellReady, terminalSessionId } from "../terminal/manager";
import { agentLaunch, createRemoteSession, listRemoteSessions, localTmuxAvailable, SESSION_AGENTS, sessionAgentLabel } from "../tmuxClient";
import { AgentLogo } from "./AgentLogo";
import { AgentIcon } from "./icons";

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Icon buttons in a terminal pane's header that start a new agent session.
 * Agents run in tmux on their host (locally when installed). A new agent
 * opens beside an existing agent; ordinary local shells remain plain shells.
 */
export function NewSessionButtons({ paneId }: { paneId: string }) {
  const { t } = useI18n();
  const agents = useAgentConfigs();
  const addPane = useStore((s) => s.addPane);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const startLocal = (agent: AgentConfig) => {
    const source = findSessionPane(paneId);
    const inPlace = !!source && (source.view ?? "terminal") === "terminal" && !source.sshTarget && !showsAgent(source.id);
    const id = inPlace ? source.id : addPane("terminal", agent.name, paneId);
    if (!id) throw new Error(t("tmux.noRoom"));
    queueCommandWhenShellReady(id, agentLaunchCommand(agent));
  };

  const startTmux = async (agent: AgentConfig, sshTarget?: string, sshLabel?: string) => {
    const session = terminalSessionId(paneId, sshTarget);
    const mode = showsAgent(paneId, await listRemoteSessions(session).catch(() => [])) ? "new" : "switch";
    const name = await createRemoteSession(session, agentLaunch(agent, { page: pageTitleOf(paneId) }));
    await openSessionPane({
      mode, sourcePaneId: paneId,
      destination: { title: t("tmux.agentSession", { agent: sessionAgentLabel(agent.id) }), sshTarget, sshLabel, tmuxSession: name },
    });
  };

  const start = async (agent: AgentConfig) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const leaf = findSessionPane(paneId);
      if (leaf?.sshTarget) await startTmux(agent, leaf.sshTarget, leaf.sshLabel);
      else if (await localTmuxAvailable()) await startTmux(agent);
      else startLocal(agent);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return <span className="pane-new-session" role="group" aria-label={t("sessions.new")}>
    {SESSION_AGENTS.map(({ id, label }) => {
      const agent = agents.find(a => a.id === id);
      if (!agent) return null;
      const name = t("sessions.newAgent", { agent: label });
      return <button key={id} className={`pane-new-session-btn${error ? " error" : ""}`} disabled={busy}
        title={error ? `${name}\n${error}` : name} aria-label={name}
        onPointerDown={e => e.stopPropagation()} onClick={() => void start(agent)}>
        {agent.icon ? <AgentLogo src={agent.icon} /> : <AgentIcon />}
      </button>;
    })}
  </span>;
}
