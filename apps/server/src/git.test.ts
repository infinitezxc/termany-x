import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, open, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { gitDiffs } from "./git";

const execFileAsync = promisify(execFile);

test("an untracked diff reads and returns only a bounded file prefix", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "termany-git-diff-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await execFileAsync("git", ["init", "--quiet"], { cwd: root });

  // Sparse growth makes the regression cheap to create: the old readFile()
  // path still had to allocate/read the full 32 MiB, while the bounded reader
  // touches only the prefix the API can actually return.
  const relative = "large-untracked.txt";
  const file = await open(path.join(root, relative), "w");
  await file.write(Buffer.alloc(8192, 0x61), 0, 8192, 0);
  await file.truncate(32 * 1024 * 1024);
  await file.close();

  const diffs = await gitDiffs({
    cwd: root,
    files: [{ path: relative, section: "untracked" }],
  });
  const diff = diffs[`untracked:${relative}`];

  assert.ok(diff);
  assert.equal(diff.truncated, true);
  assert.ok(Buffer.byteLength(diff.diff) <= 512 * 1024);
  assert.match(diff.diff, /^--- \/dev\/null\n\+\+\+ b\/large-untracked\.txt/m);
});

import { mkdir, writeFile } from "node:fs/promises";
import { gitDirectoryLineTotals, gitFileStatuses, withGitHost, type GitHost } from "./git";

test("file-view statuses preserve index/worktree state and exact paths across repos", async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "termany-file-status-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, "repo");
  await mkdir(root);
  const git = (...args: string[]) => execFileAsync("git", args, { cwd: root });
  await git("init", "--quiet");
  await writeFile(path.join(root, "tracked.txt"), "original\n");
  await writeFile(path.join(root, "old.txt"), "renamed contents\n");
  await writeFile(path.join(root, ".gitignore"), "ignored.txt\n");
  await git("add", ".");
  await git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "initial");
  await writeFile(path.join(root, "tracked.txt"), "staged\n");
  await git("add", "tracked.txt");
  await writeFile(path.join(root, "tracked.txt"), "unstaged\n");
  await git("mv", "old.txt", "new name.txt");
  await mkdir(path.join(root, "new dir"));
  const unusual = "new dir/中文\nfile.txt";
  await writeFile(path.join(root, unusual), "new\n");
  await writeFile(path.join(root, "ignored.txt"), "ignored\n");
  const nested = path.join(root, "nested");
  await mkdir(nested);
  await execFileAsync("git", ["init", "--quiet"], { cwd: nested });
  await writeFile(path.join(nested, "fresh.txt"), "fresh\n");
  const statuses = await gitFileStatuses([root, path.join(root, "new dir"), nested, parent]);
  assert.equal(statuses[path.join(root, "tracked.txt")], "MM");
  assert.equal(statuses[path.join(root, "new name.txt")], "R ");
  assert.equal(statuses[path.join(root, "old.txt")], undefined);
  assert.equal(statuses[path.join(root, unusual)], "??");
  assert.equal(statuses[path.join(nested, "fresh.txt")], "??");
  assert.equal(statuses[path.join(root, "ignored.txt")], undefined);
  assert.equal(statuses[path.join(root, ".gitignore")], undefined);
  await git("reset", "--hard", "HEAD");
  const after = await gitFileStatuses([root]);
  assert.equal(after[path.join(root, "tracked.txt")], undefined);
  assert.equal(after[path.join(root, "new name.txt")], undefined);
});

test("file-view statuses use the selected host and query each repository once", async () => {
  let statusesRead = 0;
  const host: GitHost = {
    path: path.posix,
    readHead: async () => null,
    git: async (args, cwd) => {
      if (args[0] === "rev-parse") return "/remote/repo\n" + (cwd.endsWith("/sub") ? "sub/\n" : "\n");
      statusesRead++;
      return "UU conflict.txt\0R  dest.txt\0?? not-a-record.txt\0 D deleted.txt\0";
    },
  };
  const result = await withGitHost(host, () => gitFileStatuses(["/remote/repo", "/remote/repo/sub"]));
  assert.equal(statusesRead, 1);
  assert.deepEqual({ ...result }, {
    "/remote/repo/conflict.txt": "UU",
    "/remote/repo/dest.txt": "R ",
    "/remote/repo/deleted.txt": " D",
  });
});

