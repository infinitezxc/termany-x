// Run with the web Vite dev server, then open /tests/fixtures/codex-selection.html.
// Real xterm checks the mouse reports Codex receives, which the unit-test fake cannot.
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { installCodexSelection } from "../../src/terminal/codexSelection";

const output = document.querySelector<HTMLPreElement>("#results")!;
const host = document.querySelector<HTMLDivElement>("#terminal")!;
let term: Terminal | undefined;
function check(ok: unknown, message: string) {
  if (!ok) throw new Error(message);
  output.textContent += `PASS ${message}\n`;
}

document.querySelector<HTMLButtonElement>("#run")!.onclick = async () => {
  output.textContent = "";
  term?.dispose();
  host.replaceChildren();
  const terminal = term = new Terminal({ cols: 60, rows: 8, fontSize: 20 });
  terminal.open(host);
  let cleanup: { dispose(): void };
  terminal.loadAddon({ activate: t => { cleanup = installCodexSelection(t, () => true); }, dispose: () => cleanup?.dispose() });
  const write = (text: string) => new Promise<void>(resolve => terminal.write(text, resolve));
  const screen = host.querySelector<HTMLElement>(".xterm-screen")!;
  const mouse = (type: string, column: number, row = 0) => {
    const rect = screen.getBoundingClientRect();
    screen.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0,
      buttons: type === "mouseup" ? 0 : 1, detail: 1,
      clientX: rect.left + rect.width / terminal.cols * column,
      clientY: rect.top + rect.height / terminal.rows * (row + .25) }));
  };
  const sent: string[] = [];
  terminal.onData(d => sent.push(d));
  const reports = () => sent.join("").match(/\x1b\[<\d+;\d+;\d+[Mm]/g)?.join(" ") ?? "";
  try {
    await write("\x1b[?1049h\x1b[?1003h\x1b[?1006h\x1b[H" + Array.from({ length: 8 }, (_, i) => `row ${i}`).join("\r\n"));
    mouse("mousedown", 1.5, 3); mouse("mousemove", 1.5, 5);
    check(!terminal.hasSelection(), "xterm draws no selection on the full-screen view");
    check(reports() === "\x1b[<0;2;4M \x1b[<32;2;6M", `Codex gets the press at the anchor and the drag: ${JSON.stringify(reports())}`);
    sent.length = 0;
    mouse("mousemove", 2.5, 9); mouse("mousemove", 3.5, 9); mouse("mouseup", 3.5, 9);
    check(reports() === "\x1b[<32;3;7M \x1b[<32;3;8M \x1b[<32;4;8M \x1b[<0;4;8m", `past the bottom, Codex's last row comes first: ${JSON.stringify(reports())}`);
    sent.length = 0;
    mouse("mousedown", 1.5, 3); mouse("mousemove", 1.5, 2); mouse("mouseup", 1.5, 2);
    check(reports() === "\x1b[<0;3;4M \x1b[<32;2;3M \x1b[<0;2;3m", `an upward drag starts past the anchor cell: ${JSON.stringify(reports())}`);
    sent.length = 0;
    mouse("mousedown", 1.5, 3); mouse("mouseup", 1.5, 3);
    check(reports() === "\x1b[<0;2;4M \x1b[<0;2;4m", `a click reaches Codex unchanged: ${JSON.stringify(reports())}`);
    output.textContent += "All browser checks passed.\n";
  } catch (error) { output.textContent += `FAIL ${String(error)}\n`; }
};
