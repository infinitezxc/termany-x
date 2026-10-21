import { apiPath } from "../api";
import { isDemo } from "../demo";

/** The server owns terminal history; quitting only requests an acknowledged save. */
export async function flushTerminalHistory(): Promise<void> {
  if (isDemo) return;
  const res = await fetch(apiPath("/api/scroll/flush"), {
    method: "POST",
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`Unable to save terminal history (${res.status})`);
}

/** Best-effort flush when a browser tab goes away; periodic saves run server-side. */
export function startScrollSync(): void {
  if (isDemo) return;
  const flush = () => {
    navigator.sendBeacon?.(apiPath("/api/scroll/flush"));
  };
  window.addEventListener("pagehide", flush);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush();
  });
}
