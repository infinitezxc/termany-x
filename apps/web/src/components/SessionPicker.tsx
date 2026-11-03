import { useCallback, useEffect, useId, useRef, useState, type SyntheticEvent } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../i18n";
import { registerOccluder, unregisterOccluder } from "../nativeViewOcclusion";
import { AgentHistory } from "./AgentHistory";
import { HistoryIcon } from "./icons";
import "./SessionPicker.css";

/** Opens the session picker for a pane: choosing a session shows it in that pane. */
export function SessionPickerButton({ paneId, title }: { paneId: string; title?: string }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  return <><button className="pane-session-trigger" title={t("sessions.switch")}
    aria-label={t("sessions.title")} onPointerDown={e => e.stopPropagation()} onClick={() => setOpen(true)}>
    <HistoryIcon />{title && <span>{title}</span>}
  </button>{open && <SessionPicker paneId={paneId} onClose={close} />}</>;
}
export function SessionPicker({ paneId, onClose }: { paneId?: string; onClose: () => void }) {
  const { t } = useI18n();
  const backdrop = useRef<HTMLDivElement>(null);
  // Only a press that starts on the backdrop closes: a drag out of the dialog doesn't.
  const pressedBackdrop = useRef(false);
  const occluder = useId();
  useEffect(() => {
    const el = backdrop.current;
    if (!el) return;
    const previous = document.activeElement as HTMLElement | null;
    const update = () => registerOccluder(occluder, el.getBoundingClientRect());
    const observer = new ResizeObserver(update); observer.observe(el); update();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); onClose(); }
      if (e.key === "Tab") {
        const items = [...el.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), summary')];
        const first = items[0], last = items.at(-1);
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
      }
    };
    window.addEventListener("keydown", key, true);
    return () => { observer.disconnect(); unregisterOccluder(occluder); window.removeEventListener("keydown", key, true); if (previous?.isConnected) previous.focus(); };
  }, [occluder, onClose]);
  // React bubbles a portal's events to the component that opened it: from the
  // pane header, a double-click would maximize the pane and remount the picker away.
  const stop = (e: SyntheticEvent) => e.stopPropagation();
  return createPortal(<div ref={backdrop} className="ws-dialog-backdrop ssh-manager-backdrop"
    onPointerDown={e => { stop(e); pressedBackdrop.current = e.target === e.currentTarget; }}
    onClick={e => { stop(e); if (pressedBackdrop.current && e.target === e.currentTarget) onClose(); }}
    onDoubleClick={stop} onMouseDown={stop} onMouseUp={stop} onContextMenu={stop} onKeyDown={stop}>
    <div className="ssh-manager-dialog session-picker" role="dialog" aria-modal="true" aria-label={t("sessions.title")}>
      <header className="ssh-manager-header">
        <h2>{t("sessions.title")}</h2>
        <div className="ssh-manager-header-actions">
          <button className="ssh-manager-close" onClick={onClose} aria-label={t("common.close")}>×</button>
        </div>
      </header>
      <AgentHistory paneId={paneId} autoFocus onOpened={onClose} />
    </div>
  </div>, document.body);
}
