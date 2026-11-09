import { SESSION_AGENTS, type SessionAgent } from "./tmuxClient";

const STORAGE_KEY = "termany.session-agent-order";
const KNOWN = SESSION_AGENTS.map((a) => a.id);

/** Known agents in the saved order; unknown ids drop out, missing ones keep their default place at the end. */
export function normalizeSessionAgentOrder(value: unknown): SessionAgent[] {
  const saved = Array.isArray(value) ? value.filter((id): id is SessionAgent => KNOWN.includes(id)) : [];
  const unique = [...new Set(saved)];
  return [...unique, ...KNOWN.filter((id) => !unique.includes(id))];
}

/** `order` with `moved` placed where `target` is, the agents between shifting over. */
export function moveSessionAgent(order: readonly SessionAgent[], moved: SessionAgent, target: SessionAgent): SessionAgent[] {
  const from = order.indexOf(moved), to = order.indexOf(target);
  if (from < 0 || to < 0 || from === to) return [...order];
  const next = order.filter((id) => id !== moved);
  next.splice(to, 0, moved);
  return next;
}

export function loadSessionAgentOrder(): SessionAgent[] {
  try {
    return normalizeSessionAgentOrder(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null"));
  } catch {
    return [...KNOWN];
  }
}

export function saveSessionAgentOrder(order: readonly SessionAgent[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(order));
  } catch {
    /* localStorage may be blocked; the in-memory order still applies. */
  }
}