import { gitFileBase } from "./git";

test("file viewer baseline uses HEAD, handles new/renamed files and ignores non-repo files", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "termany-git-base-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileAsync("git", args, { cwd: root });
  const file = path.join(root, "tracked.txt");
  await writeFile(file, "original\n");
  assert.equal(await gitFileBase(file), null);
  await git("init", "--quiet");
  assert.equal(await gitFileBase(file), "");
  await writeFile(path.join(root, ".gitignore"), "ignored.txt\n");
  await writeFile(path.join(root, "ignored.txt"), "ignored\n");
  await writeFile(path.join(root, "binary"), "binary\0data");
  await git("add", ".");
  await git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "initial");
  await writeFile(file, "staged\n");
  await git("add", "tracked.txt");
  await writeFile(file, "unstaged\n");
  assert.equal(await gitFileBase(file), "original\n");
  assert.equal(await gitFileBase(path.join(root, "ignored.txt")), null);
  assert.equal(await gitFileBase(path.join(root, "binary")), null);
  await git("reset", "--hard", "HEAD");
  await git("mv", "tracked.txt", "renamed.txt");
  assert.equal(await gitFileBase(path.join(root, "renamed.txt")), "original\n");
  await writeFile(path.join(root, "new[1].txt"), "new\n");
  assert.equal(await gitFileBase(path.join(root, "new[1].txt")), "");
});

test("viewer caches reuse immutable blobs, refresh HEAD, isolate hosts, and bound reads", async () => {
  const calls: string[][] = [];
  let head = "a".repeat(40);
  let oid = "b".repeat(40);
  let size = 8;
  let content = "original";
  const selectedHost: GitHost = {
    path: path.posix,
    readHead: async () => null,
    git: async (args) => {
      calls.push(args);
      if (args[1] === "--show-toplevel") return "/repo\n\n";
      if (args[1] === "--verify") return head;
      if (args[0] === "ls-tree") return `100644 blob ${oid} ${size}\tfile.txt\0`;
      if (args[0] === "cat-file") return content;
      throw new Error(`Unexpected Git command: ${args}`);
    },
  };
  const read = () => withGitHost(selectedHost, () => gitFileBase("/repo/file.txt"));
  assert.equal(await read(), "original");
  calls.length = 0;
  assert.equal(await read(), "original");
  assert.deepEqual(calls, [["rev-parse", "--verify", "HEAD"]]);
  head = "c".repeat(40); // another commit, unchanged blob
  calls.length = 0;
  assert.equal(await read(), "original");
  assert.equal(calls.some((args) => args[0] === "cat-file"), false);
  head = "d".repeat(40);
  oid = "e".repeat(40);
  content = "changed";
  assert.equal(await read(), "changed");
  head = "f".repeat(40);
  oid = "1".repeat(40);
  size = 512 * 1024 + 1;
  calls.length = 0;
  assert.equal(await read(), null);
  assert.equal(calls.some((args) => args[0] === "cat-file"), false);
  size = 8;
  content = "other host";
  assert.equal(await withGitHost({ ...selectedHost }, () => gitFileBase("/repo/file.txt")), "other host");
});

test("repository discovery is cached briefly and transport errors remain errors", async (t) => {
  let now = 1000;
  t.mock.method(Date, "now", () => now);
  let discoveries = 0;
  let offline = false;
  const selectedHost: GitHost = {
    path: path.posix,
    readHead: async () => null,
    git: async (args) => {
      if (offline) throw new Error("SSH connection lost");
      if (args[0] === "rev-parse") { discoveries++; return "/repo\n\n"; }
      return " M file.txt\0";
    },
  };
  const read = () => withGitHost(selectedHost, () => gitFileStatuses(["/repo"]));
  await read();
  await read();
  assert.equal(discoveries, 1);
  now += 30_001;
  await read();
  assert.equal(discoveries, 2);
  offline = true;
  await assert.rejects(read(), /SSH connection lost/);
  await assert.rejects(withGitHost({ ...selectedHost }, () => gitFileBase("/repo/file.txt")), /SSH connection lost/);
});

