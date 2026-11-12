import { textInputProps } from "../textInputProps";
import { flushSync } from "react-dom";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent } from "react";
import { shellQuote } from "../agentCommand";
import { useAgentConfigs, type AgentConfig } from "../agents";
import { apiPath } from "../api";
import { useI18n } from "../i18n";
import { useImeGuard } from "../imeGuard";
import { activeHtab, findLeaf, focusedCwdSession, remoteLeafFor, useStore } from "../state/store";
import {
  activeAgentKind,
  agentActivitySnapshot,
  paneHasShell,
  queueCommandWhenShellReady,
  subscribeAgentActivity,
  terminalSessionId,
} from "../terminal/manager";
import { openSessionPane, pageTitleOf, sessionPanes, showPane } from "../sessionNavigation";
import type { SessionOpenMode } from "../sessionOpenPolicy";
import { useRemoteSessions, useSessionAction } from "../sessionPickerState";
import { agentLaunch, localTmuxAvailable, matchingTmux, resumeOnHost, sessionAgentLabel, type SessionAgent } from "../tmuxClient";
import { loadSessionAgentOrder, moveSessionAgent, saveSessionAgentOrder } from "../sessionAgentOrder";
import { beginDragCursor, endDragCursor } from "../dragGhost";
import { tildify } from "../tildify";
import { HistoryIcon, NewPaneIcon, TrashIcon } from "./icons";
import { RemoteSessions } from "./RemoteSessions";
import "./SessionPicker.css";

type Translate = ReturnType<typeof useI18n>["t"];

interface AgentSession {
  sessionId: string;
  cwd: string | null;
  /** The first prompt; shown under the title when the agent named the conversation. */
  preview: string;
  title?: string;
  mtimeMs: number;
  totalTokens: number | null;
  contextTokens: number | null;
  gitBranch: string | null;
  /** The session's cwd no longer exists (a deleted worktree, usually). */
  cwdMissing?: true;
}

/**
 * What the list is scoped to when it opens: the repo containing the focused
 * pane (every worktree of it), or the pane's plain directory when it isn't in
 * a repo. Captured once at open — the modal shouldn't reshuffle mid-use.
 */
interface ScopeInfo {
  kind: "repo" | "dir";
  /** Directories whose sessions are in scope (repo: every worktree root). */
  roots: string[];
  /** Worktree holding the focused pane — its group lists first. */
  currentRoot: string;
  /** The repo's own checkout: where a deleted-worktree session resumes. */
  mainRoot: string;
  worktrees: { path: string; name: string; branch: string; main: boolean }[];
}

interface Group {
  key: string;
  /** Branch name, or the deleted-worktrees label. */
  label: string;
  path: string | null;
  sessions: AgentSession[];
}

interface SessionPageState {
  sessions: AgentSession[] | null | undefined;
  nextCursor: string | null;
  loadingMore: boolean;
}

const SESSION_PAGE_SIZE = 30;

const ACTIVE_WINDOW_MS = 2 * 60_000;

/** Whether `cwd` sits at or below `root` (prefix on path segments). */
function underRoot(cwd: string, root: string): boolean {
  return cwd === root || cwd.startsWith(root + "/") || cwd.startsWith(root + "\\");
}

function relativeTime(mtimeMs: number, t: Translate): string {
  const mins = Math.floor((Date.now() - mtimeMs) / 60000);
  if (mins < 1) return t("history.time.now");
  if (mins < 60) return t("history.time.m", { n: mins });
  const hours = Math.floor(mins / 60);
  if (hours < 24) return t("history.time.h", { n: hours });
  const days = Math.floor(hours / 24);
  if (days < 30) return t("history.time.d", { n: days });
  return new Date(mtimeMs).toLocaleDateString();
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1e6) return `${(n / 1e3).toFixed(n < 1e4 ? 1 : 0)}k`;
  return `${(n / 1e6).toFixed(1)}M`;
}

