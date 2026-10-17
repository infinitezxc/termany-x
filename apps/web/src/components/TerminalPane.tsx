import { useEffect, useRef, useState } from "react";
import {
  attachSession,
  detachSession,
  fitSession,
  noteManualScroll,
  reconcileTerminalFocus,
  scrollSessionToBottom,
  scrollSessionToTop,
  subscribeTerminalScrollState,
  subscribeSshNaturalExit,
  terminalSessionId,
  type TerminalScrollState,
} from "../terminal/manager";
import { extractDroppedPaths, subscribeDesktopFileDrops } from "../terminal/desktopFileDrop";
import { reconcileAttachedTerminalFocus } from "../terminal/focusHandoff";
import { activeHtab, cwdCandidates, useStore } from "../state/store";
import { openLocalPathsInSession } from "../terminal/openLocalPath";
import { ChevronIcon } from "./icons";

/**
 * Mounts the persistent session DOM node for `id` into this slot. On unmount we
 * only DETACH the node — the session keeps living in the registry so its shell
 * and scrollback survive being backgrounded.
 */
export function TerminalPane({ id, sshTarget }: { id: string; sshTarget?: string }) {
  const sessionId = terminalSessionId(id, sshTarget);
  const hostRef = useRef<HTMLDivElement>(null);
  const scrollJumpTimer = useRef<number | null>(null);
  const sawInitialScrollState = useRef(false);
  const [dragOver, setDragOver] = useState(false);
  const [showScrollJump, setShowScrollJump] = useState(false);
  const [scrollState, setScrollState] = useState<TerminalScrollState>({
    hasOverflow: false,
    atTop: true,
    atBottom: true,
  });

  useEffect(() => subscribeSshNaturalExit(id, () => {
    useStore.getState().setPaneSshTarget(id);
  }), [id]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const state = useStore.getState();
    attachSession(
      sessionId,
      host,
      cwdCandidates(state, id),
      sshTarget,
      id,
    );

    // Attaching is the terminal's readiness boundary. The parent SplitView
    // normally reconciles after its children mount, but a newly-created pane
    // must not depend on React's cross-component passive-effect ordering to
    // receive the keyboard. Project the canonical store focus once now and
    // once after layout/default browser focus has settled. Re-reading the
    // store in both passes prevents a stale attach from stealing focus if the
    // user switched panes in the meantime.
    const cancelFocusHandoff = reconcileAttachedTerminalFocus(
      id,
      () => activeHtab(useStore.getState())?.focused,
      reconcileTerminalFocus,
    );

    const unsubscribeScrollState = subscribeTerminalScrollState(sessionId, setScrollState);

    // Coalesce resize bursts (window/split-drag fires RO every frame) to ONE fit
    // per animation frame — fit.fit() measures + reflows the grid and sends a PTY
    // resize, so running it per RO callback floods the socket while dragging.
    let raf = 0;
    const ro = new ResizeObserver(() => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        fitSession(sessionId);
      });
    });
    ro.observe(host);

    return () => {
      cancelFocusHandoff();
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
      unsubscribeScrollState();
      detachSession(sessionId, host);
    };
  }, [id, sessionId, sshTarget]);

  const revealScrollJump = () => {
    if (!scrollState.hasOverflow) return;
    setShowScrollJump(true);
    if (scrollJumpTimer.current) window.clearTimeout(scrollJumpTimer.current);
    scrollJumpTimer.current = window.setTimeout(() => {
      setShowScrollJump(false);
      scrollJumpTimer.current = null;
    }, 1400);
  };

  useEffect(() => {
    if (!scrollState.hasOverflow) {
      setShowScrollJump(false);
      return;
    }
    if (!sawInitialScrollState.current) {
      sawInitialScrollState.current = true;
      return;
    }
    revealScrollJump();
    return () => {
      if (scrollJumpTimer.current) window.clearTimeout(scrollJumpTimer.current);
    };
  }, [scrollState.atBottom, scrollState.atTop, scrollState.hasOverflow]);

  useEffect(() => {
    setDragOver(false);
    if (sshTarget) return;

    const containsPoint = (point: { x: number; y: number }) => {
      const rect = hostRef.current?.getBoundingClientRect();
      return !!rect && point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom;
    };

    return subscribeDesktopFileDrops((event) => {
      if (event.type === "leave") {
        setDragOver(false);
        return;
      }
      const isTarget = event.points.some(containsPoint);
      if (!isTarget) {
        setDragOver(false);
        return;
      }

      if (event.type === "drop") {
        setDragOver(false);
        void openLocalPathsInSession(id, event.paths);
        return;
      }

      setDragOver(true);
    });
  }, [id, sshTarget]);

  return (
    <div className={`term-pane ${dragOver ? "drag-over" : ""}`}>
      <div
        className="term-pane-host"
        ref={hostRef}
        onWheel={() => {
          noteManualScroll(sessionId);
          revealScrollJump();
        }}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes("Files")) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = sshTarget ? "none" : "copy";
          setDragOver(!sshTarget);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          if (sshTarget) return;
          void openLocalPathsInSession(id, extractDroppedPaths(e.dataTransfer));
        }}
      />
      {scrollState.hasOverflow && (
        <div className={`term-scroll-jump ${showScrollJump ? "visible" : ""}`}>
          <button
            className="term-scroll-btn"
            title="Scroll to top"
            disabled={scrollState.atTop}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => scrollSessionToTop(sessionId)}
          >
            <ChevronIcon dir="up" />
          </button>
          <button
            className="term-scroll-btn"
            title="Scroll to bottom"
            disabled={scrollState.atBottom}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => scrollSessionToBottom(sessionId)}
          >
            <ChevronIcon dir="down" />
          </button>
        </div>
      )}
    </div>
  );
}
