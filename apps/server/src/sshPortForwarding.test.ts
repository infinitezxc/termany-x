import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  parseRemoteListeningPorts,
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
    "-o",
    "ControlMaster=yes",
    "-o",
    "ControlPersist=no",
    "-S",
    "/tmp/control",
    "-p",
    "2222",
    "dev@example.com",
  ]);
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