/**
 * Agent session-history browser: Codex first, then Claude Code, when enabled.
 * Each tab lists past conversations newest-first, read server-side from the
 * agent's own on-disk transcript format.
 *
 * The list opens scoped to wherever the focused pane is: the containing repo
 * (grouped by worktree, current one first, deleted worktrees last) or, outside
 * a repo, the pane's directory. Tab flips between that scope and everything.
 * The shared selector combines running sessions with history. Choosing
 * a session shows it in this view's pane; each one not open yet can also open
 * in a new pane (⌘/Ctrl+Enter). One already open is shown where it is. History
 * resumes use tmux on SSH hosts and locally when installed.
 */
export function AgentHistory({ paneId: historyPaneId, autoFocus = false, onOpened }: { paneId?: string; autoFocus?: boolean; onOpened?: () => void }) {
  const { t } = useI18n();
  const ime = useImeGuard();
  const workspaces = useStore((s) => s.workspaces);
  const agentConfigs = useAgentConfigs();
  // The agent tabs' order is the user's, set by dragging a tab; the first one opens selected.
  const [agentOrder, setAgentOrder] = useState(loadSessionAgentOrder);
  const agents = agentOrder
    .map((id) => agentConfigs.find((agent) => agent.id === id && agent.enabled))
    .filter((agent): agent is AgentConfig => agent !== undefined);
  const [selectedAgentId, setAgentId] = useState<string>(() => agentOrder[0]);
  const agentId = agents.find((agent) => agent.id === selectedAgentId)?.id ?? agents[0]?.id ?? "codex";
  // list key ("agent" or "agent|scoped") → paged sessions; null = unsupported.
  const [byKey, setByKey] = useState<Record<string, SessionPageState>>({});
  const [error, setError] = useState(false);
  const [stale, setStale] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  // The session whose delete button was clicked once; a second click deletes.
  const [armedDelete, setArmedDelete] = useState<string | null>(null);
  // undefined = resolving, null = no scope to offer (not in a repo or folder
  // worth scoping to) — the toggle hides and the list shows everything.
  const [scopeInfo, setScopeInfo] = useState<ScopeInfo | null | undefined>(undefined);
  const [scope, setScope] = useState<"scoped" | "all">("scoped");
  // The pane this history view was created from, frozen so later focus changes
  // do not reshuffle the list mid-use. When that pane is an SSH one, the
  // history is the host's — its agents run there, and so do their resumes.
  const [{ gitSession, ssh }] = useState(() => {
    const state = useStore.getState();
    const layout = activeHtab(state)?.layout;
    const historyLeaf = historyPaneId && layout ? findLeaf(layout, historyPaneId) : undefined;
    // An existing pane can switch directly from its live shell to history.
    // Prefer that shell over the pane it originally inherited a directory from.
    const id = historyLeaf
      ? historyLeaf.sshTarget || paneHasShell(historyLeaf.id)
        ? historyLeaf.id
        : historyLeaf.cwdFrom ?? historyLeaf.id
      : focusedCwdSession(state);
    const leaf = id ? remoteLeafFor(state, id) : undefined;
    return leaf?.sshTarget
      ? {
          gitSession: terminalSessionId(leaf.id, leaf.sshTarget),
          ssh: { paneId: leaf.id, target: leaf.sshTarget, label: leaf.sshLabel, session: terminalSessionId(leaf.id, leaf.sshTarget) },
        }
      : { gitSession: id, ssh: undefined };
  });
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Resumes, opens and the running list's own actions share one busy state and error.
  const action = useSessionAction();
  const tmuxHost = ssh ?? { session: gitSession || "local", label: t("ssh.local") };
  const remote = useRemoteSessions(tmuxHost.session);

  useEffect(() => {
    if (!autoFocus) return;
    const frame = requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [autoFocus]);

  const agentName = agents.find((a) => a.id === agentId)?.name ?? agentId;

  // Resolve the scope once: repo worktrees first, plain directory as fallback.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const get = (url: string) =>
        fetch(apiPath(url)).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      const session = encodeURIComponent(gitSession ?? "");
      const ov = await get(`/api/git/worktrees?session=${session}`);
      if (cancelled) return;
      if (ov?.repo) {
        const worktrees: ScopeInfo["worktrees"] = ov.worktrees?.length
          ? ov.worktrees
          : [{ path: ov.root, name: ov.root.split("/").pop() ?? ov.root, branch: ov.branch, main: true }];
        setScopeInfo({
          kind: "repo",
          roots: worktrees.map((w) => w.path),
          currentRoot: ov.root,
          mainRoot: worktrees.find((w) => w.main)?.path ?? ov.root,
          worktrees,
        });
        return;
      }
      // The directory fallback reads this machine's shells; a remote pane
      // outside a repo just lists everything on its host.
      const dir = ssh ? null : await get(`/api/agent/acp/cwd?cwdFrom=${session}`);
      if (cancelled) return;
      // A pane sitting in the home dir has no meaningful "here" to scope to.
      if (dir?.cwd && dir.cwd !== dir.home) {
        setScopeInfo({ kind: "dir", roots: [dir.cwd], currentRoot: dir.cwd, mainRoot: dir.cwd, worktrees: [] });
      } else {
        setScopeInfo(null);
        setScope("all");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [gitSession, ssh]);

  const listKey = scope === "scoped" && scopeInfo ? `${agentId}|scoped` : agentId;
  const page = byKey[listKey];
  const sessions = page?.sessions;

  useEffect(() => {
    // The scoped fetch needs the roots; wait for scope resolution first.
    if (scope === "scoped" && scopeInfo === undefined) return;
    if (listKey in byKey) return;
    let cancelled = false;
    setError(false);
    const params = new URLSearchParams({ agent: agentId, limit: String(SESSION_PAGE_SIZE) });
    if (ssh) params.set("session", ssh.session);
    if (scope === "scoped" && scopeInfo) for (const r of scopeInfo.roots) params.append("root", r);
    fetch(apiPath(`/api/agent-sessions?${params}`))
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((data) => {
        if (!cancelled) {
          setByKey((m) => ({
            ...m,
            [listKey]: {
              sessions: Array.isArray(data.sessions) ? data.sessions : null,
              nextCursor: typeof data.nextCursor === "string" ? data.nextCursor : null,
              loadingMore: false,
            },
          }));
        }
      })
      .catch((e: Error) => {
        if (cancelled) return;
        // See AgentUsage: a 404 here means an older server survived the upgrade.
        setStale(e.message === "404");
        setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [agentId, listKey, byKey, scope, scopeInfo, ssh]);

  const loadMore = () => {
    const current = byKey[listKey];
    if (!current?.nextCursor || current.loadingMore || !Array.isArray(current.sessions)) return;
    const cursor = current.nextCursor;
    setByKey((m) => ({ ...m, [listKey]: { ...current, loadingMore: true } }));
    const params = new URLSearchParams({
      agent: agentId,
      limit: String(SESSION_PAGE_SIZE),
      cursor,
    });
    if (ssh) params.set("session", ssh.session);
    if (scope === "scoped" && scopeInfo) for (const root of scopeInfo.roots) params.append("root", root);
    fetch(apiPath(`/api/agent-sessions?${params}`))
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((data) => {
        setByKey((m) => {
          const latest = m[listKey];
          if (!latest || !Array.isArray(latest.sessions)) return m;
          const seen = new Set(latest.sessions.map((session) => session.sessionId));
          const additions = Array.isArray(data.sessions)
            ? data.sessions.filter((session: AgentSession) => !seen.has(session.sessionId))
            : [];
          return {
            ...m,
            [listKey]: {
              sessions: [...latest.sessions, ...additions],
              nextCursor: typeof data.nextCursor === "string" ? data.nextCursor : null,
              loadingMore: false,
            },
          };
        });
      })
      .catch((e: Error) => {
        setStale(e.message === "404");
        setError(true);
        setByKey((m) => {
          const latest = m[listKey];
          return latest ? { ...m, [listKey]: { ...latest, loadingMore: false } } : m;
        });
      });
  };

  // Server order is already newest-first; filtering preserves it. In repo
  // scope the flat order regroups by worktree — current one first, the rest
  // as git lists them, sessions of since-deleted worktrees last.
  const { rows, groups } = useMemo((): { rows: AgentSession[]; groups: Group[] | null } => {
    if (!sessions) return { rows: [], groups: null };
    const q = query.trim().toLowerCase();
    // A conversation running in tmux is listed with the running sessions instead.
    const historical = sessions.filter(s => !matchingTmux(remote.sessions, agentId, s.sessionId));
    const filtered = q
      ? historical.filter(
          (s) => `${s.title ?? ""} ${s.preview} ${s.cwd ?? ""}`.toLowerCase().includes(q)
        )
      : historical;
    if (scope !== "scoped" || scopeInfo?.kind !== "repo") return { rows: filtered, groups: null };

    const byLen = [...scopeInfo.worktrees].sort((a, b) => b.path.length - a.path.length);
    const buckets = new Map<string, AgentSession[]>();
    const gone: AgentSession[] = [];
    for (const s of filtered) {
      const wt = s.cwd && !s.cwdMissing ? byLen.find((w) => underRoot(s.cwd!, w.path)) : undefined;
      if (!wt) {
        gone.push(s);
        continue;
      }
      let list = buckets.get(wt.path);
      if (!list) buckets.set(wt.path, (list = []));
      list.push(s);
    }
    const ordered = [...scopeInfo.worktrees].sort(
      (a, b) => Number(b.path === scopeInfo.currentRoot) - Number(a.path === scopeInfo.currentRoot)
    );
    const groups: Group[] = [];
    for (const w of ordered) {
      const list = buckets.get(w.path);
      if (list?.length) groups.push({ key: w.path, label: w.branch, path: tildify(w.path), sessions: list });
    }
    if (gone.length) groups.push({ key: "|gone", label: t("history.group.deleted"), path: null, sessions: gone });
    return { rows: groups.flatMap((g) => g.sessions), groups };
  }, [sessions, query, scope, scopeInfo, t, remote.sessions, agentId]);

  useEffect(() => setSelected(0), [rows]);

  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-idx="${selected}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  // Conversations already hosted by an open pane (registered on resume). The
  // tag outlives the conversation — the agent may have exited, or the pane
  // moved on to another agent — so only a pane whose terminal is still inside
  // that agent counts; otherwise the row resumes normally.
  // Only panes on this history's host: the same conversation ID elsewhere is a
  // different transcript.
  const taggedPanes = useMemo(
    () =>
      new Map(
        sessionPanes(workspaces)
          .filter(({ leaf }) => leaf.sshTarget === ssh?.target && leaf.agentSession)
          .map(({ leaf, location }) => [`${leaf.agentSession!.agent}|${leaf.agentSession!.sessionId}`, location]),
      ),
    [workspaces, ssh],
  );
  const taggedIds = useMemo(() => [...taggedPanes.values()].map((loc) => loc.paneId), [taggedPanes]);
  const activity = useSyncExternalStore(
    subscribeAgentActivity,
    () => agentActivitySnapshot(taggedIds),
    () => "",
  );
  const openPanes = useMemo(
    () =>
      new Map(
        [...taggedPanes].filter(([key, loc]) => activeAgentKind(loc.paneId) === key.slice(0, key.indexOf("|"))),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `activity` is the change signal
    [taggedPanes, activity],
  );

  const resume = (s: AgentSession, mode: SessionOpenMode = "switch") => action.run(async () => {
    const loc = openPanes.get(`${agentId}|${s.sessionId}`);
    if (loc) {
      showPane(loc);
      onOpened?.();
      return;
    }
    const cfg = agents.find((a) => a.id === agentId);
    if (!cfg) return;
    const live = Date.now() - s.mtimeMs < ACTIVE_WINDOW_MS;
    const title = s.title || s.preview;
    // A deleted worktree can't be cd'd into; in scope the repo root is the
    // next-best home for that conversation. Outside a scope we can't tell
    // which repo it belonged to, so just resume from wherever the shell lands.
    const cwd = s.cwdMissing ? (scope === "scoped" ? scopeInfo?.mainRoot ?? null : null) : s.cwd;
    if (ssh || await localTmuxAvailable()) {
      // Local and remote conversations run in tmux so they survive a dropped link.
      const run = await resumeOnHost(tmuxHost.session, cfg, { conversationId: s.sessionId, live, cwd, page: pageTitleOf(historyPaneId) });
      if (run.created) await remote.reload();
      await openSessionPane({
        mode, sourcePaneId: historyPaneId,
        destination: {
          title: title || run.name, sshTarget: ssh?.target, sshLabel: ssh?.label, tmuxSession: run.name,
          agentSession: run.conversationId ? { agent: agentId, sessionId: run.conversationId } : undefined,
        },
      });
    } else {
      const launch = agentLaunch(cfg, { resume: s.sessionId, fork: live });
      const paneId = await openSessionPane({
        mode, sourcePaneId: historyPaneId,
        destination: {
          title: title || agentId,
          agentSession: launch.conversationId ? { agent: agentId, sessionId: launch.conversationId } : undefined,
        },
      });
      queueCommandWhenShellReady(paneId, cwd ? `cd ${shellQuote(cwd)} && ${launch.command}` : launch.command);
    }
    onOpened?.();
  });

  /** Delete a conversation's transcript, on the host its history comes from. */
  const deleteSession = (s: AgentSession) => action.run(async () => {
    setArmedDelete(null);
    const response = await fetch(apiPath("/api/agent-sessions/delete"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent: agentId, sessionId: s.sessionId, session: ssh?.session }),
    });
    if (!response.ok) throw new Error((await response.json().catch(() => null))?.error || String(response.status));
    // Every loaded page of this agent's history, scoped or not, drops the row.
    setByKey((pages) => Object.fromEntries(Object.entries(pages).map(([key, page]) => [
      key,
      key.split("|")[0] === agentId && page.sessions
        ? { ...page, sessions: page.sessions.filter((item) => item.sessionId !== s.sessionId) }
        : page,
    ])));
  });

  const switchAgent = (id: string) => {
    setAgentId(id);
    setQuery("");
    inputRef.current?.focus();
  };

  // A dragged tab follows the pointer within the row while the tabs it passes
  // slide aside; on release it settles into its slot and the order is saved.
  const tabDragged = useRef(false);
  const startTabDrag = (id: SessionAgent, e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    const { pointerId, clientX: x, clientY: y } = e;
    const self = e.currentTarget;
    const tabs = [...self.parentElement!.querySelectorAll<HTMLElement>("[data-history-agent]")];
    const rects = tabs.map((tab) => tab.getBoundingClientRect());
    const from = tabs.indexOf(self);
    const mid = (r: DOMRect) => r.left + r.width / 2;
    // How far the passed tabs shift: the dragged tab's width plus the gap after it.
    const step = rects[from].width + (parseFloat(getComputedStyle(self.parentElement!).columnGap) || 0);
    let active = false;
    let to = from;
    tabDragged.current = false;
    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      if (!active) {
        if (Math.hypot(ev.clientX - x, ev.clientY - y) < 4) return;
        active = true;
        self.classList.add("dragging");
        tabs.forEach((tab) => { if (tab !== self) tab.style.transition = "transform .15s ease"; });
        beginDragCursor();
      }
      ev.preventDefault();
      const dx = Math.min(Math.max(ev.clientX - x, rects[0].left - rects[from].left), rects.at(-1)!.right - rects[from].right);
      self.style.transform = `translateX(${dx}px)`;
      // A tab is passed once the dragged tab's leading edge crosses its middle;
      // its center couldn't reach a narrower tab's middle within the row.
      const left = rects[from].left + dx, right = rects[from].right + dx;
      to = from;
      rects.forEach((r, i) => {
        if (i > from && right > mid(r)) to = i;
        if (i < from && left < mid(r) && to === from) to = i;
      });
      tabs.forEach((tab, i) => {
        if (tab === self) return;
        const shift = i > from && i <= to ? -step : i < from && i >= to ? step : 0;
        tab.style.transform = shift ? `translateX(${shift}px)` : "";
      });
    };
    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      endDragCursor();
      if (!active) return;
      tabDragged.current = true;
      if (ev.type !== "pointerup") to = from;
      // Commit the order synchronously, then animate the dragged tab from where
      // it was dropped into its new slot; the others are already in place.
      const dropped = self.getBoundingClientRect().left;
      if (to !== from) {
        const next = moveSessionAgent(agentOrder, id, tabs[to].dataset.historyAgent as SessionAgent);
        flushSync(() => setAgentOrder(next));
        saveSessionAgentOrder(next);
      }
      tabs.forEach((tab) => { tab.style.transition = ""; tab.style.transform = ""; });
      self.style.transform = `translateX(${dropped - self.getBoundingClientRect().left}px)`;
      void self.offsetWidth;
      self.style.transition = "transform .15s ease";
      self.style.transform = "";
      // A timer rather than transitionend: a tab dropped exactly in its slot doesn't transition.
      setTimeout(() => { self.style.transition = ""; self.classList.remove("dragging"); }, 150);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  const switchScope = (next: "scoped" | "all") => {
    setScope(next);
    inputRef.current?.focus();
  };

  const renderRow = (s: AgentSession, idx: number, inWorktreeGroup: boolean) => {
    const isOpen = openPanes.has(`${agentId}|${s.sessionId}`);
    const isLive = !isOpen && Date.now() - s.mtimeMs < ACTIVE_WINDOW_MS;
    const meta = [
      relativeTime(s.mtimeMs, t),
      s.totalTokens !== null ? t("history.meta.tokens", { n: formatTokens(s.totalTokens) }) : null,
      s.contextTokens !== null ? t("history.meta.ctx", { n: formatTokens(s.contextTokens) }) : null,
      // The group header already names the branch; repeat it only elsewhere.
      !inWorktreeGroup && s.gitBranch ? s.gitBranch : null,
      s.cwd && !inWorktreeGroup ? tildify(s.cwd) : null,
    ].filter(Boolean);
    return (
      <div className="session-row" key={s.sessionId} onMouseLeave={() => armedDelete === s.sessionId && setArmedDelete(null)}>
        <button
          data-idx={idx}
          className={`search-row pane ${idx === selected ? "active" : ""}`}
          onMouseEnter={() => setSelected(idx)}
          onClick={() => resume(s)}
        >
          <span className="search-row-main">
            <span className="search-row-label">{s.title || s.preview || t("history.emptySession")}</span>
            {s.title && s.preview && <span className="search-row-breadcrumb">{s.preview}</span>}
            <span className={`search-row-breadcrumb ${s.cwdMissing ? "history-gone" : ""}`}>
              {meta.join(" · ")}
            </span>
          </span>
          {isOpen && (
            <span className="history-badge open" title={t("history.badge.openTitle")}>
              {t("history.badge.open")}
            </span>
          )}
          {isLive && (
            <span className="history-badge live" title={t("history.badge.activeTitle")}>
              {t("history.badge.active")}
            </span>
          )}
          {s.cwdMissing && (
            <span className="history-badge stale" title={t("history.badge.staleTitle")}>
              {t("history.badge.stale")}
            </span>
          )}
        </button>
        {!isOpen && (
          <button
            className="session-icon-btn session-row-action"
            title={t("sessions.openNewPane")}
            aria-label={t("sessions.openNewPane")}
            onMouseEnter={() => setSelected(idx)}
            onClick={() => resume(s, "new")}
          >
            <NewPaneIcon />
          </button>
        )}
        {/* Open conversations cannot be deleted; recently active ones are refused by the server too. */}
        {!isOpen && (
          <button
            className={`session-icon-btn session-row-action ${armedDelete === s.sessionId ? "armed" : ""}`}
            disabled={action.busy || isLive}
            title={t(isLive ? "history.deleteActive" : armedDelete === s.sessionId ? "history.deleteConfirm" : "history.delete")}
            aria-label={t("history.delete")}
            onMouseEnter={() => setSelected(idx)}
            onClick={() => (armedDelete === s.sessionId ? void deleteSession(s) : setArmedDelete(s.sessionId))}
          >
            <TrashIcon />
          </button>
        )}
      </div>
    );
  };

  const scopedLabel = t(scopeInfo?.kind === "dir" ? "history.scope.dir" : "history.scope.repo");
  const emptyScoped = scope === "scoped" && scopeInfo;

  return (
    <div className="agent-history-pane">
        <div className="search-input-row">
          <span className="search-input-ico">
            <HistoryIcon />
          </span>
          <input
            {...textInputProps}
            ref={inputRef}
            className="search-input"
            autoFocus={autoFocus}
            {...ime.props}
            value={query}
            placeholder={t("history.placeholder", { agent: agentName })}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (ime.handled(e)) return;
              if (e.key === "Tab" && scopeInfo !== null) {
                e.preventDefault();
                setScope((v) => (v === "all" ? "scoped" : "all"));
              } else if (e.key === "ArrowDown") {
                e.preventDefault();
                setSelected((i) => Math.min(i + 1, rows.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setSelected((i) => Math.max(i - 1, 0));
              } else if (e.key === "Enter") {
                e.preventDefault();
                const row = rows[selected];
                if (row) resume(row, e.metaKey || e.ctrlKey ? "new" : "switch");
              }
            }}
          />
          {scopeInfo !== null && (
            <div className="history-scope" title={t("history.scope.hint")}>
              <button
                className={scope === "scoped" ? "active" : ""}
                onClick={() => switchScope("scoped")}
              >
                {scopedLabel}
              </button>
              <button className={scope === "all" ? "active" : ""} onClick={() => switchScope("all")}>
                {t("history.scope.all")}
              </button>
            </div>
          )}
        </div>
        {action.error && <div role="alert" className="session-error">{action.error}</div>}

        {(ssh || remote.sessions.length > 0 || remote.loading || remote.error) ? (
          <RemoteSessions
            host={tmuxHost}
            sourcePaneId={historyPaneId ?? ssh?.paneId}
            remote={remote}
            action={action}
            query={query}
            onOpened={onOpened}
          />
        ) : null}

        <div className="history-tabs">
          <span className="session-section-label">{t("sessions.history")}</span>
          {agents.map((a) => (
            <button
              key={a.id}
              className={`history-tab ${a.id === agentId ? "active" : ""}`}
              data-history-agent={a.id}
              onPointerDown={(e) => startTabDrag(a.id as SessionAgent, e)}
              onClick={() => {
                // The click that ends a drag doesn't also switch tabs.
                if (tabDragged.current) { tabDragged.current = false; return; }
                switchAgent(a.id);
              }}
            >
              <span>{sessionAgentLabel(a.id)}</span>
            </button>
          ))}
        </div>

        <div className="search-results" ref={listRef}>
          {error && (
            <div className="search-empty">{t(stale ? "server.stale" : "history.error")}</div>
          )}
          {!error && sessions === undefined && <div className="search-empty">{t("history.loading")}</div>}
          {!error && sessions === null && (
            <div className="search-empty">{t("history.unsupported", { agent: agentName })}</div>
          )}
          {!error && Array.isArray(sessions) && rows.length === 0 && (
            <div className="search-empty">
              <div>
                {query.trim()
                  ? t("history.noMatch", { query: query.trim() })
                  : t(emptyScoped ? "history.emptyScoped" : "history.empty", { agent: agentName })}
              </div>
              {emptyScoped && <div className="history-scope-hint">{t("history.tabHint")}</div>}
            </div>
          )}
          {groups
            ? (() => {
                let idx = 0;
                return groups.map((g) => (
                  <div key={g.key}>
                    <div className="history-group">
                      <span className="history-group-branch">{g.label}</span>
                      {g.path && <span className="history-group-path">{g.path}</span>}
                      <span className="history-group-count">
                        {t("history.group.count", { n: g.sessions.length })}
                      </span>
                    </div>
                    {g.sessions.map((s) => renderRow(s, idx++, g.key !== "|gone"))}
                  </div>
                ));
              })()
            : rows.map((s, idx) => renderRow(s, idx, false))}
          {!error && Array.isArray(sessions) && page?.nextCursor && (
            <button className="history-load-more" disabled={page.loadingMore} onClick={loadMore}>
              {t(page.loadingMore ? "history.loadingMore" : "history.loadMore")}
            </button>
          )}
        </div>
    </div>
  );
}
