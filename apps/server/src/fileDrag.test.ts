import assert from "node:assert/strict";
import { test } from "node:test";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { verifyFileSize } from "./fileDrag.js";

async function transfer(chunks: Buffer[], size: number) {
  const output: Buffer[] = [];
  await pipeline(Readable.from(chunks), verifyFileSize(size), new Writable({
    write(chunk, _encoding, callback) { output.push(chunk); callback(); },
  }));
  return Buffer.concat(output);
}

test("downloads preserve binary bytes across chunks, including empty files", async () => {
  const bytes = Buffer.from([0, 255, 13, 10, 128]);
  assert.deepEqual(await transfer([bytes.subarray(0, 2), bytes.subarray(2)], bytes.length), bytes);
  assert.deepEqual(await transfer([], 0), Buffer.alloc(0));
});

test("truncated or growing SSH files fail instead of silently succeeding", async () => {
  await assert.rejects(transfer([Buffer.from("ab")], 3), /incomplete/);
  await assert.rejects(transfer([Buffer.from("abcd")], 3), /changed/);
});
