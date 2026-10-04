#!/usr/bin/env node
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../dist/config.js";
import { EventStore } from "../dist/event-store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const args = process.argv.slice(2);

function printHelp() {
  console.log(`
Antigravity MCP Bridge - History Cleanup & Pruning CLI

Usage:
  node scripts/clean-runs.mjs [options]
  npm run clean -- [options]
  npm run prune -- [options]

Options:
  --job <id>             Delete a specific job run by ID
  --project <name/path>  Delete runs belonging to a project or workspace
  --workspace <path>     Alias for --project
  --status <status>      Delete runs with specific status (e.g. failed,canceled)
  --terminal-only        Only delete completed jobs (succeeded, failed, canceled) [default: true]
  --all                  Delete all jobs matching filters (overrides --terminal-only)
  --older-than <days>    Delete runs older than N days
  --keep <count>         Preserve the newest N runs matching criteria
  --dry-run              Preview runs that would be deleted without deleting
  -y, --yes              Skip interactive confirmation prompt
  -h, --help             Show this help message

Examples:
  npm run clean -- --terminal-only --keep 10
  npm run clean -- --project "Antigravity Bridge Codex MCP"
  npm run clean -- --status failed,canceled
  npm run clean -- --job job-12345
  npm run clean -- --all -y
`);
}

if (args.includes("-h") || args.includes("--help")) {
  printHelp();
  process.exit(0);
}

let jobId;
let workspace;
let status;
let terminalOnly;
let all = false;
let olderThanDays;
let keep;
let dryRun = false;
let autoConfirm = false;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--job" && args[i + 1]) {
    jobId = args[++i];
  } else if ((arg === "--project" || arg === "--workspace") && args[i + 1]) {
    workspace = args[++i];
  } else if (arg === "--status" && args[i + 1]) {
    const val = args[++i];
    status = val.includes(",") ? val.split(",").map((s) => s.trim()) : val.trim();
  } else if (arg === "--terminal-only") {
    terminalOnly = true;
  } else if (arg === "--all") {
    all = true;
  } else if (arg === "--older-than" && args[i + 1]) {
    olderThanDays = parseFloat(args[++i]);
  } else if (arg === "--keep" && args[i + 1]) {
    keep = parseInt(args[++i], 10);
  } else if (arg === "--dry-run") {
    dryRun = true;
  } else if (arg === "-y" || arg === "--yes") {
    autoConfirm = true;
  }
}

if (all) {
  terminalOnly = false;
} else if (terminalOnly === undefined && !status) {
  terminalOnly = true;
}

const config = loadConfig(process.env);
const runsDir = config.runsDir || path.join(root, ".antigravity-bridge", "runs");
const eventStore = new EventStore({ runsDir });

const allRuns = await eventStore.readDiskHistory({ limit: 100_000 });
console.log(`[clean] Found ${allRuns.length} total runs in ${runsDir}`);

if (allRuns.length === 0) {
  console.log("[clean] No runs found on disk. Nothing to clean.");
  process.exit(0);
}

// Filter candidates
let candidates = allRuns;
if (jobId) {
  candidates = candidates.filter((r) => r.job_id === jobId);
}
if (workspace) {
  const target = workspace.trim().toLowerCase();
  candidates = candidates.filter((r) => {
    if (!r.workspace) return false;
    const norm = r.workspace.toLowerCase();
    return norm === target || path.basename(r.workspace).toLowerCase() === target || norm.includes(target);
  });
}
if (terminalOnly) {
  candidates = candidates.filter((r) => ["succeeded", "failed", "canceled"].includes(r.status));
}
if (status) {
  const allowed = Array.isArray(status) ? status : [status];
  candidates = candidates.filter((r) => allowed.includes(r.status));
}
if (typeof olderThanDays === "number" && !isNaN(olderThanDays)) {
  const cutoff = Date.now() - olderThanDays * 86_400_000;
  candidates = candidates.filter((r) => new Date(r.created_at).getTime() < cutoff);
}

candidates.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

if (typeof keep === "number" && !isNaN(keep) && keep > 0) {
  const kept = candidates.slice(0, keep);
  candidates = candidates.slice(keep);
  console.log(`[clean] Preserving ${kept.length} newest matching runs.`);
}

console.log(`[clean] ${candidates.length} candidate runs matched for deletion:`);
for (const c of candidates.slice(0, 10)) {
  console.log(`  - ${c.job_id} | ${c.status} | ${c.workspace || "(no workspace)"} | ${c.created_at}`);
}
if (candidates.length > 10) {
  console.log(`  ... and ${candidates.length - 10} more runs.`);
}

if (candidates.length === 0) {
  console.log("[clean] No candidates matched the criteria. Nothing deleted.");
  process.exit(0);
}

if (dryRun) {
  console.log(`\n[clean] Dry-run mode enabled. Would delete ${candidates.length} runs.`);
  process.exit(0);
}

if (!autoConfirm) {
  const rl = readline.createInterface({ input, output });
  const answer = await rl.question(`\nAre you sure you want to permanently delete these ${candidates.length} runs? [y/N]: `);
  rl.close();
  if (!answer.trim().toLowerCase().startsWith("y")) {
    console.log("[clean] Aborted by user. No files deleted.");
    process.exit(0);
  }
}

let deletedCount = 0;
for (const c of candidates) {
  if (eventStore.deleteJob(c.job_id)) {
    deletedCount++;
  }
}

console.log(`[clean] Successfully deleted ${deletedCount} runs from disk.`);
