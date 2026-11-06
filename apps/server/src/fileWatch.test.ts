import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { watchLocalFile } from "./fileWatch.js";

async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("local watch reports writes, save-by-rename and deletion, but not neighbours", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "termany-watch-"));
  const file = path.join(dir, "watched.txt");
  writeFileSync(file, "one");
  let changes = 0;
  const stop = watchLocalFile(file, () => changes++);
  try {
    writeFileSync(path.join(dir, "other.txt"), "noise");
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(changes, 0);

    writeFileSync(file, "two");
    await until(() => changes === 1, "a write");

    writeFileSync(path.join(dir, "tmp"), "three");
    renameSync(path.join(dir, "tmp"), file);
    await until(() => changes === 2, "a save-by-rename");

    rmSync(file);
    await until(() => changes === 3, "a deletion");
  } finally {
    stop();
    rmSync(dir, { recursive: true, force: true });
  }
  // Nothing after stopping.
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(changes, 3);
});

test("local watch follows a symlink to a target elsewhere, and its repointing", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "termany-watch-"));
  mkdirSync(path.join(root, "a"));
  mkdirSync(path.join(root, "b"));
  const target = path.join(root, "b", "real.txt");
  const other = path.join(root, "b", "other.txt");
  writeFileSync(target, "one");
  writeFileSync(other, "elsewhere");
  const link = path.join(root, "a", "link.txt");
  symlinkSync(target, link);
  let changes = 0;
  const stop = watchLocalFile(link, () => changes++);
  try {
    // Same size as before, so it needs the mtime to have moved on: the
    // kernel's file timestamps only tick every few milliseconds.
    await new Promise((resolve) => setTimeout(resolve, 50));
    writeFileSync(target, "two");
    await until(() => changes === 1, "a write to the target");

    // Repoint the link: that's a change, and from then on the new target counts.
    rmSync(link);
    symlinkSync(other, link);
    await until(() => changes === 2, "the link being repointed");
    writeFileSync(other, "changed");
    await until(() => changes === 3, "a write to the new target");

    // Delete the target (the link now dangles), then recreate it: both count.
    rmSync(other);
    await until(() => changes === 4, "the target being deleted");
    writeFileSync(other, "back");
    await until(() => changes === 5, "the target being recreated");
  } finally {
    stop();
    rmSync(root, { recursive: true, force: true });
  }
});
