/**
 * The two rules that make several windows over one shared layout behave.
 *
 * Both exist because PAGES are exclusive — a page is open in at most one window
 * at a time (see windows.ts) — which is what lets `mergeLayout` settle a
 * conflict without a revision number or a timestamp: for the page a window
 * owns, that window is the only writer, so its copy always wins. Everything
 * else in the snapshot comes from the sender.
 *
 * Kept free of runtime imports so they can be exercised directly.
 */
import type { Pane, TreeNode, Workspace } from "./store";

/** Just enough of the store for `stepWorkspace` — see store.ts for the rest. */
interface WorkspaceCursor {
  workspaces: { id: string }[];
  activeWorkspace: string;
}

function findIn(nodes: TreeNode[], id: string): TreeNode | undefined {
  for (const node of nodes) {
    if (node.id === id) return node;
    const hit = findIn(node.children, id);
    if (hit) return hit;
  }
  return undefined;
}

function replaceIn(nodes: TreeNode[], id: string, next: TreeNode): TreeNode[] {
  return nodes.map((node) =>
    node.id === id ? next : { ...node, children: replaceIn(node.children, id, next) }
  );
}

/**
 * Fold another window's snapshot into ours, keeping our copy of the one page we
 * own. Its subtree is grafted back over the sender's, by id and in place.
 *
 * Taking the snapshot wholesale would instead undo whatever we hadn't saved
 * yet: saves are debounced, and an agent streaming into a pane rewrites the
 * layout continuously, so there are always a few hundred ms of local changes
 * that no snapshot from another window can know about.
 */
export function mergeLayout(
  local: Workspace[],
  remote: Workspace[],
  ownPageId: string
): Workspace[] {
  if (!ownPageId) return remote;

  const home = local.find((ws) => findIn(ws.roots, ownPageId));
  const ownPage = home && findIn(home.roots, ownPageId);
  if (!home || !ownPage) return remote;

  const merged = remote.map((ws) => {
    if (ws.id !== home.id) return ws;
    // The sender knows the page: overwrite just that subtree with ours.
    if (findIn(ws.roots, ownPageId)) {
      return { ...ws, roots: replaceIn(ws.roots, ownPageId, ownPage) };
    }
    // It doesn't — so the sender is provably behind us (we just created the
    // page, or it's still unsaved). Our tree already holds everything we
    // merged from them earlier plus that page, in the right place, so keep it.
    return home;
  });

  // The whole workspace is new here too.
  return merged.some((ws) => ws.id === home.id) ? merged : [...merged, home];
}

/** True when `pageId` appears anywhere in `workspaces`. */
export function layoutHasPage(workspaces: Workspace[], pageId: string): boolean {
  return workspaces.some((ws) => !!findIn(ws.roots, pageId));
}

/**
 * The workspace `dir` steps away, wrapping around. Workspaces are shared, so
 * unlike pages there is nothing to skip — every window may open any of them.
 */
export function stepWorkspace(s: WorkspaceCursor, dir: 1 | -1): string {
  const len = s.workspaces.length;
  if (!len) return s.activeWorkspace;
  const start = s.workspaces.findIndex((w) => w.id === s.activeWorkspace);
  return s.workspaces[(((start + dir) % len) + len) % len].id;
}

/** Older layouts may still contain conversation panes; reopen them as terminals. */
export function restoreTerminalViews(workspaces: Workspace[]): Workspace[] {
  const pane = (value: Pane): Pane => value.kind === "split"
    ? { ...value, children: value.children.map(pane) }
    : (value.view as string) === "agent" ? { ...value, view: "terminal" } : value;
  const nodes = (values: TreeNode[]): TreeNode[] => values.map((node) => ({
    ...node,
    htabs: node.htabs.map((tab) => ({ ...tab, layout: pane(tab.layout) })),
    children: nodes(node.children),
  }));
  return workspaces.map((workspace) => ({ ...workspace, roots: nodes(workspace.roots) }));
}
