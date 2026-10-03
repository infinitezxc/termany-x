// Command lines for the remote end of an SSH connection. Kept free of app
// state (no db, no config) so the port prober can use it as well as remoteFs.

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Killing the local `ssh` client on a timeout does not stop the remote
 * command: sshd holds its session (one of MaxSessions, default 10) until the
 * process exits, so stranded commands pile up until every new channel is
 * refused — and the pane's master prints "channel N: open failed" into the
 * terminal for each one. The host therefore enforces the same deadline: a
 * quiet watchdog kills the script's process group once it runs `seconds`, and
 * exits within a second of the script finishing. `$$` rather than `$!` keeps
 * the script free of `!`.
 */
export function remoteDeadline(script: string, seconds: number): string {
  return (
    `(i=0; while [ $i -lt ${Math.max(1, Math.ceil(seconds))} ] && kill -0 $$ 2>/dev/null; ` +
    "do sleep 1; i=$((i + 1)); done; kill -0 $$ 2>/dev/null && kill -KILL 0) " +
    "</dev/null >/dev/null 2>&1 & " +
    script
  );
}

/**
 * The remote command line: a fixed `sh -c` script plus quoted arguments, cut
 * off on the host after `timeoutMs` (null for open-ended streams). The remote
 * login shell (which may be fish or csh) only ever sees `exec sh -c '<script>'`.
 */
export function remoteShCommand(script: string, args: string[], timeoutMs: number | null): string {
  const body = timeoutMs === null ? script : remoteDeadline(script, timeoutMs / 1000);
  return ["exec sh -c", shellQuote(body), "termany", ...args.map(shellQuote)].join(" ");
}
