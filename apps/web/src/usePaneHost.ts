import { useMemo } from "react";
import { paneHost, useStore, type PaneHost } from "./state/store";

/**
 * paneHost for a mounted pane, as a value that only changes when the host
 * does — safe to use as an effect dependency.
 */
export function usePaneHost(paneId: string): PaneHost {
  const kind = useStore((s) => paneHost(s, paneId).kind);
  const label = useStore((s) => {
    const host = paneHost(s, paneId);
    return host.kind === "local" ? "" : host.label;
  });
  const session = useStore((s) => {
    const host = paneHost(s, paneId);
    return host.kind === "ssh" ? host.session : "";
  });
  return useMemo<PaneHost>(
    () => (kind === "ssh" ? { kind, label, session } : kind === "closed" ? { kind, label } : { kind: "local" }),
    [kind, label, session],
  );
}
