import assert from "node:assert/strict";
import test from "node:test";
import type { Pane, Workspace } from "./state/store";
import { tmuxPrestartTargets } from "./tmuxPrestartTargets";

const leaf = (id: string, extra: Partial<Pane & { kind: "leaf" }> = {}): Pane => ({ kind: "leaf", id, title: id, ...extra });
const tmux = { sshTarget: "dev", tmuxSession: "$1" };

function workspace(pages: { id: string; layout: Pane; maximized?: string }[]): Workspace {
  return {
    id: "ws",
    title: "ws",
    roots: pages.map((p) => ({
      id: p.id, title: p.id, expanded: true, children: [], activeHTab: "t",
      htabs: [{ id: `${p.id}-t`, title: "t", layout: p.layout, focused: "a", maximized: p.maximized }],
    })),
  };
}

test("only tmux terminal panes are prestarted, sized by their split share", () => {
  const layout: Pane = {
    kind: "split", dir: "row", sizes: [0.25, 0.75],
    children: [
      leaf("a", tmux),
      { kind: "split", dir: "col", children: [leaf("b", tmux), leaf("c", { sshTarget: "dev" })] },
    ],
  };
  const targets = tmuxPrestartTargets([workspace([{ id: "p", layout }])], new Set());
  assert.deepEqual(targets.map((t) => [t.paneId, t.width, t.height]), [["a", 0.25, 1], ["b", 0.75, 0.5]]);
});

test("pages another window holds, and non-terminal views, are skipped", () => {
  const ws = workspace([
    { id: "mine", layout: leaf("a", { ...tmux, view: "files" }) },
    { id: "theirs", layout: leaf("b", tmux) },
  ]);
  assert.deepEqual(tmuxPrestartTargets([ws], new Set(["theirs"])), []);
});

test("a maximized pane fills its tab", () => {
  const layout: Pane = { kind: "split", dir: "row", children: [leaf("a", tmux), leaf("b")] };
  const [target] = tmuxPrestartTargets([workspace([{ id: "p", layout, maximized: "a" }])], new Set());
  assert.equal(target.width, 1);
  assert.equal(target.height, 1);
});
