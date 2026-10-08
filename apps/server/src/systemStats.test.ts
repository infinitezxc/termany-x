import assert from "node:assert/strict";
import test from "node:test";
import { KillError, killRemoteProcess, readRemoteSystemStats } from "./systemStats.js";

const linux = (stat: string, first: boolean) =>
  [
    "",
    "stat",
    "cpu  100 0 50 800 50 0 0 0 0 0",
    ...(first ? ["stat2", stat] : []),
    "meminfo",
    "MemTotal:        8000000 kB",
    "MemAvailable:    6000000 kB",
    "Active:          1000000 kB",
    "Cached:          500000 kB",
    "SwapTotal:       1000000 kB",
    "SwapFree:        750000 kB",
    "uptime",
    "12345.67 40000.00",
    "loadavg",
    "0.50 0.25 0.10 1/200 999",
    "cores",
    "4",
    "ss",
    "State  Recv-Q Send-Q Local Address:Port Peer Address:Port Process",
    'LISTEN 0      4096   127.0.0.1:5432     0.0.0.0:*         users:(("postgres",pid=812,fd=6))',
    'LISTEN 0      511    [::]:3000          [::]:*            users:(("node",pid=900,fd=20),("node",pid=901,fd=20))',
    "LISTEN 0      128    0.0.0.0:22         0.0.0.0:*",
    "ps",
    "  812  1.5  20480 postgres /usr/lib/postgresql/bin/postgres",
    "  900 10.0  40960 alice    node",
    "  901  5.0  10240 alice    node",
    "",
  ].join("\n").replace(/^(stat|stat2|meminfo|uptime|loadavg|cores|ss|ps)$/gm, "\x1e$1");

test("remote stats read a Linux host's /proc, ss and ps", async () => {
  const calls: string[][] = [];
  let n = 0;
  const exec = async (_script: string, args: string[]) => {
    calls.push(args);
    // First poll: no previous sample, so the script diffs two reads itself.
    return Buffer.from(n++ === 0 ? linux("cpu  150 0 70 1000 60 0 0 0 0 0", true) : linux("", false));
  };
  const s = await readRemoteSystemStats(exec, "linux-host");
  assert.deepEqual(calls[0], ["1"]);
  // delta: user 50, system 20, idle+iowait 210 → total 280
  assert.equal(Math.round(s.cpu.usage), 25);
  assert.equal(Math.round(s.cpu.user), 18);
  assert.equal(s.cpu.cores, 4);
  assert.deepEqual(s.cpu.loadavg, [0.5, 0.25, 0.1]);
  assert.equal(s.uptimeSec, 12345.67);
  assert.equal(s.memory.total, 8000000 * 1024);
  assert.equal(s.memory.used, 2000000 * 1024);
  assert.equal(s.memory.swapUsed, 250000 * 1024);
  const node = s.processes.find((p) => p.name === "node")!;
  assert.equal(node.count, 2);
  assert.deepEqual(node.ports, [3000]);
  assert.deepEqual(s.processes.find((p) => p.name === "postgres")?.ports, [5432]);

  await readRemoteSystemStats(exec, "linux-host");
  assert.deepEqual(calls[1], ["0"]);
});

test("remote kill guards pids and reports the host's error", async () => {
  const exec = async (_script: string, args: string[]) => {
    if (args[1] === "42") throw new Error("kill: (42) - No such process");
    return Buffer.alloc(0);
  };
  await assert.rejects(killRemoteProcess(exec, 1, "SIGTERM"), KillError);
  await assert.rejects(killRemoteProcess(exec, 42, "SIGKILL"), /already gone/);
  await killRemoteProcess(exec, 43, "SIGTERM");
});
