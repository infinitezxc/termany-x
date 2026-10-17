import assert from "node:assert/strict";
import test from "node:test";
import { detectAgentExecutable, parseAgentDetectionInput } from "./agentDetection.js";

test("terminal detection ignores legacy Bot runtime settings", async () => {
  const agent = parseAgentDetectionInput({
    id: "custom", name: "Custom", command: process.execPath, enabled: true,
    runtime: { protocol: "acp-http", endpoint: "http://127.0.0.1:1/acp" },
  });
  assert.ok(agent);
  assert.equal("runtime" in agent, false);
  const result = await detectAgentExecutable(agent);
  assert.equal(result.installed, true);
  assert.equal(result.terminalInstalled, true);
  assert.equal(result.path, result.terminalPath);
});

test("malformed detection requests and missing terminal executables are handled", async () => {
  assert.equal(parseAgentDetectionInput(null), undefined);
  assert.equal(parseAgentDetectionInput({ command: "node" }), undefined);
  const agent = parseAgentDetectionInput({ id: "missing", command: "termany-nonexistent-cli" });
  assert.ok(agent);
  assert.equal((await detectAgentExecutable(agent)).installed, false);
});
