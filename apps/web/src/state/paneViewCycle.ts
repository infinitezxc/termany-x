import type { RailVisibility } from "../rail-config";
import type { Pane, PaneView } from "./store";

/** Order the togglePaneView shortcut cycles through. */
export const CYCLABLE_PANE_VIEWS = [
  "terminal",
  "files",
  "git",
  "web",
  "monitor",
  "providers",
  "history",
  "usage",
] as const satisfies readonly PaneView[];

/** Next visible view. A hidden current view enters at the first visible one. */
export function nextCyclablePaneView(
  view?: PaneView,
  visibility?: RailVisibility,
): PaneView | null {
  const views = visibility
    ? CYCLABLE_PANE_VIEWS.filter((candidate) => visibility[candidate])
    : [...CYCLABLE_PANE_VIEWS];
  if (views.length === 0) return null;
  const current = view ?? "terminal";
  const index = views.findIndex((candidate) => candidate === current);
  if (index < 0) return views[0];
  return views[(index + 1) % views.length];
}

/** Capture an inherited SSH host before changing the view to a terminal. */
export function paneWithView(
  pane: Extract<Pane, { kind: "leaf" }>,
  view: PaneView,
  ssh?: { sshTarget: string; sshLabel?: string },
): Extract<Pane, { kind: "leaf" }> {
  return { ...pane, ...(view === "terminal" ? ssh : undefined), view };
}
