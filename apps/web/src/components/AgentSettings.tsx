import { textInputProps } from "../textInputProps";
import { useEffect, useRef, useState } from "react";
import {
  agentCommand,
  createCustomAgent,
  detectAgentConfigs,
  loadAgentConfigs,
  saveAgentConfigs,
  syncAgentConfigs,
  type AgentConfig,
} from "../agents";
import { agentInstallCommand, enableAgentAfterInstallLaunch } from "../agentInstall";
import { useI18n } from "../i18n";
import { AgentAvatarEditor } from "./AgentIdentityFields";
import { AgentLogo } from "./AgentLogo";
import { AgentIcon, ChevronIcon, CloseIcon, PlusIcon, RefreshIcon } from "./icons";

function AgentAvatar({ agent }: { agent: AgentConfig }) {
  return (
    <span
      className={`agent-settings-icon ${agent.icon ? "" : "fallback"}`}
      data-agent-id={agent.id}
      aria-hidden="true"
    >
      {agent.icon ? <AgentLogo src={agent.icon} /> : <AgentIcon />}
    </span>
  );
}

export function AgentSettings({
  initialAgentId,
  onInstallAgent,
}: {
  initialAgentId?: string;
  onInstallAgent?: (agentName: string, command: string) => boolean;
}) {
  const { t } = useI18n();
  const [agents, setAgents] = useState(loadAgentConfigs);
  const [expanded, setExpanded] = useState<string | null>(initialAgentId ?? null);
  const initialAgentRef = useRef<HTMLDivElement>(null);
  const [detecting, setDetecting] = useState(false);
  const [detectionComplete, setDetectionComplete] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const commit = (next: AgentConfig[]) => {
    setAgents(next);
    saveAgentConfigs(next);
  };

  const updateAgent = (id: string, patch: Partial<AgentConfig>) => {
    commit(agents.map((agent) => (agent.id === id ? { ...agent, ...patch } : agent)));
  };

  const detect = async (source = agents) => {
    setDetecting(true);
    setStatus(null);
    try {
      const next = await detectAgentConfigs(source);
      setAgents(next);
      saveAgentConfigs(next);
    } catch (e) {
      setStatus(`${t("agents.detectFailed")}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setDetecting(false);
      setDetectionComplete(true);
    }
  };

  useEffect(() => {
    void syncAgentConfigs()
      .then((next) => detect(next))
      .catch(() => detect(loadAgentConfigs()));
    // Detect once when the settings section opens; manual refresh stays explicit after that.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!initialAgentId) return;
    initialAgentRef.current?.scrollIntoView({ block: "nearest" });
  }, [initialAgentId]);

  const addCustom = () => {
    const agent = createCustomAgent();
    const next = [agent, ...agents];
    commit(next);
    setExpanded(agent.id);
  };

  const removeCustom = (id: string) => {
    const next = agents.filter((agent) => agent.id !== id);
    commit(next);
    if (expanded === id) setExpanded(next[0]?.id ?? null);
  };

  const installAgent = (agent: AgentConfig, command: string) => {
    if (!onInstallAgent?.(agent.name, command)) {
      setStatus(t("agents.installTerminalFailed"));
      return;
    }
    commit(enableAgentAfterInstallLaunch(agents, agent.id));
  };

  return (
    <div className="agent-settings">
      <div className="agent-settings-head">
        <div className="settings-section-title">{t("agents.title")}</div>
        <div className="agent-settings-head-actions">
          <button className="agent-refresh-btn" onClick={addCustom}>
            <PlusIcon />
            {t("agents.add")}
          </button>
          <button className="agent-refresh-btn" onClick={() => detect()} disabled={detecting}>
            <RefreshIcon />
            {detecting ? "..." : t("agents.refresh")}
          </button>
        </div>
      </div>
      {status && <div className="agent-settings-status">{status}</div>}

      <div className="agent-settings-list">
        {agents.map((agent) => {
          const isExpanded = expanded === agent.id;
          const installCommand = agent.builtIn ? agentInstallCommand(agent.id) : undefined;
          const needsInstall = Boolean(installCommand) && agent.terminalDetected === false;
          const checkingInstall = agent.builtIn
            && agent.terminalDetected === undefined
            && !detectionComplete;
          return (
            <div
              key={agent.id}
              ref={agent.id === initialAgentId ? initialAgentRef : undefined}
              className="agent-settings-row"
            >
              <div className="agent-settings-main">
                <AgentAvatar agent={agent} />
                <div className="agent-settings-meta">
                  <div className="agent-settings-name">{agent.name}</div>
                  <div className="agent-settings-command" title={agent.terminalDetectedPath ?? agentCommand(agent)}>
                    {agentCommand(agent) || t("agents.commandMissing")}
                  </div>
                </div>

                <div className="agent-settings-actions">
                  {needsInstall ? (
                    <button
                      className="agent-install-btn"
                      title={installCommand}
                      onClick={() => {
                        if (installCommand) installAgent(agent, installCommand);
                      }}
                    >
                      {t("agents.install")}
                    </button>
                  ) : checkingInstall ? (
                    <button className="agent-install-btn is-pending" disabled>
                      {t("agents.detecting")}
                    </button>
                  ) : (
                    <div className="agent-enable-toggle" aria-label={`${agent.name} enabled state`}>
                      <button
                        className={agent.enabled ? "active" : ""}
                        onClick={() => updateAgent(agent.id, { enabled: true })}
                      >
                        {t("agents.enabled")}
                      </button>
                      <button
                        className={!agent.enabled ? "active" : ""}
                        onClick={() => updateAgent(agent.id, { enabled: false })}
                      >
                        {t("agents.disabled")}
                      </button>
                    </div>
                  )}
                  <button
                    className="agent-expand-btn"
                    title={isExpanded ? "Collapse" : "Expand"}
                    onClick={() => setExpanded(isExpanded ? null : agent.id)}
                  >
                    <ChevronIcon dir={isExpanded ? "up" : "down"} />
                  </button>
                </div>
              </div>

              {isExpanded && (
                <div className="agent-settings-edit">
                  <label className="agent-field">
                    <span>{t("agents.name")}</span>
                    <input
                      {...textInputProps}
                      value={agent.name}
                      onChange={(e) => updateAgent(agent.id, { name: e.target.value })}
                    />
                  </label>
                  {!agent.builtIn && (
                    <div className="agent-field agent-custom-icon-field">
                      <span>{t("agents.avatar")}</span>
                      <AgentAvatarEditor
                        avatar={agent.icon}
                        fallback={<AgentIcon />}
                        onAvatarChange={(icon) => updateAgent(agent.id, { icon: icon || undefined })}
                      />
                    </div>
                  )}
                  <section className={`agent-config-card agent-terminal-card${agent.enabled ? " is-enabled" : ""}`}>
                    <div className="agent-config-card-head">
                      <div>
                        <div className="agent-config-card-title">{t("agents.terminal")}</div>
                        <div className="agent-config-card-description">{t("agents.terminalHelp")}</div>
                      </div>
                    </div>
                    <div className="agent-config-card-body">
                      <label className="agent-field">
                        <span>{t("agents.command")}</span>
                        <input
                          {...textInputProps}
                          value={agent.command}
                          onChange={(e) => updateAgent(agent.id, { command: e.target.value })}
                        />
                      </label>
                      <label className="agent-field">
                        <span>{t("agents.args")}</span>
                        <input
                          {...textInputProps}
                          value={agent.args}
                          onChange={(e) => updateAgent(agent.id, { args: e.target.value })}
                        />
                      </label>
                    </div>
                  </section>
                  {!agent.builtIn && (
                    <div className="agent-settings-edit-foot">
                      <button className="agent-remove-btn" onClick={() => removeCustom(agent.id)}>
                        <CloseIcon />
                        {t("agents.remove")}
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
