import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("profile nickname and uploaded avatar survive a state reload", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "termany-profile-state-"));
  const home = t.mock.method(os, "homedir", () => directory);
  const db = await import("./db.js");
  home.mock.restore();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  const userProfile = {
    nickname: "idoubi",
    avatar: "data:image/png;base64,dGVybWFueQ==",
  };
  db.saveState({
    workspaces: [],
    userProfile,
    activeWorkspace: "",
    sidebarCollapsed: false,
  });

  assert.deepEqual(db.loadState().userProfile, userProfile);
});
