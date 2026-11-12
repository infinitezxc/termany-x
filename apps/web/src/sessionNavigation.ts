import { getLanguage, translate } from "./i18n";
import { replaceAfterRelease, sameTerminal, sessionOpenAction, sshExitAction, type SessionOpenMode } from "./sessionOpenPolicy";
import { useStore, type Pane, type PaneLocation, type TreeNode } from "./state/store";
import { activeAgentKind, disposePaneSessions } from "./terminal/manager";

type Leaf = Extract<Pane, { kind: "leaf" }>;

/** Every leaf pane in every workspace, with where it lives. */
export function sessionPanes(workspaces = useStore.getState().workspaces) {
  const result: { leaf: Leaf; location: PaneLocation }[] = [];
  const visit = (p: Pane, loc: Omit<PaneLocation, "paneId">) => {
    if (p.kind === "leaf") result.push({ leaf: p, location: { ...loc, paneId: p.id } });
    else p.children.forEach(c => visit(c, loc));
  };
  for (const ws of workspaces) {
    const stack = [...ws.roots];
    while (stack.length) {
      const node = stack.pop()!;
      node.htabs.forEach(tab => visit(tab.layout, { workspaceId: ws.id, nodeId: node.id, tabId: tab.id }));
      stack.push(...node.children);
    }
  }
  return result;
}
export const findSessionPane = (paneId: string | undefined): Leaf | undefined =>
  paneId ? sessionPanes().find(p => p.leaf.id === paneId)?.leaf : undefined;
/** The title of the page a pane is on. */
export function pageTitleOf(paneId: string | undefined): string | undefined {
  if (!paneId) return undefined;
  const nodeId = sessionPanes().find(p => p.leaf.id === paneId)?.location.nodeId;
  const search = (nodes: TreeNode[]): TreeNode | undefined => {
    for (const n of nodes) { if (n.id === nodeId) return n; const hit = search(n.children); if (hit) return hit; }
    return undefined;
  };
  for (const ws of useStore.getState().workspaces) { const hit = nodeId && search(ws.roots); if (hit) return hit.title; }
  return undefined;
}

/** Bring an existing pane forward. */
export function showPane(location: PaneLocation) {
  const store = useStore.getState();
  store.jumpToResult(location);
  store.setPaneView(location.paneId, "terminal");
}

/** The pane already attached to a host's tmux session, if any. */
export const findTmuxPane = (sshTarget: string | undefined, tmuxSession: string): PaneLocation | undefined =>
  sessionPanes().find(p => p.leaf.sshTarget === sshTarget && p.leaf.tmuxSession === tmuxSession)?.location;

/** Whether replacing a pane would end an agent: tmux keeps its agents running on detach. */
const runsAgent = (leaf: Leaf) =>
  (leaf.view ?? "terminal") === "terminal" && !leaf.tmuxSession && !!activeAgentKind(leaf.id);

/**
 * Whether a pane shows a running agent, in tmux or not; a new agent opens
 * beside it rather than in its place. `tmuxSessions` names the agent each of
 * the host's tmux sessions was started for.
 */
export function showsAgent(paneId: string | undefined, tmuxSessions: ReadonlyArray<{ name: string; agent?: string }> = []) {
  const leaf = findSessionPane(paneId);
  if (!leaf || (leaf.view ?? "terminal") !== "terminal") return false;
  if (activeAgentKind(leaf.id)) return true;
  return !!leaf.tmuxSession && !!tmuxSessions.find(s => s.name === leaf.tmuxSession)?.agent;
}

export type SessionDestination = {
  title: string; sshTarget?: string; sshLabel?: string; tmuxSession?: string;
  agentSession?: { agent: string; sessionId: string };
};

/**
 * Show a destination terminal: "switch" replaces the source pane once its old
 * connection is released, "new" splits a pane next to it. A tmux session
 * already open in a pane is shown there instead of being attached twice.
 */
export async function openSessionPane(options: {
  mode: SessionOpenMode; sourcePaneId?: string; destination: SessionDestination;
}): Promise<string> {
  const { mode, sourcePaneId, destination } = options;
  const store = useStore.getState();
  const shown = destination.tmuxSession
    ? findTmuxPane(destination.sshTarget, destination.tmuxSession)
    : undefined;
  if (shown) {
    showPane(shown);
    return shown.paneId;
  }
  const before = findSessionPane(sourcePaneId);
  if (sourcePaneId && !before) throw new Error(translate(getLanguage(), "sessions.error.sourceClosed"));
  if (sessionOpenAction(mode, !!before, !!before && runsAgent(before)) === "replace" && before) {
    await replaceAfterRelease({
      release: () => disposePaneSessions(before.id),
      isCurrent: () => sameTerminal(before, findSessionPane(before.id)),
      replace: () => store.replacePaneSession(before.id, destination),
      restore: () => store.replacePaneSession(before.id, before),
    });
    return before.id;
  }
  // The destination names its host; without one it is this machine.
  const id = store.addPane("terminal", destination.title, sourcePaneId, { ...destination, local: !destination.sshTarget });
  if (!id) throw new Error(translate(getLanguage(), "tmux.noRoom"));
  return id;
}

/** Finishing an agent releases its tmux attachment and opens a fresh host shell. */
export async function handleSshNaturalExit(paneId: string, exit: { sshTarget?: string; tmuxSession?: string }) {
  const action = sshExitAction(findSessionPane(paneId), exit);
  if (action.kind === "local") useStore.getState().setPaneSshTarget(paneId);
  else if (action.kind === "host") await openSessionPane({ mode: "switch", sourcePaneId: paneId, destination: action.destination });
}
