import { textInputProps } from "../textInputProps";
import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../i18n";
import { openExternal } from "../openExternal";
import { registerOccluder, unregisterOccluder } from "../nativeViewOcclusion";
import {
  cancelRemotePortForward,
  forwardRemotePort,
  servedUrlBrowserUrl,
  servedUrls,
  subscribeServedUrls,
} from "../terminal/servedUrls";
import { ExternalOpenIcon, PlusIcon, PortForwardIcon, SpinnerIcon, TrashIcon } from "./icons";

function parsePort(value: string): number | null {
  if (!/^\d+$/.test(value.trim())) return null;
  const port = Number(value);
  return port > 0 && port <= 65535 ? port : null;
}

/**
 * Manage the SSH pane's local forwards (`ssh -L`): every active remote → local
 * mapping, plus a form to add one. The list is the same live state the
 * header's served-URL menu reads, so auto-forwarded dev servers show up here.
 */
export function PortForwardDialog({
  sessionId,
  hostLabel,
  onClose,
}: {
  sessionId: string;
  hostLabel: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [remote, setRemote] = useState("");
  const [local, setLocal] = useState("");
  const [busy, setBusy] = useState<number | "add" | null>(null);
  const [error, setError] = useState("");
  const backdropRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const occluderId = useId();

  const subscribe = useCallback(
    (onChange: () => void) => subscribeServedUrls(sessionId, onChange),
    [sessionId],
  );
  const snapshot = useCallback(() => servedUrls(sessionId), [sessionId]);
  const entries = useSyncExternalStore(subscribe, snapshot, snapshot);
  const forwarded = entries.filter((entry) => entry.localPort);
  const detected = entries.filter((entry) => entry.remote && !entry.localPort);

  useEffect(() => {
    const backdrop = backdropRef.current;
    if (!backdrop) return;
    const sync = () => registerOccluder(occluderId, backdrop.getBoundingClientRect());
    const observer = new ResizeObserver(sync);
    observer.observe(backdrop);
    sync();
    return () => {
      observer.disconnect();
      unregisterOccluder(occluderId);
    };
  }, [occluderId]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const run = async (key: number | "add", action: () => Promise<unknown>) => {
    setBusy(key);
    setError("");
    try {
      await action();
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const remotePort = parsePort(remote);
  const localPort = local.trim() ? parsePort(local) : undefined;
  const canAdd = remotePort !== null && localPort !== null && busy === null;

  const add = async () => {
    if (!canAdd) return;
    const ok = await run("add", () => forwardRemotePort(sessionId, remotePort, localPort));
    if (ok) {
      setRemote("");
      setLocal("");
    }
  };

  return createPortal(
    <div
      ref={backdropRef}
      className="ws-dialog-backdrop ssh-manager-backdrop"
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => {
        event.stopPropagation();
        if (event.target === event.currentTarget) onClose();
      }}
      onClick={(event) => event.stopPropagation()}
    >
      <div ref={dialogRef} className="ssh-manager-dialog port-forward-dialog" role="dialog" aria-modal="true">
        <header className="ssh-manager-header">
          <h2>{t("portForward.title", { host: hostLabel })}</h2>
          <div className="ssh-manager-header-actions">
            <button className="ssh-manager-close" onClick={onClose} aria-label={t("common.close")}>×</button>
          </div>
        </header>
        <form
          className="port-forward-form"
          onSubmit={(event) => {
            event.preventDefault();
            void add();
          }}
        >
          <label>
            {t("portForward.remotePort")}
            <input
              {...textInputProps}
              autoFocus
              inputMode="numeric"
              placeholder="3000"
              value={remote}
              onChange={(event) => setRemote(event.target.value)}
            />
          </label>
          <span className="port-forward-arrow" aria-hidden>→</span>
          <label>
            {t("portForward.localPort")}
            <input
              {...textInputProps}
              inputMode="numeric"
              placeholder={remotePort ? String(remotePort) : t("portForward.localAuto")}
              value={local}
              onChange={(event) => setLocal(event.target.value)}
            />
          </label>
          <button type="submit" className="ssh-manager-add" disabled={!canAdd}>
            {busy === "add" ? <SpinnerIcon /> : <PlusIcon />}
            {t("ssh.add")}
          </button>
        </form>
        <div className="ssh-manager-list">
          {forwarded.map((entry) => (
            <div className="ssh-manager-row" key={entry.port}>
              <PortForwardIcon />
              <div>
                <strong>{`${hostLabel}:${entry.port} → localhost:${entry.localPort}`}</strong>
                <span>{servedUrlBrowserUrl(entry)}</span>
              </div>
              <button
                title={t("pane.openInBrowser", { url: servedUrlBrowserUrl(entry) })}
                aria-label={t("pane.openInBrowser", { url: servedUrlBrowserUrl(entry) })}
                onClick={() => void run(entry.port, async () => {
                  const openError = await openExternal(servedUrlBrowserUrl(entry));
                  if (openError) throw new Error(openError);
                })}
              >
                <ExternalOpenIcon />
              </button>
              <button
                title={t("portForward.remove")}
                aria-label={t("portForward.remove")}
                disabled={busy !== null}
                onClick={() => void run(entry.port, () => cancelRemotePortForward(sessionId, entry.port))}
              >
                {busy === entry.port ? <SpinnerIcon /> : <TrashIcon />}
              </button>
            </div>
          ))}
          {forwarded.length === 0 && <div className="ssh-manager-empty">{t("portForward.empty")}</div>}
        </div>
        {detected.length > 0 && (
          <div className="port-forward-detected">
            <span>{t("portForward.detected")}</span>
            {detected.map((entry) => (
              <button
                key={entry.port}
                type="button"
                disabled={busy !== null}
                title={t("portForward.forwardPort", { port: entry.port })}
                onClick={() => void run(entry.port, () => forwardRemotePort(sessionId, entry.port))}
              >
                {busy === entry.port ? <SpinnerIcon /> : <PlusIcon />}
                {entry.port}
              </button>
            ))}
          </div>
        )}
        {error && <div className="ssh-manager-error">{error}</div>}
      </div>
    </div>,
    document.body,
  );
}
