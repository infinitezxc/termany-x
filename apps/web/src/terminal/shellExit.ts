import type { ShellExit } from "@termany/core";

/**
 * How long a shell has to survive before we believe it started successfully.
 * Under this, a death is a launch failure (bad rc file, missing binary) rather
 * than anything the user did.
 */
export const RESTART_HEALTHY_MS = 3000;

/**
 * Cap on consecutive fast respawns, so a shell that dies on every launch can't
 * spin forever. Reset once a shell lives past RESTART_HEALTHY_MS, which keeps
 * the cap meaning "5 failures in a row" rather than "5 ever".
 */
export const MAX_AUTO_RESTARTS = 5;

export type ShellExitDisposition = "close-pane" | "restart";

/**
 * Decide what a dead shell should do to its pane.
 *
 * Every mainstream terminal closes the pane when its shell exits, and that is
 * what a user pressing Ctrl+D is asking for. Respawning in place (what this app
 * did unconditionally before) makes the pane un-closable from the keyboard and
 * surprises anyone with terminal muscle memory.
 *
 * The tempting test — "exit code 0 means the user meant it" — does not work:
 * both bash and zsh exit with the LAST COMMAND'S status on EOF, so Ctrl+D after
 * a `grep` that matched nothing arrives as code 1. Judging by exit code alone
 * would respawn exactly the pane the user just asked to close.
 *
 * So the signal we key on is *how* the shell died, not what it returned:
 *
 *   - killed by a signal (segfault, OOM, `kill -9`) -> never user intent
 *   - dead within RESTART_HEALTHY_MS of spawning    -> launch failure, not intent
 *   - anything else                                 -> it ran, then ended on its
 *                                                      own, i.e. the user did it
 *
 * `exit` being undefined means the socket closed without the server saying how
 * (its own shutdown, a newer connection displacing this one, an older server).
 * Closing a pane is destructive and irreversible, so it needs positive
 * evidence — without any, fall back to the historical restart behaviour.
 */
export function shellExitDisposition(
  exit: ShellExit | undefined,
  aliveMs: number
): ShellExitDisposition {
  if (!exit) return "restart";
  if (exit.signal) return "restart"; // 0/undefined == "not signalled"
  if (aliveMs <= RESTART_HEALTHY_MS) return "restart";
  return "close-pane";
}

/**
 * OpenSSH's own exit status for "the connection failed or dropped" — distinct
 * from the remote shell's status, which ssh otherwise passes straight through.
 */
const SSH_CONNECTION_LOST = 255;

export type SshExitDisposition = "go-local" | "reconnect";

/**
 * Decide what an SSH pane does when its `ssh` process ends.
 *
 * The remote shell ending on its own (`exit`, Ctrl+D) means the user is done
 * with the host, so the pane drops back to a local shell. A dropped link — Wi-Fi
 * change, sleep, the host closing it — must NOT do that: every pane on that
 * host dies at once, and silently turning them all into local shells loses the
 * whole remote layout. Those stay SSH panes and wait for Enter to reconnect.
 *
 * The remote status is passed through by ssh, so — as with local shells (see
 * `shellExitDisposition`) — any ordinary code is a deliberate exit; only 255,
 * a signal, or no exit report at all points at the connection.
 */
export function sshExitDisposition(exit: ShellExit | undefined): SshExitDisposition {
  if (!exit) return "reconnect";
  if (exit.signal) return "reconnect";
  if (exit.exitCode === SSH_CONNECTION_LOST) return "reconnect";
  return "go-local";
}
