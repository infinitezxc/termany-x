import { getAgentsRaw, setAgentsRaw } from "./db.js";

export interface AgentConfig {
  id: string;
  name: string;
  command: string;
  args: string;
  /** Whether this agent's CLI/TUI can be launched in a terminal. */
  enabled: boolean;
  icon?: string;
  builtIn: boolean;
}

const REMOVED_AGENT_IDS = new Set(["charm", "kilocode", "droid"]);
const GENERATED_AGENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function customCommand(id: string, value: unknown): string {
  const command = String(value ?? "").trim();
  return GENERATED_AGENT_ID.test(id) && command === id ? "" : command;
}

const BUILTIN_AGENTS: AgentConfig[] = [
  {
    id: "claude",
    name: "Claude",
    command: "claude",
    args: "--dangerously-skip-permissions",
    enabled: true,
    builtIn: true,
  },
  {
    id: "codex",
    name: "Codex",
    command: "codex",
    args: "--dangerously-bypass-approvals-and-sandbox",
    enabled: true,
    builtIn: true,
  },
  { id: "gemini", name: "Gemini", command: "gemini", args: "--yolo", enabled: false, builtIn: true },
  { id: "grok", name: "Grok Build", command: "grok", args: "--always-approve", enabled: false, builtIn: true },
  { id: "openclaw", name: "OpenClaw", command: "openclaw", args: "", enabled: true, builtIn: true },
  { id: "fastclaw", name: "FastClaw", command: "fastclaw", args: "", enabled: false, builtIn: true },
  { id: "hermes", name: "Hermes", command: "hermes", args: "", enabled: false, builtIn: true },
  {
    id: "opencode",
    name: "OpenCode",
    command: "opencode",
    args: "",
    enabled: false,
    builtIn: true,
  },
  { id: "cursor", name: "Cursor", command: "cursor-agent", args: "", enabled: false, builtIn: true },
  { id: "kimi", name: "Kimi", command: "kimi", args: "", enabled: false, builtIn: true },
  { id: "omp", name: "OMP", command: "omp", args: "", enabled: false, builtIn: true },
];

function orderedRegistry(agents: AgentConfig[]): AgentConfig[] {
  const builtInIds = new Set(BUILTIN_AGENTS.map((agent) => agent.id));
  const custom = agents.filter((agent) => !agent.builtIn);
  const savedBuiltIns = new Map(agents.filter((agent) => agent.builtIn).map((agent) => [agent.id, agent]));
  return [
    ...custom,
    ...BUILTIN_AGENTS.map((fallback) => savedBuiltIns.get(fallback.id) ?? fallback),
  ].filter((agent, index, all) =>
    (agent.builtIn || !builtInIds.has(agent.id)) && all.findIndex((entry) => entry.id === agent.id) === index
  );
}

function isRemovedDefault(input: any): boolean {
  const id = String(input?.id ?? "").trim();
  if (!REMOVED_AGENT_IDS.has(id)) return false;
  // A user-supplied adapter may intentionally reuse a familiar command id.
  // Only retire the old system preset; explicit custom runtimes remain valid.
  return input?.runtime?.distribution !== "custom";
}

function sanitize(input: any, builtIn = false): AgentConfig | null {
  const id = String(input?.id ?? "").trim();
  if (!id) return null;
  const command = builtIn ? String(input?.command ?? "").trim() : customCommand(id, input?.command);
  return {
    id,
    name: String(input?.name ?? "").trim() || id,
    command,
    args: String(input?.args ?? "").trim(),
    enabled: input?.enabled !== false,
    icon: typeof input?.icon === "string" ? input.icon : undefined,
    builtIn,
  };
}

export function listAgentConfigs(): { agents: AgentConfig[]; persisted: boolean } {
  const raw = getAgentsRaw();
  if (!raw) return { agents: BUILTIN_AGENTS, persisted: false };
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error("invalid agents config");
    const builtIns = new Map(BUILTIN_AGENTS.map((agent) => [agent.id, agent]));
    const agents = parsed
      .filter((item) => !isRemovedDefault(item))
      .map((item) => {
        const fallback = builtIns.get(String(item?.id ?? ""));
        return sanitize(item, Boolean(fallback));
      })
      .filter((item): item is AgentConfig => item !== null);
    return { agents: orderedRegistry(agents), persisted: true };
  } catch {
    return { agents: BUILTIN_AGENTS, persisted: false };
  }
}

export function saveAgentConfigs(input: unknown): AgentConfig[] {
  if (!Array.isArray(input)) throw new Error("agents must be an array");
  const builtIns = new Map(BUILTIN_AGENTS.map((agent) => [agent.id, agent]));
  const agents = input
    .slice(0, 64)
    .filter((item) => !isRemovedDefault(item))
    .map((item) => {
      const fallback = builtIns.get(String(item?.id ?? ""));
      return sanitize(item, Boolean(fallback));
    })
    .filter((item): item is AgentConfig => item !== null);
  const ordered = orderedRegistry(agents);
  setAgentsRaw(JSON.stringify(ordered));
  return ordered;
}

export function findAgentConfig(id: string): AgentConfig | undefined {
  return listAgentConfigs().agents.find((agent) => agent.id === id);
}
