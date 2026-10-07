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

// sshd caps the sessions on one connection (MaxSessions, default 10) and the
// pane's interactive shell already holds one. Every other channel Termany opens
// over a pane's master — file and git commands, the port probe, media streams —
// takes a slot here first, so a burst queues instead of being refused (and the
// master printing "channel N: open failed" into the terminal for each refusal).
// Streams get a smaller share: a <video> the browser parks keeps its channel
// for minutes, and must not starve the file tree.
const MAX_CHANNELS = 8;
const MAX_STREAMS = 4;

/** How long a killed client's session may outlive it on the host: the
 *  remoteDeadline watchdog started later than the local timer and polls once a
 *  second, so it fires a little after the local timeout. */
export const REMOTE_DEADLINE_GRACE_MS = 3_000;

export interface ChannelSlot {
  /** Give the slot back, optionally only after `afterMs` (see REMOTE_DEADLINE_GRACE_MS). */
  release(afterMs?: number): void;
}

interface ChannelBudget {
  channels: number;
  streams: number;
  waiting: { stream: boolean; grant: () => void }[];
}

const budgets = new Map<string, ChannelBudget>();

function fits(budget: ChannelBudget, stream: boolean): boolean {
  return budget.channels < MAX_CHANNELS && (!stream || budget.streams < MAX_STREAMS);
}

function take(budget: ChannelBudget, stream: boolean): void {
  budget.channels++;
  if (stream) budget.streams++;
}

function pump(key: string, budget: ChannelBudget): void {
  for (let i = 0; i < budget.waiting.length; ) {
    const waiter = budget.waiting[i];
    if (!fits(budget, waiter.stream)) {
      i++;
      continue;
    }
    budget.waiting.splice(i, 1);
    take(budget, waiter.stream);
    waiter.grant();
  }
  if (budget.channels === 0 && budget.waiting.length === 0) budgets.delete(key);
}

/**
 * Wait for a free channel on the connection `sshArgs` multiplexes over. A
 * queued request whose `signal` aborts (the HTTP client went away) leaves the
 * queue and rejects.
 */
export function acquireChannel(
  sshArgs: string[],
  options: { stream?: boolean; signal?: AbortSignal } = {},
): Promise<ChannelSlot> {
  const key = sshArgs.join("\0");
  const stream = options.stream ?? false;
  let budget = budgets.get(key);
  if (!budget) budgets.set(key, (budget = { channels: 0, streams: 0, waiting: [] }));
  const owner = budget;
  let released = false;
  const slot: ChannelSlot = {
    release(afterMs = 0) {
      if (released) return;
      released = true;
      const free = () => {
        owner.channels--;
        if (stream) owner.streams--;
        pump(key, owner);
      };
      if (afterMs > 0) setTimeout(free, afterMs).unref();
      else free();
    },
  };
  if (options.signal?.aborted) return Promise.reject(new Error("request aborted"));
  if (fits(owner, stream)) {
    take(owner, stream);
    return Promise.resolve(slot);
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      const index = owner.waiting.indexOf(waiter);
      if (index >= 0) owner.waiting.splice(index, 1);
      pump(key, owner);
      reject(new Error("request aborted"));
    };
    const waiter = {
      stream,
      grant: () => {
        options.signal?.removeEventListener("abort", onAbort);
        resolve(slot);
      },
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    owner.waiting.push(waiter);
  });
}
