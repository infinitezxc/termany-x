import { getLanguage, translate } from "./i18n";

export type SessionOpenMode = "switch" | "new";
/**
 * "switch" replaces the picker's pane, unless that pane is running an agent
 * outside tmux: replacing it would end the agent, so it opens beside instead.
 */
export function sessionOpenAction(mode: SessionOpenMode, hasCurrentPane: boolean, currentPaneBusy = false) {
  if (mode === "switch" && hasCurrentPane && !currentPaneBusy) return "replace";
  return "create";
}

/** Wait for the old connection to be released before reusing its backend ID. */
export async function replaceAfterRelease(options: {
  release: () => Promise<boolean>;
  isCurrent: () => boolean;
  replace: () => void;
  restore: () => void;
}) {
  if (!await options.release()) {
    if (options.isCurrent()) options.restore();
    throw new Error(translate(getLanguage(), "sessions.error.release"));
  }
  if (!options.isCurrent()) throw new Error(translate(getLanguage(), "sessions.error.paneChanged"));
  options.replace();
}

/** Layout synchronization can clone a pane without changing its terminal. */
export function sameTerminal(
  a: { id: string; terminalRevision?: number; sshTarget?: string; tmuxSession?: string; view?: string },
  b: typeof a | undefined,
): boolean {
  return !!b && a.id === b.id && (a.terminalRevision ?? 0) === (b.terminalRevision ?? 0)
    && a.sshTarget === b.sshTarget && a.tmuxSession === b.tmuxSession && a.view === b.view;
}

/**
 * Where a pane goes when its SSH command ends on its own: a finished tmux
 * attachment returns to a shell on the same host, a plain SSH shell returns to
 * the local one, and an exit from a terminal already replaced is ignored.
 */
export type SshExitAction =
  | { kind: "ignore" }
  | { kind: "local" }
  | { kind: "host"; destination: { title: string; sshTarget?: string; sshLabel?: string } };
export function sshExitAction(
  pane: { sshTarget?: string; sshLabel?: string; tmuxSession?: string } | undefined,
  exit: { sshTarget?: string; tmuxSession?: string },
): SshExitAction {
  if (!pane || pane.sshTarget !== exit.sshTarget || pane.tmuxSession !== exit.tmuxSession) return { kind: "ignore" };
  if (!exit.tmuxSession) return { kind: "local" };
  return { kind: "host", destination: { title: pane.sshLabel || exit.sshTarget || "Terminal", sshTarget: exit.sshTarget, sshLabel: pane.sshLabel } };
}
