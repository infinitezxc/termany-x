/**
 * The PTY's foreground process group: the signal iTerm2 reads to put a job
 * name on a tab, and the only one that answers "is something still running?"
 * without reading the screen. node-pty surfaces it as `IPty.process`, which
 * resolves tcgetpgrp() on the master fd to a process name.
 *
 * It cannot say *what* is running. Claude Code reports as "2.1.220" here,
 * because a version string is what it sets its process title to. So nothing
 * in this module tries to recognize an agent; the only comparison worth
 * making is against the name the session's own shell answers to, and
 * everything else is simply "a job".
 *
 * Two shapes report a job that never moves, and both have to stay harmless:
 * Windows conpty reports the shell for the life of the session, and an ssh
 * session's local foreground job is `ssh` no matter what runs at the far end.
 * Callers must therefore act on the away-and-back transition rather than on
 * the standing value, so that a job which never leaves the shell concludes
 * nothing at all.
 */

/** "/bin/zsh", "-zsh" and "zsh" are one shell; a login shell adds the dash. */
export function normalizeJobName(raw: string): string {
  // node-pty types the job as a string and still returns null while a process
  // group changes hands, so nothing read from it can be trusted to be one.
  const trimmed = String(raw ?? "").trim();
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  const base = cut < 0 ? trimmed : trimmed.slice(cut + 1);
  return base.startsWith("-") ? base.slice(1) : base;
}

/**
 * Whether the terminal currently belongs to the session's own shell.
 *
 * Compared against the name the shell answers to, not the command it was
 * spawned from: on macOS `/bin/sh` reports itself as "bash", so the spawn
 * argument is not a stand-in for it. Callers learn the name by reading the
 * job once the shell's first output settles, when nothing else can be running.
 */
export function foregroundJobIsShell(job: string, shellJob: string): boolean {
  const shell = normalizeJobName(shellJob);
  return shell.length > 0 && normalizeJobName(job) === shell;
}

/** How long output must stop before the foreground job is worth reading. */
export const JOB_SETTLE_MS = 150;

/**
 * Read the job once output settles, in addition to periodic reconciliation.
 *
 * Output usually accompanies a process taking or releasing the terminal, so
 * sampling after it settles provides a prompt response. Periodic checks cover
 * silent exits and continuous output that never settles. Trailing rather than
 * leading, because the sample that matters most is
 * the one after the *last* chunk of a turn: an agent that exits may print
 * nothing further, and a throttle that had just fired would miss it.
 */
export function sampleOnceOutputSettles(
  read: () => void,
  settleMs: number = JOB_SETTLE_MS,
): { noteOutput: () => void; dispose: () => void } {
  let timer: NodeJS.Timeout | null = null;
  return {
    noteOutput() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        read();
      }, settleMs);
      timer.unref?.();
    },
    dispose() {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
