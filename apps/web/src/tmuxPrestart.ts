import { isDemo } from "./demo";
import { isTauri } from "./env";
import { cwdCandidates, useStore } from "./state/store";
import { takenPages, windowKey } from "./state/windows";
import { measuredCellSize, prestartSession } from "./terminal/manager";
import { tmuxPrestartTargets } from "./tmuxPrestartTargets";

const STAGGER_MS = 200;
const MEASURE_TRIES = 20;
const MEASURE_INTERVAL_MS = 150;

const wait = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

/**
 * Attach every tmux pane of the restored layout at launch rather than when
 * its tab is first shown. Panes created later mount (and connect) on their
 * own. Only one window does this: pages are owned by one window at a time,
 * and a second window warming the same panes would fight it for them.
 */
export async function prestartTmuxPanes() {
  if (isDemo || (isTauri && windowKey !== "main")) return;
  // Size hidden panes from the visible ones' character cell, once they render.
  let cell = measuredCellSize();
  for (let i = 0; !cell && i < MEASURE_TRIES; i++) {
    await wait(MEASURE_INTERVAL_MS);
    cell = measuredCellSize();
  }
  const area = document.querySelector(".pane-card")?.getBoundingClientRect();
  const skip = await takenPages();
  const state = useStore.getState();
  for (const target of tmuxPrestartTargets(state.workspaces, skip)) {
    const size = cell && area && area.width > 0
      ? {
          cols: Math.floor((area.width * target.width) / cell.width) - 1,
          // One row for the pane header.
          rows: Math.floor((area.height * target.height) / cell.height) - 2,
        }
      : undefined;
    // The layout may have changed while waiting; skip panes that are gone.
    const latest = useStore.getState();
    if (!tmuxPrestartTargets(latest.workspaces, skip).some((t) => t.paneId === target.paneId)) continue;
    prestartSession(target.paneId, {
      sshTarget: target.sshTarget,
      tmuxSession: target.tmuxSession,
      cwdFrom: cwdCandidates(latest, target.paneId),
      size,
    });
    await wait(STAGGER_MS);
  }
}
