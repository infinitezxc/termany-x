import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  agentConfirmationPromptVisible,
  agentInputPromptVisible,
} from "../src/terminal/agentActivityPrompt.ts";

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

test("activity state is generation-safe and synchronized from the server", () => {
  const manager = source("../src/terminal/manager.ts");

  assert.match(manager, /taskEpoch: number/);
  assert.match(manager, /\/api\/activity\/events/);
  assert.match(manager, /\/api\/activity\/register/);
  assert.match(manager, /\/api\/activity\/report/);
  assert.match(manager, /taskEpoch: observedEpoch/);
  assert.doesNotMatch(manager, /WORKING_ACTIVITY_STALE_MS/);
});

test("page and tab indicators expose separate counts for all three states", () => {
  const manager = source("../src/terminal/manager.ts");
  const sidebar = source("../src/components/TreeSidebar.tsx");
  const tabs = source("../src/components/HTabBar.tsx");

  assert.match(manager, /export function agentActivitySummary/);
  assert.match(manager, /export function acknowledgeAgentActivities/);
  assert.match(manager, /export function hasActiveAgentSession/);
  assert.match(
    manager,
    /acknowledgeAgentActivities[\s\S]*agentActiveSessions\.has\(id\)[\s\S]*return \[\]/,
  );
  assert.match(sidebar, /\["working", "done", "error"\]/);
  assert.match(sidebar, /hasActiveAgentSession\(leafIds\)/);
  assert.match(sidebar, /const leafIds = ownLeafIds\(node\)/);
  assert.match(sidebar, /agentActivitySummary\(leafIds\)/);
  assert.match(sidebar, /acknowledgeAgentActivities\(viewedLeafIds\)/);
  assert.match(tabs, /\["working", "done", "error"\]/);
  assert.match(tabs, /agentActivitySummary\(ids\)/);
  assert.match(tabs, /acknowledgeAgentActivities\(ids\)/);
});

test("individual pane headers retain their own traffic light", () => {
  const panes = source("../src/components/SplitView.tsx");

  assert.match(panes, /aggregateAgentActivity\(\[leaf\.id\]\)/);
  assert.match(panes, /className=\{`agent-dot \$\{activity\.status\}`\}/);
  assert.match(panes, /acknowledgeAgentActivities\(\[leaf\.id\]\)/);
});

test("recognizes idle input and interactive confirmation screens", () => {
  const idle = [
    "╭──────────────────────────╮",
    "│ ›                        │",
    "╰──────────────────────────╯",
    "? for shortcuts",
  ].join("\n");
  const confirmation = [
    "Do you want to allow this command?",
    "› 1. Yes, allow",
    "  2. No, cancel",
    "Enter to confirm",
  ].join("\n");

  assert.equal(agentInputPromptVisible(idle), true);
  assert.equal(agentConfirmationPromptVisible(confirmation), true);
  assert.equal(
    agentConfirmationPromptVisible("The documentation says yes or no."),
    false,
  );
  assert.equal(
    agentConfirmationPromptVisible("", "Continue deployment? [y/n]"),
    true,
  );
});
