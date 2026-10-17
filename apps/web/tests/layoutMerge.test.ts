import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { layoutHasPage, mergeLayout, stepWorkspace } from "../src/state/layoutMerge";
import type { TreeNode, Workspace } from "../src/state/store";

const page = (id: string, title = id, children: TreeNode[] = []): TreeNode => ({
  id,
  title,
  expanded: true,
  children,
  htabs: [],
  activeHTab: "",
});

const ws = (id: string, roots: TreeNode[]): Workspace => ({ id, title: id, roots });

const titles = (workspaces: Workspace[]) =>
  workspaces.map((w) => [w.id, w.roots.map((r) => r.title)] as const);

describe("mergeLayout", () => {
  it("keeps our copy of the page we own and takes theirs for everything else", () => {
    const local = ws("w", [page("a", "ours-edited"), page("b", "stale")]);
    const remote = ws("w", [page("a", "their-stale-copy"), page("b", "their-fresh-copy")]);
    assert.deepEqual(titles(mergeLayout([local], [remote], "a")), [
      ["w", ["ours-edited", "their-fresh-copy"]],
    ]);
  });

  it("grafts our page back in place when it's nested", () => {
    const local = ws("w", [page("root", "root", [page("mine", "ours-edited")])]);
    const remote = ws("w", [page("root", "root-renamed", [page("mine", "theirs")])]);
    const merged = mergeLayout([local], [remote], "mine");
    assert.equal(merged[0].roots[0].title, "root-renamed");
    assert.equal(merged[0].roots[0].children[0].title, "ours-edited");
  });

  it("keeps our whole workspace when the sender has never heard of our page", () => {
    // We just created it, so their tree is provably behind ours — taking it
    // would drop a page that exists nowhere else yet.
    const local = ws("w", [page("known"), page("brand-new")]);
    const remote = ws("w", [page("known")]);
    assert.deepEqual(titles(mergeLayout([local], [remote], "brand-new")), [
      ["w", ["known", "brand-new"]],
    ]);
  });

  it("re-adds a workspace the sender doesn't have at all", () => {
    const merged = mergeLayout([ws("mine", [page("p")])], [ws("theirs", [page("q")])], "p");
    assert.deepEqual(
      merged.map((w) => w.id),
      ["theirs", "mine"]
    );
  });

  it("survives an empty snapshot rather than blanking the window", () => {
    const merged = mergeLayout([ws("w", [page("mine")])], [], "mine");
    assert.deepEqual(titles(merged), [["w", ["mine"]]]);
  });

  it("takes the snapshot wholesale when we own no page in it", () => {
    const remote = [ws("w", [page("x")])];
    assert.equal(mergeLayout([ws("w", [page("gone")])], remote, "missing"), remote);
    assert.equal(mergeLayout([ws("w", [page("gone")])], remote, ""), remote);
  });

  it("leaves other windows' workspaces untouched", () => {
    const local = [ws("w1", [page("mine", "ours")]), ws("w2", [page("other", "stale")])];
    const remote = [ws("w1", [page("mine", "theirs")]), ws("w2", [page("other", "fresh")])];
    assert.deepEqual(titles(mergeLayout(local, remote, "mine")), [
      ["w1", ["ours"]],
      ["w2", ["fresh"]],
    ]);
  });
});

describe("layoutHasPage", () => {
  const layout = [ws("w", [page("root", "root", [page("child")])])];
  it("finds pages at any depth", () => {
    assert.equal(layoutHasPage(layout, "root"), true);
    assert.equal(layoutHasPage(layout, "child"), true);
  });
  it("reports a page another window deleted as gone", () => {
    assert.equal(layoutHasPage(layout, "removed"), false);
  });
});

describe("stepWorkspace", () => {
  const cursor = (activeWorkspace: string) => ({
    workspaces: [{ id: "a" }, { id: "b" }, { id: "c" }],
    activeWorkspace,
  });

  it("advances and wraps around in both directions", () => {
    assert.equal(stepWorkspace(cursor("a"), 1), "b");
    assert.equal(stepWorkspace(cursor("c"), 1), "a");
    assert.equal(stepWorkspace(cursor("a"), -1), "c");
    assert.equal(stepWorkspace(cursor("b"), -1), "a");
  });

  it("lands on the first workspace when the active one is no longer listed", () => {
    assert.equal(stepWorkspace(cursor("deleted"), 1), "a");
  });

  it("has nowhere to go with no workspaces at all", () => {
    assert.equal(stepWorkspace({ workspaces: [], activeWorkspace: "a" }, 1), "a");
  });
});

it("restores retired conversation panes as terminals without changing pane IDs", async () => {
  const { restoreTerminalViews } = await import("../src/state/layoutMerge");
  const workspace = {
    id: "workspace", title: "Workspace", roots: [{
      ...page("page"), htabs: [{
        id: "tab", title: "Tab", focused: "chat",
        layout: { kind: "leaf", id: "chat", title: "Previous conversation", view: "agent" },
      }],
    }],
  } as unknown as Workspace;
  const restored = restoreTerminalViews([workspace])[0].roots[0].htabs[0];
  assert.equal(restored.layout.kind === "leaf" && restored.layout.view, "terminal");
  assert.equal(restored.layout.id, "chat");
  assert.equal(restored.focused, "chat");
});
