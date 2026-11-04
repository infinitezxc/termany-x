import { useCallback, useEffect, useRef, useState } from "react";
import { listRemoteSessions, type RemoteSession } from "./tmuxClient";

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The picker's actions run one at a time; the last one's failure is shown until the next starts. */
export function useSessionAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const running = useRef(false);
  const run = useCallback(async (task: () => Promise<void>) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError("");
    try {
      await task();
    } catch (e) {
      setError(errorText(e));
    } finally {
      running.current = false;
      setBusy(false);
    }
  }, []);
  return { busy, error, run };
}
export type SessionAction = ReturnType<typeof useSessionAction>;

/**
 * The tmux sessions on an SSH pane's host, loaded when `session` (that pane's
 * terminal session) is set. A load that fails, e.g. without tmux on the host,
 * keeps its error; `reload` throws instead, for the action that called it.
 */
export function useRemoteSessions(session: string | undefined) {
  const [sessions, setSessions] = useState<RemoteSession[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!session) return;
    // A result that arrives after the picker moved on is ignored.
    let live = true;
    setLoading(true);
    setError("");
    listRemoteSessions(session)
      .then((items) => live && setSessions(items), (e) => live && setError(errorText(e)))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [session]);
  const reload = useCallback(async () => {
    if (!session) return;
    setSessions(await listRemoteSessions(session));
    setError("");
  }, [session]);
  return { sessions, loading, error, reload };
}
export type RemoteSessionList = ReturnType<typeof useRemoteSessions>;
