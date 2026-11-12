import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { execFile, execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  parseRemoteListeningPorts,
  parseUploadedPath,
  sshUploadControlArgs,
  sshForwardControlArgs,
  sshMasterArgs,
  SshPortForwarding,
} from "./sshPortForwarding.js";

test("parses listening ports from Linux ss", () => {
  const output = [
    "LISTEN 0 4096 127.0.0.1:3000 0.0.0.0:*",
    "LISTEN 0 511 [::]:5173 [::]:*",
    "LISTEN 0 128 0.0.0.0:3000 0.0.0.0:*",
  ].join("\n");
  assert.deepEqual(parseRemoteListeningPorts(output), [3000, 5173]);
});

test("parses the user-scoped lsof output used on macOS remotes", () => {
  assert.deepEqual(
    parseRemoteListeningPorts(
      "node 771 dev 21u IPv6 0x123 0t0 TCP *:3000 (LISTEN)\npython 912 dev 7u IPv4 0x456 0t0 TCP 127.0.0.1:8000 (LISTEN)",
    ),
    [3000, 8000],
  );
});

test("parses listening ports from BSD netstat and ignores connected sockets", () => {
  const output = [
    "tcp4 0 0 127.0.0.1.8000 *.* LISTEN",
    "tcp6 0 0 *.9229 *.* LISTEN",
    "tcp4 0 0 127.0.0.1.55120 127.0.0.1.443 ESTABLISHED",
  ].join("\n");
  assert.deepEqual(parseRemoteListeningPorts(output), [8000, 9229]);
});

test("adds an explicit control master without changing the destination", () => {
  assert.deepEqual(sshMasterArgs(["-p", "2222", "dev@example.com"], "/tmp/control"), [
    "-E",
    "/tmp/control.log",
    "-o",
    "ControlMaster=yes",
    "-o",
    "ControlPersist=10",
    "-S",
    "/tmp/control",
    "-p",
    "2222",
    "dev@example.com",
  ]);
});

test("each spawn of a pane gets its own control socket", { skip: process.platform === "win32" }, () => {
  // A pane returning to a host shell reuses its session id while the previous
  // master may still be closing; sharing its socket would disable multiplexing.
  const forwarding = new SshPortForwarding();
  const first = forwarding.prepare("pane:ssh:dev", "dev", ["dev"]).controlPath;
  const second = forwarding.prepare("pane:ssh:dev", "dev", ["dev"]).controlPath;
  assert.ok(first && second);
  assert.notEqual(first, second);
});

test("binds forwarded ports to local loopback through the existing master", () => {
  const args = sshForwardControlArgs(
    ["dev@example.com"],
    "/tmp/control",
    13000,
    3000,
    "forward",
  );
  assert.deepEqual(args.slice(0, 11), [
    "-o",
    "BatchMode=yes",
    "-o",
    "ExitOnForwardFailure=yes",
    "-S",
    "/tmp/control",
    "-O",
    "forward",
    "-L",
    "127.0.0.1:13000:localhost:3000",
    "dev@example.com",
  ]);
});

test("real SSH writes connection diagnostics to its log instead of terminal stderr", {
  skip: process.platform === "win32",
}, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "termany-ssh-log-"));
  const server = createServer((socket) => socket.destroy());
  t.after(() => {
    server.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const controlPath = join(directory, "control");
  await assert.rejects(
    promisify(execFile)("ssh", sshMasterArgs([
      "-F", "/dev/null", "-o", "BatchMode=yes", "-o", "ConnectTimeout=2",
      "-p", String(address.port), "127.0.0.1",
    ], controlPath), { timeout: 5000 }),
    (error: unknown) => {
      assert.equal((error as { stderr: string }).stderr, "");
      assert.match(readFileSync(`${controlPath}.log`, "utf8"), /Connection (closed|reset)/i);
      return true;
    },
  );
});

test("the PTY server exposes remote discovery and forward lifecycle APIs", () => {
  const server = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  assert.match(server, /sshPortForwarding\.prepare/);
  assert.match(server, /sshPortForwarding\.listRemotePorts/);
  assert.match(server, /\/api\/ssh-port-forward/);
  assert.match(server, /sshPortForwarding\.remove/);
});

/** A registered session whose ssh control calls are recorded, not run. */
function stubbedForwarding() {
  const forwarding = new SshPortForwarding();
  forwarding.register("pane", ["dev@example.com"], "/tmp/control");
  const calls: string[] = [];
  (forwarding as unknown as { runForward: unknown }).runForward = async (
    _session: unknown,
    localPort: number,
    remotePort: number,
    operation: string,
  ) => {
    calls.push(`${operation} ${localPort}:${remotePort}`);
  };
  return { forwarding, calls };
}

test("an explicit local port is bound exactly, and re-mapping releases the old one", async () => {
  const { forwarding, calls } = stubbedForwarding();
  assert.deepEqual(await forwarding.forward("pane", 3000, 18431), { remotePort: 3000, localPort: 18431 });
  assert.deepEqual(await forwarding.forward("pane", 3000, 18432), { remotePort: 3000, localPort: 18432 });
  assert.deepEqual(calls, ["forward 18431:3000", "cancel 18431:3000", "forward 18432:3000"]);
  assert.deepEqual(forwarding.snapshot("pane"), [{ remotePort: 3000, localPort: 18432 }]);
});

test("rejects invalid local ports and ports another forward already owns", async () => {
  const { forwarding } = stubbedForwarding();
  await assert.rejects(forwarding.forward("pane", 3000, 70000), /between 1 and 65535/);
  await forwarding.forward("pane", 3000, 18433);
  await assert.rejects(forwarding.forward("pane", 4000, 18433), /already forwards remote port 3000/);
});

test("uploads run through the existing master without opening a new one", () => {
  const args = sshUploadControlArgs(["-p", "2222", "dev@example.com"], "/tmp/control", "paste-1.png");
  assert.deepEqual(args.slice(0, 9), [
    "-o",
    "BatchMode=yes",
    "-o",
    "ControlMaster=no",
    "-S",
    "/tmp/control",
    "-p",
    "2222",
    "dev@example.com",
  ]);
  assert.equal(args.length, 10);
});

test("upload file names that would need shell quoting are refused", () => {
  for (const name of ["a b.png", "x;rm -rf ~.png", "it's.png", "../up.png", "$(id).png", ""]) {
    assert.throws(() => sshUploadControlArgs(["host"], "/tmp/control", name), /invalid remote file name/);
  }
});

test("the remote upload script writes stdin and prints the absolute path", { skip: process.platform === "win32" }, () => {
  const name = `paste-test-${process.pid}-${Date.now()}.png`;
  const script = sshUploadControlArgs(["host"], "/tmp/control", name).at(-1)!;
  const payload = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x0a, 0x0d]);
  // sshd hands the command string to the login shell, exactly like this.
  const stdout = execFileSync("/bin/sh", ["-c", script], { input: payload }).toString("utf8");
  const remotePath = parseUploadedPath(stdout);
  try {
    assert.match(remotePath, new RegExp(`^/tmp/termany-pastes-\\d+/${name}$`));
    assert.deepEqual(readFileSync(remotePath), payload);
  } finally {
    if (remotePath) rmSync(remotePath, { force: true });
  }
});

test("an upload that printed no absolute path is not reported as a path", () => {
  assert.equal(parseUploadedPath(""), "");
  assert.equal(parseUploadedPath("Welcome banner\n"), "");
  assert.equal(parseUploadedPath("motd line\n/tmp/termany-pastes-501/p.png"), "/tmp/termany-pastes-501/p.png");
});
