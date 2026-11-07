import { useCallback, useEffect, useRef, useState } from "react";
import { apiUrl } from "./api";

type GitLineTotals = { added: number; removed: number };

/** Polling also catches index-only changes (stage/commit), which file watchers
 * cannot see. Pause in hidden windows and never overlap requests. `totalsFor`
 * also asks for that folder's +added −removed lines against HEAD. `refresh`
 * re-checks right away (a save, a watched change) instead of waiting for the poll. */
export function useFileGitStatuses(directories: string[], remote?: string, totalsFor?: string | null) {
  const paths = [...new Set(directories)].sort().slice(0, 256);
  const key = JSON.stringify([remote, paths, totalsFor ?? null]);
  const [snapshot, setSnapshot] = useState<{ key: string; statuses: Record<string, string>; totals: GitLineTotals | null }>(
    { key: "", statuses: {}, totals: null });
  const [failed, setFailed] = useState(false);
  const kick = useRef<() => void>(() => {});
  useEffect(() => {
    setFailed(false);
    const [, directories, totalsFor] = JSON.parse(key) as [string | null, string[], string | null];
    if (!directories.length) return;
    const controller = new AbortController();
    let busy = false;
    // A save or watched change asked for mid-flight runs once more after it:
    // the request in flight may have read Git before that change. Polls just
    // skip a busy request, so a slow host is never queried back to back.
    let again = false;
    let debounce: number | undefined;
    const refresh = async (queue = false) => {
      if (document.hidden) return;
      if (busy) {
        again ||= queue;
        return;
      }
      busy = true;
      again = false;
      try {
        const res = await fetch(`${apiUrl()}/api/git/file-status`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ directories, session: remote, ...(totalsFor ? { totalsFor } : {}) }),
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json() as { statuses: Record<string, string>; totals?: GitLineTotals | null };
        if (!controller.signal.aborted) {
          setFailed(false);
          setSnapshot((previous) => {
            const same = previous.key === key;
            // No `totals` means the server could not count them: keep the last ones.
            const totals = body.totals !== undefined ? body.totals : same ? previous.totals : null;
            return same && JSON.stringify(previous.statuses) === JSON.stringify(body.statuses) &&
              previous.totals?.added === totals?.added && previous.totals?.removed === totals?.removed
              ? previous : { key, statuses: body.statuses, totals };
          });
        }
      } catch {
        if (!controller.signal.aborted) setFailed(true);
      } finally {
        busy = false;
        if (again && !controller.signal.aborted) void refresh(true);
      }
    };
    // Bursts (an agent writing many files, save + watcher event) collapse into one check.
    kick.current = () => {
      window.clearTimeout(debounce);
      debounce = window.setTimeout(() => refresh(true), 150);
    };
    // Wrapped so the DOM event argument can't be mistaken for `queue`.
    const poll = () => void refresh();
    poll();
    const timer = window.setInterval(poll, 5000);
    window.addEventListener("focus", poll);
    document.addEventListener("visibilitychange", poll);
    return () => {
      controller.abort();
      kick.current = () => {};
      window.clearTimeout(debounce);
      window.clearInterval(timer);
      window.removeEventListener("focus", poll);
      document.removeEventListener("visibilitychange", poll);
    };
  }, [key, remote]);
  const refresh = useCallback(() => kick.current(), []);
  const current = snapshot.key === key;
  return { statuses: current ? snapshot.statuses : {}, totals: current ? snapshot.totals : null, failed, refresh };
}
