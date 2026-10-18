import { useI18n } from "../i18n";
import type { RailItemId } from "../rail-config";
import { withShortcut } from "../keybindings";
import { activeHtab, useStore, type PaneView } from "../state/store";
import {
  ActivityIcon,
  ChartIcon,
  FilesIcon,
  GearIcon,
  GitBranchIcon,
  HistoryIcon,
  TerminalIcon,
} from "./icons";

/** One entry per pane kind this rail can quick-create. */
const RAIL_ITEMS: Array<{ view: RailItemId; icon: () => JSX.Element }> = [
  { view: "terminal", icon: TerminalIcon },
  { view: "files", icon: FilesIcon },
  { view: "git", icon: GitBranchIcon },
  { view: "history", icon: HistoryIcon },
  { view: "usage", icon: ChartIcon },
  { view: "monitor", icon: ActivityIcon },
];

/**
 * Workspace-level quick-action rail, sitting beside the pane card (like the
 * left sidebar's page tree, but for panes). Not tied to any one pane — each
 * button splits the currently focused pane and opens a fresh one directly in
 * that view, instead of switching an existing pane's view in place (that's
 * still the per-pane header button, toggled via togglePaneView). The settings
 * button is pinned to the bottom (margin-top: auto) so it stays reachable
 * regardless of how many quick-create buttons sit above it.
 */
export function SideRail({ onOpenSettings }: { onOpenSettings: () => void }) {
  const addPane = useStore((s) => s.addPane);
  const setPaneView = useStore((s) => s.setPaneView);
  const railVisibility = useStore((s) => s.railVisibility);
  const { t } = useI18n();

  const openPane = (view: PaneView) => {
    const paneId = addPane(view, undefined, undefined, { inheritSsh: true });
    if (paneId) return;
    const focused = activeHtab(useStore.getState())?.focused;
    if (focused) setPaneView(focused, view);
  };

  return (
    <div className="side-rail">
      {RAIL_ITEMS.filter(({ view }) => railVisibility[view]).map(({ view, icon: Icon }) => (
        <button key={view} className="side-rail-btn" title={t("rail.newPane", { view: t(`pane.view.${view}`) })} onClick={() => openPane(view)}>
          <Icon />
        </button>
      ))}
      <button
        className="side-rail-btn side-rail-settings"
        title={withShortcut(t("workspace.settings"), "openSettings")}
        onClick={onOpenSettings}
      >
        <GearIcon />
      </button>
    </div>
  );
}
