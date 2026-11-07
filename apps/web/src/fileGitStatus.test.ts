import assert from "node:assert/strict";
import test from "node:test";
import { fileGitBadge, folderGitStatuses } from "./fileGitStatus";

test("file badges distinguish staged, unstaged, untracked and conflicts", () => {
  assert.equal(fileGitBadge(undefined), null);
  assert.equal(fileGitBadge("  "), null);
  assert.equal(fileGitBadge("M ")?.title, "Git — Staged: Modified");
  assert.equal(fileGitBadge(" M")?.title, "Git — Unstaged: Modified");
  assert.deepEqual(fileGitBadge("AM"), {
    text: "M", title: "Git — Staged: Added; Unstaged: Modified", tone: "modified",
  });
  assert.equal(fileGitBadge("??")?.title, "Git: Untracked");
  assert.equal(fileGitBadge("R ")?.title, "Git — Staged: Renamed");
  assert.equal(fileGitBadge(" D")?.tone, "deleted");
  for (const status of ["DD", "AU", "UD", "UA", "DU", "AA", "UU"]) {
    assert.equal(fileGitBadge(status)?.title, "Git: Merge conflict");
  }
});

test("VS Code letters and colors distinguish untracked, renamed, added and conflicting files", () => {
  assert.equal(fileGitBadge("??")?.text, "U");
  assert.equal(fileGitBadge("??")?.tone, "untracked");
  assert.equal(fileGitBadge("UU")?.text, "!");
  assert.equal(fileGitBadge("R ")?.tone, "renamed");
  assert.equal(fileGitBadge("A ")?.tone, "added");
  assert.equal(fileGitBadge("MM")?.text, "M");
});

test("ancestor folders inherit changes even when collapsed, without matching sibling prefixes", () => {
  const statuses = {
    "/repo/src/deep/new.txt": "??",
    "/repo/src/modified.txt": " M",
    "/repo/src/conflict.txt": "UU",
    "/repo/src-other/new.txt": "A ",
    "/repo/deleted/gone.txt": " D",
  };
  const folders = folderGitStatuses(statuses);
  assert.equal(folders["/repo/src/deep"], "??");
  assert.equal(folders["/repo/src"], "UU");
  assert.equal(folders["/repo"], "UU");
  assert.equal(folders["/repo/src-other"], "A ");
  assert.equal(folders["/repo/deleted"], " D");
  assert.equal(folders["/repo/src/deep/new.txt"], undefined);
  assert.deepEqual(folderGitStatuses(Object.fromEntries(Object.entries(statuses).reverse())), folders);
  assert.equal(Object.keys(folderGitStatuses({})).length, 0);
});
