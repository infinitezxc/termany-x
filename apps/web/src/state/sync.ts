import { apiPath } from "../api";
import { demoState, isDemo } from "../demo";
import { layoutHasPage, mergeLayout, restoreTerminalViews } from "./layoutMerge";
import { activePageId, useStore, type UserProfile, type Workspace } from "./store";
import { onTakenPagesChange, readWindowPref, takenPages, writeWindowPref } from "./windows";

/**
 * True once the server has answered a state load. Saves are gated on this:
 * if we never managed to load, persisting would OVERWRITE the user's real
 * layout in SQLite with this webview's in-memory defaults.
 */
let hydrated = false;

/**
 * Identifies this webview's saves on the shared state stream so it can skip
 * the echo of its own writes. Per webview, not per user — a second window is a
 * different client even though both speak for the same person.
 */
const clientId = crypto.randomUUID();

/**
 * Set while a snapshot from another window is being written into the store, so
 * the save subscription below can tell "someone else changed this" from "the
 * user changed this" — without it, every window would save what it just
 * received and the two would echo each other forever.
 */
let applyingRemote = false;

/**
 * Wait for the local server to answer. The bundled server boots in parallel
 * with the webview and usually loses that race by a few hundred ms — without
 * this, startup hydrates from a dead socket and renders the default layout.
 */
