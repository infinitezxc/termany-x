// This entry point is bundled as a small standalone script for SSH hosts.
import { readFileSync } from "node:fs";
import { parseUsageFile } from "./agentSessions.js";

async function main() {
  const files: [string, string][] = JSON.parse(readFileSync(0, "utf8"));
  for (const [agent, file] of files) {
    let parsed;
    try {
      parsed = await parseUsageFile(agent, file);
    } catch (error) {
      // A listed file can disappear or become unreadable before or during the scan.
      const { syscall } = error as NodeJS.ErrnoException;
      if (syscall !== "stat" && syscall !== "open" && syscall !== "read") throw error;
      parsed = null;
    }
    if (parsed) {
      // The dashboard needs only the identity, project and usage buckets.
      parsed.session.preview = "";
      delete parsed.session.title;
    }
    console.log(JSON.stringify([file, parsed]));
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
