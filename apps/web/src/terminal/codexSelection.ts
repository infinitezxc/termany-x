import type { Terminal } from "@xterm/xterm";

/**
 * Codex's full-screen view keeps its transcript to itself: the alternate
 * screen has no scrollback for xterm, so a drag there is Codex's own
 * selection, which scrolls the transcript while the pointer stays past an
 * edge and copies on release. Two things are adjusted on the way in:
 *
 * - Codex leaves out the cell an upward drag starts in. A plain press is held
 *   back until it becomes a click, replayed unchanged, or a drag, whose press
 *   then starts past that cell when the drag goes up.
 * - Past the bottom, xterm reports the terminal's last row, which a tmux
 *   status line keeps from Codex. Codex scrolls only once it has seen its own
 *   last row, so that row is reported first.
 *
 * Wheels, other buttons, modified gestures, word/line clicks, other agents
 * and screens without mouse reporting pass through.
 */
export function installCodexSelection(term: Terminal, isCodex: () => boolean): { dispose(): void } {
  const element = term.element;
  const screen = element?.querySelector<HTMLElement>(".xterm-screen");
  if (!element || !screen) return { dispose() {} };
  const doc = element.ownerDocument;
  let replaying = false;
  let gesture: {
    down: MouseEvent; target: EventTarget; left: number; right: number; row: number; dragging: boolean;
    /** The row above the bottom one was last reported, for Codex to scroll from. */
    nearBottom: boolean;
  } | undefined;
  const cell = () => {
    const rect = screen.getBoundingClientRect();
    return { rect, width: rect.width / term.cols, height: rect.height / term.rows };
  };
  const coords = (event: MouseEvent) => {
    const { rect, width, height } = cell();
    if (!(width > 0) || !(height > 0)) return;
    return { column: Math.floor((event.clientX - rect.left) / width), row: Math.floor((event.clientY - rect.top) / height) };
  };
  const at = (type: string, from: MouseEvent, column: number, row: number) => {
    const { rect, width, height } = cell();
    return new MouseEvent(type, {
      bubbles: true, cancelable: true, view: from.view, detail: 1, button: 0, buttons: 1,
      clientX: rect.left + (Math.max(0, Math.min(term.cols - 1, column)) + 0.5) * width,
      clientY: rect.top + (row + 0.5) * height,
    });
  };
  const clone = (type: string, e: MouseEvent) => new MouseEvent(type, {
    bubbles: true, cancelable: true, view: e.view, detail: e.detail,
    clientX: e.clientX, clientY: e.clientY, screenX: e.screenX, screenY: e.screenY,
    button: e.button, buttons: e.buttons, shiftKey: e.shiftKey, altKey: e.altKey,
    ctrlKey: e.ctrlKey, metaKey: e.metaKey,
  });
  const replay = (target: EventTarget, event: MouseEvent) => {
    replaying = true;
    try { target.dispatchEvent(event); } finally { replaying = false; }
  };
  const down = (event: MouseEvent) => {
    if (replaying) return;
    gesture = undefined;
    if (event.button !== 0 || event.detail !== 1 || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return;
    if (!isCodex() || term.buffer.active.type !== "alternate" || term.modes.mouseTrackingMode === "none") return;
    const position = coords(event);
    if (!position || position.column < 0 || position.column >= term.cols || position.row < 0 || position.row >= term.rows) return;
    const line = term.buffer.active.getLine(term.buffer.active.viewportY + position.row);
    let left = position.column;
    if (line?.getCell(left)?.getWidth() === 0 && left > 0) left--;
    const right = Math.min(term.cols, left + (line?.getCell(left)?.getWidth() || 1));
    gesture = { down: event, target: event.target ?? element, left, right, row: position.row, dragging: false, nearBottom: false };
    event.preventDefault();
    event.stopImmediatePropagation();
    term.focus();
  };
  const move = (event: MouseEvent) => {
    if (!gesture || !(event.buttons & 1)) return;
    const position = coords(event);
    if (!position) return;
    if (gesture.dragging) {
      const bottom = position.row >= term.rows - 1;
      if (bottom && !gesture.nearBottom) doc.dispatchEvent(at("mousemove", event, position.column, term.rows - 2));
      gesture.nearBottom = bottom;
      return;
    }
    const dx = event.clientX - gesture.down.clientX;
    const dy = event.clientY - gesture.down.clientY;
    if (dx * dx + dy * dy < 16) return;
    gesture.dragging = true;
    const up = position.row < gesture.row || (position.row === gesture.row && position.column < gesture.left);
    replay(gesture.target, at("mousedown", event, up ? gesture.right : gesture.left, gesture.row));
    // xterm reports the drag from the press on, this move included.
    doc.dispatchEvent(clone("mousemove", event));
  };
  const up = (event: MouseEvent) => {
    if (replaying || event.button !== 0 || !gesture) return;
    const current = gesture;
    gesture = undefined;
    // xterm reports a drag's release to Codex.
    if (current.dragging) return;
    event.stopImmediatePropagation();
    replay(current.target, clone("mousedown", current.down));
    replay(current.target, clone("mouseup", event));
  };
  const forget = () => { gesture = undefined; };
  const resize = term.onResize(forget);
  const bufferChange = term.buffer.onBufferChange(forget);
  element.addEventListener("mousedown", down, true);
  doc.addEventListener("mousemove", move, true);
  doc.addEventListener("mouseup", up, true);
  return { dispose() {
    forget();
    resize.dispose();
    bufferChange.dispose();
    element.removeEventListener("mousedown", down, true);
    doc.removeEventListener("mousemove", move, true);
    doc.removeEventListener("mouseup", up, true);
  } };
}
