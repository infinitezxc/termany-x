import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("legacy registries retain terminal commands and discard Bot runtime configuration", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "termany-registry-"));
  const home = t.mock.method(os, "homedir", () => directory);
  const db = await import("./db.js");
  home.mock.restore();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const { listAgentConfigs, saveAgentConfigs } = await import("./agentConfig.js");
  db.setAgentsRaw(JSON.stringify([
    { id: "codex", name: "My Codex", command: "/custom/codex", args: "--test", enabled: false,
      runtime: { protocol: "acp", command: "node", args: "bridge.mjs" }, runtimeRevision: 5 },
    { id: "custom", name: "Custom CLI", command: "custom-cli", args: "", enabled: true },
  ]));
  const agents = listAgentConfigs().agents;
  const codex = agents.find((agent) => agent.id === "codex");
  assert.equal(codex?.command, "/custom/codex");
  assert.equal(codex?.args, "--test");
  assert.equal(codex?.enabled, false);
  assert.ok(agents.every((agent) => !("runtime" in agent) && !("runtimeRevision" in agent)));
  assert.equal(agents[0].id, "custom");
  saveAgentConfigs(agents);
  assert.deepEqual(JSON.parse(JSON.stringify(listAgentConfigs().agents)), JSON.parse(JSON.stringify(agents)));
  assert.equal(db.getAgentsRaw()?.includes('"runtime"'), false);

  const generatedId = "685e85a1-c5a3-43df-b152-c0a7fe103a44";
  const custom = saveAgentConfigs([{ id: generatedId, command: generatedId, name: "Custom" }])[0];
  assert.equal(custom.command, "");
});
