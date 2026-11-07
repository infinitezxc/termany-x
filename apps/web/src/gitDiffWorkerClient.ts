import type { GitDiffRequest, GitDiffResponse } from "./fileGitDiff";

type WorkerPort = Pick<Worker, "onmessage" | "onerror" | "onmessageerror" | "postMessage" | "terminate">;
type Job = {
  owner: object;
  request: GitDiffRequest;
  resolve: (lines: number[] | undefined) => void;
};

/** One in-flight job and at most one queued job per editor. Text is only
 * posted when the worker is ready, so obsolete edits never build up there. */
export class GitDiffWorkerClient {
  private worker: WorkerPort | undefined;
  private running: Job | undefined;
  private queued = new Map<object, Job>();
  private nextId = 0;
  private deadline: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly createWorker: () => WorkerPort) {}

  request(owner: object, base: string, current: string): Promise<number[] | undefined> {
    this.cancel(owner);
    return new Promise((resolve) => {
      this.queued.set(owner, { owner, request: { id: ++this.nextId, base, current }, resolve });
      this.pump();
    });
  }

  cancel(owner: object) {
    this.queued.get(owner)?.resolve(undefined);
    this.queued.delete(owner);
    // Let a running bounded diff finish so other editors can share the worker.
    // Resolve early, release this editor's callback, and ignore its late result.
    if (this.running?.owner === owner) {
      this.running.resolve(undefined);
      this.running.resolve = () => {};
    }
  }

  private pump() {
    if (this.running || !this.queued.size) return;
    try {
      if (!this.worker) {
        const worker = this.createWorker();
        this.worker = worker;
        worker.onmessage = ({ data }: MessageEvent<GitDiffResponse>) => {
          if (this.worker !== worker || data.id !== this.running?.request.id) return;
          clearTimeout(this.deadline);
          const job = this.running;
          this.running = undefined;
          job.resolve(data.lines);
          this.pump();
        };
        worker.onerror = worker.onmessageerror = () => {
          if (this.worker === worker) this.dispose();
        };
      }
      const job = this.queued.values().next().value!;
      this.queued.delete(job.owner);
      this.running = job;
      // Also recover from a worker that never responds (startup failure/hang).
      this.deadline = setTimeout(() => this.dispose(), 3000);
      this.worker.postMessage(job.request);
    } catch {
      this.dispose();
    }
  }

  dispose() {
    clearTimeout(this.deadline);
    this.worker?.terminate();
    this.worker = undefined;
    this.running?.resolve(undefined);
    this.running = undefined;
    for (const job of this.queued.values()) job.resolve(undefined);
    this.queued.clear();
  }
}

export const sharedGitDiffWorker = new GitDiffWorkerClient(
  () => new Worker(new URL("./fileGitDiff.worker.ts", import.meta.url), { type: "module" }),
);
if (import.meta.hot) import.meta.hot.dispose(() => sharedGitDiffWorker.dispose());
