#!/usr/bin/env node
import { exec } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { loadConfig, resolveCandidateRunsDirs } from "../dist/config.js";
import { WorkerManager } from "../dist/worker-manager.js";

const config = loadConfig(process.env);
const candidateDirs = resolveCandidateRunsDirs(process.env.AGY_RUNS_DIR);
const runsDir = candidateDirs[0];
const fallbackDirs = candidateDirs.slice(1);
const manager = new WorkerManager(config, config.baseArgs, { runsDir, fallbackRunsDirs: fallbackDirs });

const url = await manager.getDashboardUrl();
if (!url) {
  console.error("Dashboard is disabled via AGY_DASHBOARD_ENABLED=false");
  process.exit(1);
}

console.log("==================================================");
console.log("  Antigravity MCP Bridge - Local Dashboard");
console.log("==================================================");
console.log(`History directory: ${runsDir}`);

let totalJobs = 0;
if (existsSync(runsDir)) {
  totalJobs += readdirSync(runsDir).filter((name) => name.endsWith(".ndjson")).length;
}
for (const fb of fallbackDirs) {
  if (existsSync(fb)) {
    const fbCount = readdirSync(fb).filter((name) => name.endsWith(".ndjson")).length;
    totalJobs += fbCount;
    if (fbCount > 0) {
      console.log(`Discovered ${fbCount} historical job files from package storage: ${fb}`);
    }
  }
}

if (totalJobs === 0) {
  console.warn("WARNING: no .ndjson job files found in this history directory or sandbox storage.");
  console.warn("If tasks are visible in another Codex/AGY dashboard, use that MCP server's open_dashboard tool or set AGY_RUNS_DIR to a shared directory.");
} else {
  console.log(`History files visible: ${totalJobs}`);
}
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
