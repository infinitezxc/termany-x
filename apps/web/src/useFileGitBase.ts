import { useEffect, useState } from "react";
import { apiUrl } from "./api";

/** Refresh HEAD even when a commit changes no working-tree file timestamps. */
export function useFileGitBase(path: string, enabled: boolean, remote?: string, loadedAt?: number) {
  const [snapshot, setSnapshot] = useState<{ path: string; remote?: string; content: string | null }>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    setFailed(false);
    const controller = new AbortController();
    let busy = false;
    const refresh = async () => {
      if (busy || document.hidden) return;
      busy = true;
      try {
        const params = new URLSearchParams({ path });
        if (remote) params.set("session", remote);
        const res = await fetch(`${apiUrl()}/api/git/file-base?${params}`, { signal: controller.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json() as { content: string | null };
        if (!controller.signal.aborted) {
          setFailed(false);
          setSnapshot((prev) => prev?.path === path && prev.remote === remote && prev.content === body.content
            ? prev : { path, remote, content: body.content });
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
  }, [path, enabled, remote, loadedAt]);
  return { content: snapshot?.path === path && snapshot.remote === remote ? snapshot.content : null, failed };
}
