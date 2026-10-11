import { Channel, invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { apiUrl } from "./api";
import { isTauri } from "./env";

// Small file-sheet preview, encoded once rather than loading an image during
// the pointer gesture. The OS receives real file paths with copy semantics.
function dragIcon(): string {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 48;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(10, 4, 28, 38);
  ctx.strokeStyle = "#64748b";
  ctx.lineWidth = 2;
  ctx.strokeRect(10, 4, 28, 38);
  for (const y of [16, 23, 30]) {
    ctx.beginPath(); ctx.moveTo(16, y); ctx.lineTo(32, y); ctx.stroke();
  }
  return canvas.toDataURL("image/png");
}

/** Delegate from the viewer so rows and tabs share cancellation and status. */
export function useFileDrag(remote?: string) {
  const [status, setStatus] = useState<string | null>(null);
  const cleanup = useRef<(() => void) | null>(null);
  const suppressClick = useRef(false);
  useEffect(() => () => cleanup.current?.(), [remote]);

  const onPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (!isTauri || event.button !== 0 || event.pointerType !== "mouse") return;
    suppressClick.current = false;
    const target = event.target as HTMLElement;
    if (target.closest("button, input, textarea")) return;
    const file = target.closest<HTMLElement>("[data-drag-file]")?.dataset.dragFile;
    if (!file) return;
    cleanup.current?.();
    const x = event.clientX, y = event.clientY;
    let started = false;
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", cancel);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("blur", cancel);
    };
    const cancel = () => { stop(); setStatus(null); };
    const move = (e: PointerEvent) => {
      if (!(e.buttons & 1)) { cancel(); return; }
      if (started || Math.hypot(e.clientX - x, e.clientY - y) < 5) return;
      started = true;
      suppressClick.current = true;
      setStatus(null);
      // End DOM tracking before handing the gesture to the operating system.
      // The native promise requests this URL only after an accepted drop.
      stop();
      const downloadUrl = remote
        ? `${apiUrl()}/api/fs/download?${new URLSearchParams({ path: file, session: remote })}`
        : null;
      const mac = /Mac/.test(navigator.platform);
      const drag = mac || remote
        ? invoke("start_file_drag", { path: file, downloadUrl })
        : invoke("plugin:drag|start_drag", {
            item: [file], image: dragIcon(), options: { mode: "copy" },
            onEvent: new Channel(),
          });
      void drag.catch((error) => {
        setStatus(`Cannot drag file: ${error instanceof Error ? error.message : String(error)}`);
      });
    };
    cleanup.current = stop;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", cancel);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("blur", cancel);
  };
  return {
    status,
    handlers: {
      onPointerDown,
      onDragStart: (e: React.DragEvent) => { if (isTauri) e.preventDefault(); },
      onClickCapture: (e: React.MouseEvent) => {
        if (suppressClick.current) {
          suppressClick.current = false;
          e.preventDefault(); e.stopPropagation();
        }
      },
    },
  };
}
