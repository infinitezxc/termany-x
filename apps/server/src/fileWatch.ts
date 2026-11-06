import fs from "node:fs";
import path from "node:path";

/** What counts as "the file changed": a new mtime or size, or a new inode
 *  (an editor or agent that saves by writing a temp file and renaming it).
 *  Follows symlinks, so a link's target changing counts too. */
function signature(file: string): string {
  try {
    const st = fs.statSync(file);
    return `${st.mtimeMs} ${st.size} ${st.ino}`;
  } catch {
    return "missing";
  }
}

/** Where `file`'s content actually lives — itself unless it's a symlink;
 *  null while that can't be resolved (a dangling link, a missing file). */
function target(file: string): string | null {
  try {
    return fs.realpathSync(file);
  } catch {
    return null;
  }
}

/**
 * Call `onChange` whenever the local `file` changes, until the returned stop
 * function runs. Watches the file's directory rather than the file itself:
 * a watch on the file dies with the inode a save-by-rename replaces. A
 * symlink's target's directory is watched as well (it's usually somewhere
 * else), and re-resolved on every change in case the link was repointed;
 * while it dangles, the last target's directory stays watched, so the
 * target being recreated there is noticed.
 * Events come in bursts (one save is often several), and some are for other
 * entries in the same directory, so each burst is settled for a moment and
 * then checked against the file's stat signature before it counts. Where the
 * OS can't watch a directory, falls back to polling the file once a second.
 */
export function watchLocalFile(file: string, onChange: () => void, settleMs = 60): () => void {
  const abs = path.resolve(file);
  let last = signature(abs);
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;

  // One watcher per directory, each with the entry names in it that matter.
  let watchers = new Map<string, { watcher: fs.FSWatcher; names: Set<string> }>();
  let polling = false;
  let watchedTarget = "";

  const poll = () => {
    if (polling || stopped) return;
    polling = true;
    fs.watchFile(abs, { interval: 1000 }, schedule);
  };

  const rewatch = () => {
    const real = target(abs) ?? (watchedTarget || abs);
    if (real === watchedTarget) return;
    watchedTarget = real;
    const wanted = new Map<string, Set<string>>();
    for (const p of new Set([abs, real])) {
      const dir = path.dirname(p);
      if (!wanted.has(dir)) wanted.set(dir, new Set());
      wanted.get(dir)!.add(path.basename(p));
    }
    const next = new Map<string, { watcher: fs.FSWatcher; names: Set<string> }>();
    for (const [dir, names] of wanted) {
      const existing = watchers.get(dir);
      if (existing) {
        existing.names = names;
        next.set(dir, existing);
        watchers.delete(dir);
        continue;
      }
      try {
        const entry = {
          names,
          watcher: fs.watch(dir, { persistent: false }, (_event, changed) => {
            // Some platforms leave the name out; then any event is worth a check.
            if (!changed || entry.names.has(changed.toString())) schedule();
          }),
        };
        entry.watcher.on("error", poll);
        next.set(dir, entry);
      } catch {
        poll();
      }
    }
    for (const { watcher } of watchers.values()) watcher.close();
    watchers = next;
  };

  const check = () => {
    timer = undefined;
    if (stopped) return;
    rewatch();
    const next = signature(abs);
    if (next === last) return;
    last = next;
    onChange();
  };
  function schedule() {
    if (!timer && !stopped) timer = setTimeout(check, settleMs);
  }

  rewatch();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    for (const { watcher } of watchers.values()) watcher.close();
    watchers.clear();
    if (polling) fs.unwatchFile(abs, schedule);
  };
}
