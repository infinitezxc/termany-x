import type { AgentConfig } from "./agentConfig.js";
import { resolveExecutable } from "./shellPath.js";

export type AgentDetection = {
  id?: string;
  command: string;
  installed: boolean;
  path?: string;
  error?: string;
  terminalInstalled?: boolean;
  terminalPath?: string;
};

/** Ignore retired conversation settings in older clients' saved registries. */
export function parseAgentDetectionInput(input: unknown): AgentConfig | undefined {
  if (!input || typeof input !== "object") return undefined;
  const value = input as Record<string, unknown>;
  const id = String(value.id ?? "").trim();
  if (!id) return undefined;
  return {
    id,
    name: String(value.name ?? "").trim() || id,
    command: String(value.command ?? "").trim(),
    args: String(value.args ?? "").trim(),
    enabled: value.enabled !== false,
    builtIn: value.builtIn === true,
  };
}

function firstShellToken(input: string): string {
  const trimmed = input.trim();
  const match = /^"([^"]+)"|^'([^']+)'|^(\S+)/.exec(trimmed);
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? "";
}

async function resolvedDetection(
  command: string,
  id?: string
): Promise<AgentDetection> {
  const executable = firstShellToken(command);
  if (!executable) return { id, command, installed: false };
  const found = await resolveExecutable(executable);
  return found
    ? { id, command, installed: true, path: found }
    : { id, command, installed: false };
}

/** Detect the interactive CLI used by terminal panes. */
export async function detectAgentExecutable(agent: AgentConfig): Promise<AgentDetection> {
  const terminal = await resolvedDetection(agent.command, agent.id);
  return {
    ...terminal,
    terminalInstalled: terminal.installed,
    ...(terminal.path ? { terminalPath: terminal.path } : {}),
  };
}

export function detectCommandExecutable(command: string): Promise<AgentDetection> {
  return resolvedDetection(command);
}
