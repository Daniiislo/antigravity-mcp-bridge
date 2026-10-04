#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";
import { WorkerManager } from "./worker-manager.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const manager = new WorkerManager(config);
  const handle = serveStdio(() => createServer(manager), {
    onerror: (error) => console.error(`[antigravity-codex-mcp] ${error.message}`)
  });

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await manager.stop();
    await handle.close();
  };
  process.once("SIGINT", () => { void shutdown().finally(() => process.exit(130)); });
  process.once("SIGTERM", () => { void shutdown().finally(() => process.exit(143)); });
  process.stdin.once("end", () => { void shutdown(); });
  process.once("beforeExit", () => { void manager.stop(); });
  console.error("[antigravity-codex-mcp] serving over stdio");
}

main().catch((error: unknown) => {
  console.error(`[antigravity-codex-mcp] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
