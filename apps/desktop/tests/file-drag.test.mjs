import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const exec = promisify(execFile);
test("macOS file promise downloads only on fulfillment and preserves existing files", { skip: process.platform !== "darwin" }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "termany-drag-test-"));
  const executable = path.join(dir, "promise-test");
  const content = Buffer.from([0, 255, 13, 10, 128]);
  let requests = 0;
  const server = createServer((req, res) => {
    requests++;
    if (req.url === "/error") { res.writeHead(500).end("SSH failed"); return; }
    res.writeHead(200, { "Content-Length": content.length });
    res.end(content);
  });
  try {
    execFileSync("xcrun", ["clang", "-fobjc-arc", "-fblocks", "-Wno-deprecated-declarations",
      "-framework", "AppKit", "-framework", "CoreServices",
      fileURLToPath(new URL("./file-drag.m", import.meta.url)), "-o", executable]);
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    const destination = path.join(dir, "report 雪.bin");
    await exec(executable, [url, destination, "cancel"]);
    assert.equal(requests, 0, "cancelled drag must not request file bytes");
    await assert.rejects(readFile(destination), { code: "ENOENT" });
    await exec(executable, [url, destination, "drop"]);
    assert.equal(requests, 1);
    assert.deepEqual(await readFile(destination), content);
    await writeFile(destination, "keep existing");
    await assert.rejects(exec(executable, [url, destination, "drop"]), error => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /file drag write failed: NSCocoaErrorDomain/);
      return true;
    });
    assert.equal(await readFile(destination, "utf8"), "keep existing");
    const failedDestination = path.join(dir, "failed.bin");
    await assert.rejects(exec(executable, [`${url}/error`, failedDestination, "drop"]), error => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /file drag download failed: HTTP 500, TermanyFileDrag \(500\)/);
      assert.match(error.stderr, /completion: .*HTTP 500/);
      return true;
    });
    await assert.rejects(readFile(failedDestination), { code: "ENOENT" });
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
