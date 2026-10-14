#!/usr/bin/env node
// Syncs the compiled dist/ into the distributable plugin directory after every
// build so `codex plugin add` picks up current artifacts without a build step.
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "dist");
const target = path.join(root, "plugins", "antigravity-mcp-bridge", "dist");

if (!existsSync(source)) {
  console.error("sync-plugin-dist: dist/ not found. Run tsc first (this script runs as part of npm run build).");
  process.exit(1);
}

mkdirSync(path.dirname(target), { recursive: true });
rmSync(target, { recursive: true, force: true });
cpSync(source, target, { recursive: true });
console.log(`sync-plugin-dist: copied dist -> ${path.relative(root, target)}`);
