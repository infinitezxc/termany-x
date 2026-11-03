import { getLanguage, translate } from "./i18n";
import { replaceAfterRelease, sameTerminal, sessionOpenAction, sshExitAction, type SessionOpenMode } from "./sessionOpenPolicy";
import { useStore, type Pane, type PaneLocation } from "./state/store";
import { disposePaneSessions } from "./terminal/manager";

type Leaf = Extract<Pane, { kind: "leaf" }>;

/** Every leaf pane in every workspace, with where it lives. */
export function sessionPanes() {
  const result: { leaf: Leaf; location: PaneLocation }[] = [];
  const visit = (p: Pane, loc: Omit<PaneLocation, "paneId">) => {
    if (p.kind === "leaf") result.push({ leaf: p, location: { ...loc, paneId: p.id } });
    else p.children.forEach(c => visit(c, loc));
  };
  for (const ws of useStore.getState().workspaces) {
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

export type SessionDestination = {
  title: string; sshTarget?: string; sshLabel?: string; tmuxSession?: string;
  agentSession?: { agent: string; sessionId: string };
};

/**
 * Show a destination terminal: "switch" replaces the source pane once its old
 * connection is released, "new" splits a pane next to it.
 */
export async function openSessionPane(options: {
  mode: SessionOpenMode; sourcePaneId?: string; destination: SessionDestination;
}): Promise<string> {
  const { mode, sourcePaneId, destination } = options;
  const store = useStore.getState();
  const before = findSessionPane(sourcePaneId);
  if (sourcePaneId && !before) throw new Error(translate(getLanguage(), "sessions.error.sourceClosed"));
  if (sessionOpenAction(mode, !!before) === "replace" && before) {
    // Already attached to this tmux session: just show it.
    if (before.sshTarget === destination.sshTarget && before.tmuxSession && before.tmuxSession === destination.tmuxSession) {
      store.setPaneView(before.id, "terminal");
      return before.id;
    }
    await replaceAfterRelease({
      release: () => disposePaneSessions(before.id),
      isCurrent: () => sameTerminal(before, findSessionPane(before.id)),
      replace: () => store.replacePaneSession(before.id, destination),
      restore: () => store.replacePaneSession(before.id, before),
    });
    return before.id;
  }
  const id = store.addPane("terminal", destination.title, sourcePaneId, destination);
  if (!id) throw new Error(translate(getLanguage(), "tmux.noRoom"));
  if (destination.agentSession) store.setPaneAgentSession(id, destination.agentSession);
  return id;
}

/** Finishing an agent releases its tmux attachment and opens a fresh host shell. */
export async function handleSshNaturalExit(paneId: string, exit: { sshTarget: string; tmuxSession?: string }) {
  const action = sshExitAction(findSessionPane(paneId), exit);
  if (action.kind === "local") useStore.getState().setPaneSshTarget(paneId);
  else if (action.kind === "host") await openSessionPane({ mode: "switch", sourcePaneId: paneId, destination: action.destination });
}
