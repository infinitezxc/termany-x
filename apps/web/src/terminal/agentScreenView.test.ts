import assert from "node:assert/strict";
import test from "node:test";
import xtermPkg from "@xterm/headless";
import { readAgentScreen } from "./agentScreenView";
import { AgentIdleWatcher } from "./agentIdleWatcher";

const { Terminal } = xtermPkg as unknown as { Terminal: any };
const idle = [
  "• Ran git status &&…",
  "  └ command finished successfully",
  "Amended the commit and pushed the changes.",
  "Worked for 18s",
  "",
  "› Ask Codex to do anything",
  "GPT-6.1-Sol medium · ~/EnvSet",
  "← for agents · ? for shortcuts",
].join("\r\n");

for (const transport of ["local", "ssh"]) {
  test(`${transport}: a scrolled historical spinner cannot keep EnvSet yellow`, async () => {
    const term = new Terminal({ cols: 80, rows: 12, scrollback: 100, allowProposedApi: true });
    const write = (data: string) => new Promise<void>((resolve) => term.write(data, resolve));
    try {
      await write("• Working (esc to interrupt)\r\n");
      await write("old output\r\n".repeat(20));
      // SSH can split a prompt anywhere between packets.
      for (let i = 0; i < idle.length; i += transport === "ssh" ? 7 : idle.length) {
        await write(idle.slice(i, i + (transport === "ssh" ? 7 : idle.length)));
      }
      term.scrollToTop();
      assert.ok(term.buffer.active.viewportY < term.buffer.active.baseY);
      const view = readAgentScreen(term);
      assert.match(view.visible, /Ask Codex to do anything/);
      assert.match(view.visible, /• Ran git status &&…/);
      assert.doesNotMatch(view.visible, /esc to interrupt/);
      const watcher = new AgentIdleWatcher();
      watcher.update(view, 0);
      watcher.update(readAgentScreen(term), 2000);
      assert.deepEqual(watcher.pending, { status: "done", agentActive: true });
      assert.equal(watcher.deadline, 2000);
      assert.equal(watcher.busyVisible, false);
    } finally {
      term.dispose();
    }
  });
}

test("live work stays busy even if the viewport shows an old idle prompt", async () => {
  const term = new Terminal({ cols: 80, rows: 8, scrollback: 100, allowProposedApi: true });
  const write = (data: string) => new Promise<void>((resolve) => term.write(data, resolve));
  try {
    await write(idle + "\r\n" + "new output\r\n".repeat(20));
    await write("• Working (30s • esc to interrupt)\r\n› Ask Codex to do anything");
    term.scrollToTop();
    const watcher = new AgentIdleWatcher();
    watcher.update(readAgentScreen(term), 0);
    watcher.update(readAgentScreen(term), 60_000);
    assert.equal(watcher.busyVisible, true);
    assert.equal(watcher.pending, null);
    assert.equal(watcher.deadline, null);
  } finally {
    term.dispose();
  }
});
