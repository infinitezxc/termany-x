import assert from "node:assert/strict";
import test from "node:test";
import { acquireChannel, type ChannelSlot } from "./remoteCommand.js";

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("caps channels per connection, with a smaller share for streams", async () => {
  const conn = ["-S", "/tmp/budget-test"];
  const streams: ChannelSlot[] = [];
  for (let i = 0; i < 4; i++) streams.push(await acquireChannel(conn, { stream: true }));

  // Streams are full, but commands still get the remaining channels.
  let fifthStream: ChannelSlot | null = null;
  void acquireChannel(conn, { stream: true }).then((slot) => (fifthStream = slot));
  const commands: ChannelSlot[] = [];
  for (let i = 0; i < 4; i++) commands.push(await acquireChannel(conn));

  // Every channel is taken now: the next command waits.
  let queued: ChannelSlot | null = null;
  void acquireChannel(conn).then((slot) => (queued = slot));
  await tick();
  assert.equal(fifthStream, null);
  assert.equal(queued, null);

  // A freed command channel goes to the waiting command, not the stream.
  commands[0].release();
  await tick();
  assert.ok(queued);
  assert.equal(fifthStream, null);

  streams[0].release();
  streams[0].release(); // idempotent
  await tick();
  assert.ok(fifthStream);

  for (const slot of [...streams.slice(1), ...commands.slice(1), queued!, fifthStream!]) slot.release();
});

test("a queued request leaves the queue when its client goes away", async () => {
  const conn = ["-S", "/tmp/budget-abort"];
  const held: ChannelSlot[] = [];
  for (let i = 0; i < 8; i++) held.push(await acquireChannel(conn));

  const gone = new AbortController();
  const waiting = acquireChannel(conn, { signal: gone.signal });
  gone.abort();
  await assert.rejects(waiting, /aborted/);

  // The aborted waiter did not take the freed channel.
  held[0].release();
  const next = await acquireChannel(conn);
  next.release();
  for (const slot of held.slice(1)) slot.release();
});
