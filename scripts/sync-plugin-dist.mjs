#!/usr/bin/env node
// Syncs the compiled dist/ and production node_modules into the distributable
// plugin directory after every build so `codex plugin add` picks up current
// artifacts with no build or install step on the user's machine.
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginDir = path.join(root, "plugins", "antigravity-mcp-bridge");
const sourceDist = path.join(root, "dist");
const sourceModules = path.join(root, "node_modules");

if (!existsSync(sourceDist)) {
  console.error("sync-plugin-dist: dist/ not found. Run tsc first (this script runs as part of npm run build).");
  process.exit(1);
}

mkdirSync(pluginDir, { recursive: true });

const targetDist = path.join(pluginDir, "dist");
rmSync(targetDist, { recursive: true, force: true });
cpSync(sourceDist, targetDist, { recursive: true });
console.log(`sync-plugin-dist: copied dist -> ${path.relative(root, targetDist)}`);

// Bundle production dependencies. The same pattern ships OpenAI's bundled
// browser plugin: installs never run npm, so node_modules must be present.
if (!existsSync(sourceModules)) {
  console.error("sync-plugin-dist: node_modules/ not found. Run `npm install --omit=dev` first.");
  process.exit(1);
}
const targetModules = path.join(pluginDir, "node_modules");
rmSync(targetModules, { recursive: true, force: true });
mkdirSync(targetModules, { recursive: true });

// Top-level production dependencies from package.json (scoped names take the
// @scope dir + package dir).
const prodDeps = [
  "@modelcontextprotocol/server",
  "@modelcontextprotocol/ext-tasks",
  "zod"
];
for (const dep of prodDeps) {
  const from = path.join(sourceModules, dep);
  if (!existsSync(from)) {
    console.error(`sync-plugin-dist: production dependency missing from node_modules: ${dep}`);
    process.exit(1);
  }
  const to = path.join(targetModules, dep);
  mkdirSync(path.dirname(to), { recursive: true });
  cpSync(from, to, { recursive: true, dereference: true });
}
console.log(`sync-plugin-dist: bundled ${prodDeps.length} production dependencies -> ${path.relative(root, targetModules)}`);
