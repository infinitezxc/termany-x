import { Transform } from "node:stream";

/** Fail truncated SSH downloads instead of delivering a successful partial file. */
export function verifyFileSize(expected: number): Transform {
  let received = 0;
  return new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length;
      callback(received > expected ? new Error("SSH file changed during download") : null, chunk);
    },
    flush(callback) {
      callback(received === expected ? null : new Error("SSH file transfer was incomplete"));
    },
  });
}