test("missing local directories do not block valid repository badges", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "termany-missing-git-dir-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await execFileAsync("git", ["init", "--quiet"], { cwd: root });
  const stale = path.join(root, "deleted-dir");
  await mkdir(stale);
  await rm(stale, { recursive: true });
  const file = path.join(root, "new.txt");
  await writeFile(file, "new\n");
  for (const directories of [[root, stale], [stale, root]]) {
    assert.equal((await gitFileStatuses(directories))[file], "??");
  }
  // A successful clean status must also win over the stale path's failure.
  await rm(file);
  assert.deepEqual({ ...await gitFileStatuses([root, stale]) }, {});
});

test("SSH cd failures and cached deleted roots do not poison other repositories", async () => {
  let removed = false;
  const selectedHost: GitHost = {
    path: path.posix,
    readHead: async () => null,
    git: async (args, cwd) => {
      if (cwd === "/repo/deleted-dir" || (removed && cwd === "/old-worktree")) {
        throw new Error("remote command exited with code 3: cd: No such file or directory");
      }
      if (args[0] === "rev-parse") return `${cwd}\n\n`;
      return " M file.txt\0";
    },
  };
  const read = (directories: string[]) => withGitHost(selectedHost, () => gitFileStatuses(directories));
  await read(["/old-worktree"]); // populate the directory cache
  removed = true;
  for (const directories of [
    ["/repo", "/repo/deleted-dir", "/old-worktree"],
    ["/old-worktree", "/repo/deleted-dir", "/repo"],
  ]) {
    assert.deepEqual({ ...await read(directories) }, { "/repo/file.txt": " M" });
  }
});

test("a complete directory-discovery failure still reports an outage", async () => {
  const selectedHost: GitHost = {
    path: path.posix,
    readHead: async () => null,
    git: async () => { throw new Error("SSH connection lost"); },
  };
  await assert.rejects(
    withGitHost(selectedHost, () => gitFileStatuses(["/repo", "/repo/sub"])),
    /SSH connection lost/,
  );
});

test("a non-Git directory plus a deleted child is a successful empty result", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "termany-nogit-dir-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const gone = path.join(root, "gone");
  await mkdir(gone);
  await rm(gone, { recursive: true });
  for (const directories of [[root, gone], [gone, root]]) {
    assert.deepEqual({ ...await gitFileStatuses(directories) }, {});
  }
});

test("SSH non-Git directories count as checked despite a deleted child", async () => {
  const selectedHost: GitHost = {
    path: path.posix,
    readHead: async () => null,
    git: async (_args, cwd) => {
      if (cwd === "/nogit") throw new Error("fatal: not a git repository (or any of the parent directories): .git");
      throw new Error("remote command exited with code 3: cd: No such file or directory");
    },
  };
  for (const directories of [["/nogit", "/nogit/gone"], ["/nogit/gone", "/nogit"]]) {
    const statuses = await withGitHost(selectedHost, () => gitFileStatuses(directories));
    assert.deepEqual({ ...statuses }, {});
  }
});

test("folder line totals cover staged and unstaged tracked edits under that folder only", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "termany-line-totals-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileAsync("git", args, { cwd: root });
  await git("init", "--quiet");
  await mkdir(path.join(root, "sub"));
  await writeFile(path.join(root, "top.txt"), "a\nb\n");
  await writeFile(path.join(root, "sub", "inner.txt"), "one\ntwo\nthree\n");
  await git("add", ".");
  // Before the first commit everything staged counts as added.
  assert.deepEqual(await gitDirectoryLineTotals(root), { added: 5, removed: 0 });
  await git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "initial");
  assert.deepEqual(await gitDirectoryLineTotals(root), { added: 0, removed: 0 });
  await writeFile(path.join(root, "top.txt"), "a\nchanged\nnew\n");
  await git("add", "top.txt");
  await writeFile(path.join(root, "sub", "inner.txt"), "one\n");
  await writeFile(path.join(root, "sub", "untracked.txt"), "ignored by totals\n");
  assert.deepEqual(await gitDirectoryLineTotals(root), { added: 2, removed: 3 });
  assert.deepEqual(await gitDirectoryLineTotals(path.join(root, "sub")), { added: 0, removed: 2 });
  assert.equal(await gitDirectoryLineTotals(os.tmpdir()), null);
});
