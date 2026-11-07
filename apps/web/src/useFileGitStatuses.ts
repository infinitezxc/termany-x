import { useEffect, useState } from "react";
import { apiUrl } from "./api";

/** Polling also catches index-only changes (stage/commit), which file watchers
 * cannot see. Pause in hidden windows and never overlap requests. */
export function useFileGitStatuses(directories: string[], remote?: string) {
  const paths = [...new Set(directories)].sort().slice(0, 256);
  const key = JSON.stringify([remote, paths]);
  const [snapshot, setSnapshot] = useState<{ key: string; statuses: Record<string, string> }>({ key: "", statuses: {} });
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(false);
    const [, directories] = JSON.parse(key) as [string | null, string[]];
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
          body: JSON.stringify({ directories, session: remote }),
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json() as { statuses: Record<string, string> };
        if (!controller.signal.aborted) {
          setFailed(false);
          setSnapshot((previous) => previous.key === key && JSON.stringify(previous.statuses) === JSON.stringify(body.statuses)
            ? previous : { key, statuses: body.statuses });
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
  return { statuses: snapshot.key === key ? snapshot.statuses : {}, failed };
}
