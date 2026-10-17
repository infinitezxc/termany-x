import assert from "node:assert/strict";
import test from "node:test";
import { paneWithView } from "./state/paneViewCycle";
import type { Pane } from "./state/store";

test("switching inherited remote directory views to terminal retains the SSH host", () => {
  for (const view of ["files", "history", "git"] as const) {
    const pane = { kind: "leaf", id: "view", title: "Remote", view, cwdFrom: "ssh-source" } as const;
    const terminal = paneWithView(pane, "terminal", { sshTarget: "user@host", sshLabel: "Server" });
    assert.equal(terminal.sshTarget, "user@host");
    assert.equal(terminal.sshLabel, "Server");
    assert.equal(terminal.id, pane.id);
    assert.equal(terminal.cwdFrom, pane.cwdFrom);
    assert.equal(paneWithView(paneWithView(terminal, "files"), "terminal").sshTarget, "user@host");
  }
});

test("local view switches stay local and existing SSH connections survive other views", () => {
  const pane: Extract<Pane, { kind: "leaf" }> = { kind: "leaf", id: "local", title: "Local", view: "files" };
  assert.equal(paneWithView(pane, "terminal").sshTarget, undefined);
  assert.equal(paneWithView({ ...pane, sshTarget: "host" }, "history").sshTarget, "host");
});
