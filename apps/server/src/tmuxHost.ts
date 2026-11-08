import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { remoteSh } from "./remoteFs.js";
import { resolveExecutable, spawnEnvironment } from "./shellPath.js";
import { ptyEnvironment } from "./ptyEnvironment.js";

const exec = promisify(execFile);
/** null selects this machine; an array always means SSH, never a local fallback. */
export type TmuxHost = string[] | null;

export async function localTmuxAvailable(): Promise<boolean> {
  return process.platform !== "win32" && !!await resolveExecutable("tmux");
}

export async function localTmuxEnvironment() {
  const env = ptyEnvironment(await spawnEnvironment());
  // A Termany dev server may itself have been launched inside tmux.
  delete env.TMUX;
  delete env.TMUX_PANE;
  return env;
}

export async function tmuxSh(host: TmuxHost, script: string, args: string[] = [], options: { timeoutMs?: number } = {}): Promise<Buffer> {
  if (host !== null) return remoteSh(host, script, args, options);
  const { stdout } = await exec("/bin/sh", ["-c", script, "termany", ...args], {
    env: await localTmuxEnvironment(), timeout: options.timeoutMs ?? 15_000,
    maxBuffer: 16 * 1024 * 1024, encoding: "buffer",
  });
  return stdout;
}
