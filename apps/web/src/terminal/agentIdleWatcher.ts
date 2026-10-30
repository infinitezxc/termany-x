import {
  AGENT_IDLE_QUIET_MS,
  agentBusyScreenVisible,
  agentConfirmationPromptVisible,
  agentInputPromptVisible,
  screenSignature,
  shellPromptVisible,
} from "./agentActivityPrompt";

export type AgentScreenView = {
  visible: string;
  cursorLine: string;
  isAlternate: boolean;
};

export type AgentScreenTransition = {
  status: "done" | "error";
  agentActive: boolean;
};

/**
 * Decides when a rendered screen means an agent stopped working.
 *
 * One watcher per session. It is deliberately free of timers, DOM, and network
 * so the whole judgement can be replayed against recorded sessions: the caller
 * feeds screens as they render and arms a single timeout on `deadline`.
 */
export class AgentIdleWatcher {
  private sawAlternate = false;
  private sawInputPrompt = false;
  private armedSignature: string | null = null;
  private armed: { at: number; transition: AgentScreenTransition } | null = null;
  private lastBusyVisible = false;

  constructor(private readonly quietMs: number = AGENT_IDLE_QUIET_MS) {}

  /** Feed the rendered screen after a PTY write landed. */
  update(view: AgentScreenView, now: number): void {
    const transition = this.transition(view);
    if (!transition) {
      this.armed = null;
      return;
    }
    // Anything repainted since the window opened means the agent is still
    // drawing, so the wait restarts rather than banking stale quiet time.
    // Judged on the signature rather than on the write: a clock in a prompt or
    // a status bar repaints once a second forever, and counting those writes
    // pushed the deadline out for as long as the session stayed open.
    const signature = screenSignature(view.visible, view.cursorLine);
    if (this.armed && this.armedSignature === signature) return;
    this.armed = { at: now, transition };
    this.armedSignature = signature;
  }

  /** The moment a completion may be reported, or null while work continues. */
  get deadline(): number | null {
    return this.armed ? this.armed.at + this.quietMs : null;
  }

  get pending(): AgentScreenTransition | null {
    return this.armed?.transition ?? null;
  }

  /**
   * Whether the latest screen carried positive busy evidence. The veto that
   * keeps a busy screen from arming the quiet window doubles as the ledger's
   * proof that a settled status was settled too early: an agent repainting
   * its spinner did not finish, whatever the dot says.
   */
  get busyVisible(): boolean {
    return this.lastBusyVisible;
  }

  /** A new task on the same session starts from a clean slate. */
  reset(isAlternate: boolean): void {
    this.sawAlternate = isAlternate;
    this.sawInputPrompt = false;
    this.armed = null;
    this.armedSignature = null;
    this.lastBusyVisible = false;
  }

  private transition(view: AgentScreenView): AgentScreenTransition | null {
    this.lastBusyVisible = false;
    if (!view.visible.trim()) return null;
    if (view.isAlternate) this.sawAlternate = true;
    if (agentConfirmationPromptVisible(view.visible, view.cursorLine)) {
      return { status: "error", agentActive: true };
    }
    if (agentBusyScreenVisible(view.visible)) {
      this.lastBusyVisible = true;
      return null;
    }

    const inputPrompt = agentInputPromptVisible(view.visible);
    if (inputPrompt) this.sawInputPrompt = true;
    // Checked ahead of the composer because a shell themed with ❯ or › looks
    // exactly like one. Agents that own the alternate screen announce their
    // exit by giving it back; agents that stay on the normal screen (Codex)
    // announce it by taking their composer down.
    const leftAgentUi = view.isAlternate
      ? false
      : this.sawAlternate || (!inputPrompt && this.sawInputPrompt);
    // Reattachment may start after the agent exited, so this watcher never
    // saw its UI. A shell prompt on the live cursor row can repair that stale
    // activity without relying on the missing transition. Keep ambiguous
    // agent composers (❯ / >) and historical shell output out of this path.
    const restoredShell = !view.isAlternate && !inputPrompt &&
      shellPromptVisible(view.cursorLine) && shellPromptVisible(view.visible);
    if ((leftAgentUi || restoredShell) && shellPromptVisible(view.visible)) {
      return { status: "done", agentActive: false };
    }
    if (inputPrompt) return { status: "done", agentActive: true };
    return null;
  }
}