export async function waitForServer(timeoutMs = 12_000): Promise<boolean> {
  if (isDemo) return true; // no server to wait for
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(apiPath("/api/state"), { signal: AbortSignal.timeout(1000) });
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

/**
 * Settle where THIS window is looking and take ownership of the page it lands
 * on. The workspace is whichever this window had last, falling back to the
 * shared "last used" for a window that has never run — several windows in one
 * workspace is fine and expected. Which PAGE of it is then `setActiveWorkspace`'s
 * job: it skips any page another window is showing, and opens a fresh one when
 * they're all spoken for.
 */
async function adoptView(sharedActive: string): Promise<void> {
  useStore.getState().setTakenPages(await takenPages());

  const { workspaces } = useStore.getState();
  const exists = (id: string | null) => !!id && workspaces.some((w) => w.id === id);
  const remembered = readWindowPref("activeNodes");
  if (remembered) {
    try {
      useStore.setState({ activeNodes: JSON.parse(remembered) });
    } catch {
      /* malformed — the window just forgets which pages it was on */
    }
  }

  const wsId =
    [readWindowPref("activeWorkspace"), sharedActive].find(exists) ??
    workspaces[0]?.id ??
    useStore.getState().activeWorkspace;
  useStore.getState().setActiveWorkspace(wsId);
}

/**
 * The webview is a reflection of server state now (SQLite), not the source of
 * truth. Hydrate the store from the server on startup; fall back to a one-time
 * import of the old localStorage blob so existing layouts aren't lost.
 */
export async function loadState(): Promise<void> {
  if (isDemo) {
    // Curated layout; `hydrated` stays false so nothing is ever persisted.
    useStore.setState({ ...demoState(), sidebarCollapsed: false });
    return;
  }

  // The sidebar is per-window now; the shared value is only a seed for a window
  // that has never recorded its own, so upgrading users keep what they had.
  const seedSidebar = (shared: unknown) => {
    if (readWindowPref("sidebarCollapsed") === null) {
      useStore.setState({ sidebarCollapsed: !!shared });
    }
  };

  // Layouts written before pages became per-window carry `activeNode` inside
  // each workspace. Seed this window from it once so an upgrade opens on the
  // page the user left off on, then let the per-window record take over.
  const seedPages = (workspaces: (Workspace & { activeNode?: string })[]) => {
    if (readWindowPref("activeNodes") !== null) return;
    const seeded: Record<string, string> = {};
    for (const ws of workspaces) if (ws.activeNode) seeded[ws.id] = ws.activeNode;
    useStore.setState({ activeNodes: seeded });
  };

  // Where this window ends up is settled once, at the end, so every path
  // through here — server, legacy blob, or the built-in default layout — claims
  // the page it opens. A window that skipped the claim would be invisible to
  // the others and could end up sharing a page with one of them.
  let sharedActive = "";

  try {
    const res = await fetch(apiPath("/api/state"));
    if (res.ok) {
      hydrated = true; // an empty-but-ok answer is a genuine fresh install
      const s = await res.json();
      if (typeof s.activeWorkspace === "string") sharedActive = s.activeWorkspace;
      if (s.userProfile && typeof s.userProfile === "object" && typeof s.userProfile.nickname === "string") {
        useStore.setState({ userProfile: s.userProfile });
      }
      if (Array.isArray(s.workspaces) && s.workspaces.length) {
        useStore.setState({ workspaces: restoreTerminalViews(s.workspaces) });
        seedSidebar(s.sidebarCollapsed);
        seedPages(s.workspaces);
        await adoptView(sharedActive);
        return;
      }
    }
  } catch {
    /* server unreachable — keep the in-memory defaults */
  }

  // Migrate a previous localStorage layout (old zustand-persist blob) if any.
  try {
    const ls = localStorage.getItem("termany.workspaces");
    if (ls) {
      const parsed = JSON.parse(ls);
      const st = parsed?.state ?? parsed;
      if (Array.isArray(st?.workspaces) && st.workspaces.length) {
        useStore.setState({ workspaces: restoreTerminalViews(st.workspaces) });
        seedSidebar(st.sidebarCollapsed);
        seedPages(st.workspaces);
        if (typeof st.activeWorkspace === "string") sharedActive = st.activeWorkspace;
      }
      localStorage.removeItem("termany.workspaces");
    }
  } catch {
    /* ignore a malformed legacy blob */
  }

  await adoptView(sharedActive);
}

let timer: ReturnType<typeof setTimeout> | undefined;

/** Debounced whole-layout save. Assigned by `startStateSync`. */
let scheduleSave: () => void = () => {};

/**
 * Write another window's snapshot into this one. Only the layout crosses over:
 * which workspace and page this window shows, and whether its sidebar is open,
 * belong to this window alone.
 */
function applyRemoteState(payload: unknown): void {
  const s = payload as {
    clientId?: string;
    workspaces?: Workspace[];
    userProfile?: UserProfile;
  } | null;
  if (!s || s.clientId === clientId) return; // our own save, coming back around
  if (!Array.isArray(s.workspaces)) return;
  const remote = restoreTerminalViews(s.workspaces);
  const ownPage = activePageId(useStore.getState());

  applyingRemote = true;
  try {
    useStore.setState((state) => ({
      workspaces: mergeLayout(state.workspaces, remote, ownPage),
      ...(s.userProfile && typeof s.userProfile.nickname === "string"
        ? { userProfile: s.userProfile }
        : {}),
    }));
  } finally {
    applyingRemote = false;
  }

  // Safety net: another window deleted the page (or workspace) this one was
  // showing, so it has to find somewhere else to be.
  if (!layoutHasPage(useStore.getState().workspaces, ownPage)) {
    void adoptView("");
    return;
  }

  // The sender had never heard of our page, which means neither has the server
  // — its record is a whole-layout rewrite, so the page exists only in this
  // window's memory until something writes it back. Do that now instead of
  // waiting for an edit that might never come. Saving puts it into later
  // snapshots, so this can't bounce back and forth.
  if (!layoutHasPage(remote, ownPage)) scheduleSave();
}

/**
 * Keep this window's layout in step with the others and save its changes back.
 *
 * The stream half is what makes more than one window safe at all: a save is a
 * whole-record rewrite, so without it the second window would keep writing the
 * copy it hydrated with at startup and silently undo the first window's edits.
 */
export function startStateSync(): void {
  if (isDemo) return;

  if (typeof EventSource !== "undefined") {
    const source = new EventSource(apiPath("/api/state/events"));
    source.addEventListener("state", (event) => {
      try {
        applyRemoteState(JSON.parse((event as MessageEvent<string>).data));
      } catch {
        /* the next event is another complete snapshot */
      }
    });
    source.onerror = () => {}; // EventSource reconnects on its own
  }

  void onTakenPagesChange((taken) => useStore.getState().setTakenPages(taken));

  scheduleSave = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      // Never persist a layout we never loaded — see `hydrated`.
      if (!hydrated) return;
      const { workspaces, userProfile, activeWorkspace, sidebarCollapsed } = useStore.getState();
      fetch(apiPath("/api/state"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId, workspaces, userProfile, activeWorkspace, sidebarCollapsed }),
      }).catch(() => {});
    }, 400);
  };

  // Where this window is looking is its own, so it goes to localStorage rather
  // than into the layout everyone shares.
  const rememberView = () => {
    const { activeWorkspace, activeNodes } = useStore.getState();
    writeWindowPref("activeWorkspace", activeWorkspace);
    writeWindowPref("activeNodes", JSON.stringify(activeNodes));
  };

  let lastView = "";
  useStore.subscribe(() => {
    const { activeWorkspace, activeNodes } = useStore.getState();
    const view = `${activeWorkspace} ${JSON.stringify(activeNodes)}`;
    if (view !== lastView) {
      lastView = view;
      rememberView();
    }
    // A snapshot from another window is already the server's truth — saving it
    // straight back would just bounce it between the windows.
    if (applyingRemote) return;
    scheduleSave();
  });

  rememberView();
  // Save once up front. Hydration happens before this subscription exists, so
  // without it a first-ever launch would sit on its built-in default layout
  // until the user happened to change something — and a second window opening
  // in the meantime would hydrate from an empty server and invent a default of
  // its own rather than seeing the first window's.
  scheduleSave();
}
