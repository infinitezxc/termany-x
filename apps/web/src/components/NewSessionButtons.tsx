import type { AgentConfig } from "../agents";
import { useI18n } from "../i18n";
import { SESSION_AGENTS } from "../tmuxClient";
import { PlusIcon } from "./icons";

/** Compact "start a new agent session" buttons for a section header. */
export function NewSessionButtons({ agents, busy = false, onCreate }: {
  agents: AgentConfig[]; busy?: boolean; onCreate: (agent: AgentConfig) => void;
}) {
  const { t } = useI18n();
  return <div className="session-new" role="group" aria-label={t("sessions.new")}>
    {SESSION_AGENTS.map(({ id, label }) => {
      const agent = agents.find(a => a.id === id);
      return <button key={id} className="session-new-btn" disabled={busy || !agent}
        title={t("sessions.newAgent", { agent: label })} onClick={() => agent && onCreate(agent)}>
        <PlusIcon />
        <span>{label}</span>
      </button>;
    })}
  </div>;
}
