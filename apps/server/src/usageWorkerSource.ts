// Development only: builds the SSH usage worker from source. Packaged servers
// ship the prebuilt usage-worker.cjs (scripts/bundle-server.mjs), and nothing
// bundled imports this module, so esbuild never meets its import.meta.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

export async function buildUsageWorker(): Promise<string> {
  const result = await build({
    entryPoints: [fileURLToPath(new URL("./usageWorker.ts", import.meta.url))],
    bundle: true,
    platform: "node",
    target: "node16",
    format: "cjs",
    define: { __TERMANY_VERSION__: "true" },
    minify: true,
    write: false,
  });
  return result.outputFiles[0].text;
}
