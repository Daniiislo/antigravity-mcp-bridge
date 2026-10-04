#!/usr/bin/env node
import { exec } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../dist/config.js";
import { WorkerManager } from "../dist/worker-manager.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const config = loadConfig(process.env);
const runsDir = config.runsDir || path.join(root, ".antigravity-bridge", "runs");
const manager = new WorkerManager(config, config.baseArgs, { runsDir });

const url = await manager.getDashboardUrl();
if (!url) {
  console.error("Dashboard is disabled via AGY_DASHBOARD_ENABLED=false");
  process.exit(1);
}

console.log("==================================================");
console.log("  Antigravity MCP Bridge - Local Dashboard");
console.log("==================================================");
console.log(`URL: ${url}`);
console.log("Status: Listening on loopback (127.0.0.1)");
console.log("Press Ctrl+C to stop the dashboard server.\n");

const startCmd =
  process.platform === "win32"
    ? `start "" "${url}"`
    : process.platform === "darwin"
      ? `open "${url}"`
      : `xdg-open "${url}"`;

exec(startCmd, () => {
  // Ignore error if browser cannot be spawned in headless environments
});

// Keep process alive until terminated
process.on("SIGINT", () => {
  console.log("\nStopping dashboard server...");
  process.exit(0);
});
process.on("SIGTERM", () => {
  process.exit(0);
});
