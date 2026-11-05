import { useCallback, useEffect, useSyncExternalStore } from "react";
import { useStore } from "./state/store";
import { agentActivitySnapshot, paneActivityId, subscribeAgentActivity, terminalSessionId } from "./terminal/manager";
import { listRemoteSessions } from "./tmuxClient";

/** Fallback refresh, for a title written while the agent's status didn't change. */
const POLL_MS = 60_000;
/** Activity can flip several times a second; one listing covers a burst. */
const SETTLE_MS = 3_000;

/**
 * Keep a tmux agent pane's title in step with its conversation. A new session
 * opens as "Claude Code session"; once the agent names the conversation (or the
 * first prompt is in), the host's tmux listing carries it and the pane takes it.
 * Checked after the agent's activity changes, and now and then besides.
 */
export function usePaneSessionTitle(paneId: string, sshTarget: string | undefined, tmuxSession: string | undefined) {
  const activityId = paneActivityId(paneId, sshTarget);
  const activity = useSyncExternalStore(subscribeAgentActivity, () => agentActivitySnapshot([activityId]));
  const refresh = useCallback(async (isCurrent: () => boolean) => {
    if (!sshTarget || !tmuxSession) return;
    const sessions = await listRemoteSessions(terminalSessionId(paneId, sshTarget)).catch(() => []);
    const s = sessions.find(s => s.name === tmuxSession);
    const title = s?.title || s?.preview;
    // The pane may have switched sessions meanwhile; the store checks.
    if (isCurrent() && title) useStore.getState().setSessionPaneTitle(paneId, { sshTarget, tmuxSession }, title);
  }, [paneId, sshTarget, tmuxSession]);
  useEffect(() => {
    let live = true;
    const settle = setTimeout(() => void refresh(() => live), SETTLE_MS);
    return () => { live = false; clearTimeout(settle); };
  }, [refresh, activity]);
  useEffect(() => {
    let live = true;
    const poll = setInterval(() => void refresh(() => live), POLL_MS);
    return () => { live = false; clearInterval(poll); };
  }, [refresh]);
}
