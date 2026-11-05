import type { Pane, TreeNode, Workspace } from "./state/store";

export type TmuxPrestartTarget = {
  paneId: string;
  sshTarget: string;
  tmuxSession: string;
  /** The pane's share of its tab's pane area. */
  width: number;
  height: number;
};

/** Each leaf's fraction of the tab area, following split sizes. */
function leafShares(pane: Pane, width: number, height: number, out: Map<string, { width: number; height: number }>) {
  if (pane.kind === "leaf") {
    out.set(pane.id, { width, height });
    return;
  }
  const n = pane.children.length;
  pane.children.forEach((child, i) => {
    const share = pane.sizes?.[i] ?? 1 / n;
    if (pane.dir === "row") leafShares(child, width * share, height, out);
    else leafShares(child, width, height * share, out);
  });
}

function flatten(nodes: TreeNode[]): TreeNode[] {
  return nodes.flatMap((n) => [n, ...flatten(n.children)]);
}

/** Every tmux terminal pane in the layout, except those on `skipPages`. */
export function tmuxPrestartTargets(workspaces: Workspace[], skipPages: Set<string>): TmuxPrestartTarget[] {
  const targets: TmuxPrestartTarget[] = [];
  for (const ws of workspaces) {
    for (const page of flatten(ws.roots)) {
      if (skipPages.has(page.id)) continue;
      for (const tab of page.htabs) {
        const shares = new Map<string, { width: number; height: number }>();
        leafShares(tab.layout, 1, 1, shares);
        const visit = (pane: Pane) => {
          if (pane.kind === "split") return pane.children.forEach(visit);
          if ((pane.view ?? "terminal") !== "terminal" || !pane.sshTarget || !pane.tmuxSession) return;
          const share = tab.maximized === pane.id ? { width: 1, height: 1 } : shares.get(pane.id)!;
          targets.push({ paneId: pane.id, sshTarget: pane.sshTarget, tmuxSession: pane.tmuxSession, ...share });
        };
        visit(tab.layout);
      }
    }
  }
  return targets;
}
