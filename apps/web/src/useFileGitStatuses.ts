import { useEffect, useState } from "react";
import { apiUrl } from "./api";

type GitLineTotals = { added: number; removed: number };

/** Polling also catches index-only changes (stage/commit), which file watchers
 * cannot see. Pause in hidden windows and never overlap requests. `totalsFor`
 * also asks for that folder's +added −removed lines against HEAD. */
export function useFileGitStatuses(directories: string[], remote?: string, totalsFor?: string | null) {
  const paths = [...new Set(directories)].sort().slice(0, 256);
  const key = JSON.stringify([remote, paths, totalsFor ?? null]);
  const [snapshot, setSnapshot] = useState<{ key: string; statuses: Record<string, string>; totals: GitLineTotals | null }>(
    { key: "", statuses: {}, totals: null });
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(false);
    const [, directories, totalsFor] = JSON.parse(key) as [string | null, string[], string | null];
    if (!directories.length) return;
    const controller = new AbortController();
    let busy = false;
    const refresh = async () => {
      if (document.hidden || busy) return;
      busy = true;
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
      }
    };
    void refresh();
    const timer = window.setInterval(refresh, 5000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      controller.abort();
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [key, remote]);
  const current = snapshot.key === key;
  return { statuses: current ? snapshot.statuses : {}, totals: current ? snapshot.totals : null, failed };
}
