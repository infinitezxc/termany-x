import assert from "node:assert/strict";
import test from "node:test";
import { GitDiffWorkerClient } from "./gitDiffWorkerClient";
import type { GitDiffRequest } from "./fileGitDiff";

class FakeWorker {
  onmessage: Worker["onmessage"] = null;
  onerror: Worker["onerror"] = null;
  onmessageerror: Worker["onmessageerror"] = null;
  posted: GitDiffRequest[] = [];
  terminated = false;
  postMessage(request: GitDiffRequest) { this.posted.push(request); }
  terminate() { this.terminated = true; }
  reply(id: number, lines: number[]) {
    this.onmessage?.call(this as unknown as Worker, { data: { id, lines } } as MessageEvent);
  }
  fail() { this.onerror?.call(this as unknown as Worker, {} as ErrorEvent); }
}

test("one lazy worker serves editors and replaces obsolete queued text", async (t) => {
  const workers: FakeWorker[] = [];
  const client = new GitDiffWorkerClient(() => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker;
  });
  t.after(() => client.dispose());
  assert.equal(workers.length, 0);
  const first = {};
  const second = {};
  const a = client.request(first, "base", "first");
  const old = client.request(second, "base", "obsolete");
  const latest = client.request(second, "base", "latest");
  assert.equal(await old, undefined);
  assert.equal(workers.length, 1);
  assert.deepEqual(workers[0].posted.map((job) => job.current), ["first"]);
  workers[0].reply(workers[0].posted[0].id, [1]);
  assert.deepEqual(await a, [1]);
  assert.deepEqual(workers[0].posted.map((job) => job.current), ["first", "latest"]);
  workers[0].reply(workers[0].posted[1].id, [2]);
  assert.deepEqual(await latest, [2]);
});

test("cancelled editors and late replies cannot consume a newer result", async (t) => {
  const worker = new FakeWorker();
  const client = new GitDiffWorkerClient(() => worker);
  t.after(() => client.dispose());
  const owner = {};
  const old = client.request(owner, "base", "old");
  client.cancel(owner);
  assert.equal(await old, undefined);
  const latest = client.request(owner, "base", "new");
  worker.reply(worker.posted[0].id, [99]);
  let settled = false;
  void latest.then(() => { settled = true; });
  worker.reply(worker.posted[0].id, [99]);
  await Promise.resolve();
  assert.equal(settled, false);
  worker.reply(worker.posted[1].id, [1]);
  assert.deepEqual(await latest, [1]);
});

test("worker failure releases pending requests and next request recreates it", async (t) => {
  const workers: FakeWorker[] = [];
  const client = new GitDiffWorkerClient(() => {
    const worker = new FakeWorker(); workers.push(worker); return worker;
  });
  t.after(() => client.dispose());
  const a = client.request({}, "base", "a");
  const b = client.request({}, "base", "b");
  workers[0].fail();
  assert.deepEqual(await Promise.all([a, b]), [undefined, undefined]);
  assert.equal(workers[0].terminated, true);
  const recovered = client.request({}, "base", "c");
  assert.equal(workers.length, 2);
  workers[0].reply(workers[0].posted[0].id, [99]);
  workers[1].reply(workers[1].posted[0].id, [3]);
  assert.deepEqual(await recovered, [3]);
});

test("worker startup failures and hangs resolve as unavailable", async (t) => {
  const broken = new GitDiffWorkerClient(() => { throw new Error("Worker unavailable"); });
  assert.equal(await broken.request({}, "base", "text"), undefined);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const worker = new FakeWorker();
  const client = new GitDiffWorkerClient(() => worker);
  t.after(() => client.dispose());
  const pending = client.request({}, "base", "text");
  t.mock.timers.tick(3000);
  assert.equal(await pending, undefined);
  assert.equal(worker.terminated, true);
});
