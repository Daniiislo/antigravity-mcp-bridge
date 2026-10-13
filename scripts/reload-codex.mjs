#!/usr/bin/env node
import { cpSync, existsSync, readdirSync } from "node:fs";
import { homedir, platform } from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(root, "dist");

if (!existsSync(distDir)) {
  console.error("Error: dist/ not found. Run `npm run build` first.");
  process.exit(1);
}

console.log("[reload:codex] 1. Syncing build artifacts to Codex plugin cache...");
const home = homedir();
const pluginCacheDir = path.join(home, ".codex", "plugins", "cache", "local-marketplace", "antigravity-mcp-bridge");

let syncedCount = 0;
if (existsSync(pluginCacheDir)) {
  try {
    for (const ver of readdirSync(pluginCacheDir)) {
      const targetDist = path.join(pluginCacheDir, ver, "dist");
      if (existsSync(path.join(pluginCacheDir, ver))) {
        cpSync(distDir, targetDist, { recursive: true, force: true });
        console.log(`  ✓ Synced dist to ${targetDist}`);
        syncedCount++;
      }
    }
  } catch (err) {
    console.warn(`  ! Could not sync plugin cache: ${err.message}`);
  }
}
if (syncedCount === 0) {
  console.log("  - No local-marketplace plugin cache directory detected; Codex direct MCP server is configured.");
}

console.log("[reload:codex] 2. Checking for active/stale MCP bridge server processes...");
const isWin = platform() === "win32";

if (isWin) {
  try {
    // Query processes running dist/index.js or antigravity-mcp-bridge
    const psCmd = `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*antigravity*dist*index.js*' -or $_.CommandLine -like '*antigravity-mcp-bridge*' } | Select-Object -ExpandProperty ProcessId`;
    const output = execSync(`powershell -NoProfile -Command "${psCmd}"`, { encoding: "utf8" }).trim();
    if (output) {
      const pids = output.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      for (const pid of pids) {
        if (Number(pid) !== process.pid) {
          try {
            process.kill(Number(pid), "SIGKILL");
            console.log(`  ✓ Terminated stale MCP process PID ${pid}`);
          } catch {
            // Process might have exited
          }
        }
      }
    } else {
      console.log("  - No active bridge processes running.");
    }
  } catch (err) {
    console.warn(`  ! Error inspecting processes: ${err.message}`);
  }
} else {
  try {
    const pids = execSync("pgrep -f 'antigravity-mcp-bridge|dist/index.js'", { encoding: "utf8" }).trim().split(/\s+/).filter(Boolean);
    for (const pid of pids) {
      if (Number(pid) !== process.pid) {
        try {
          process.kill(Number(pid), "SIGKILL");
          console.log(`  ✓ Terminated stale MCP process PID ${pid}`);
        } catch {}
      }
    }
  } catch {
    console.log("  - No active bridge processes running.");
  }
}

console.log("[reload:codex] ✅ Reload complete. Codex will launch the updated MCP bridge on its next tool call.\n");
