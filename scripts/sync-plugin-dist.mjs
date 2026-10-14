#!/usr/bin/env node
// Syncs the compiled dist/ and the production dependency closure into the
// distributable plugin directory after every build so `codex plugin add` picks
// up current artifacts with no build or install step on the user's machine.
//
// The physical package locations come from package-lock.json ("packages" map
// keys are the real on-disk paths, hoisted or nested), filtered to the
// production dependency closure from `npm ls --omit=dev`. Same shipping
// pattern as OpenAI's bundled browser plugin.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginDir = path.join(root, "plugins", "antigravity-mcp-bridge");
const sourceDist = path.join(root, "dist");
const sourceModules = path.join(root, "node_modules");

function fail(message) {
  console.error(`sync-plugin-dist: ${message}`);
  process.exit(1);
}

if (!existsSync(sourceDist)) {
  fail("dist/ not found. Run tsc first (this script runs as part of npm run build).");
}
if (!existsSync(sourceModules)) {
  fail("node_modules/ not found. Run `npm install` first.");
}

mkdirSync(pluginDir, { recursive: true });

const targetDist = path.join(pluginDir, "dist");
rmSync(targetDist, { recursive: true, force: true });
cpSync(sourceDist, targetDist, { recursive: true });
console.log(`sync-plugin-dist: copied dist -> ${path.relative(root, targetDist)}`);

// --- Production closure (logical): names reachable from prod deps ---
const tmpLsPath = path.join(root, "work", "npm-ls.json");
mkdirSync(path.dirname(tmpLsPath), { recursive: true });
execFileSync(
  (process.platform === "win32" ? "npm.cmd " : "npm ") +
    `ls --omit=dev --omit=peer --json --all > ${JSON.stringify(tmpLsPath)}`,
  { cwd: root, shell: true, stdio: "ignore" }
);
let lsTree;
try {
  lsTree = JSON.parse(readFileSync(tmpLsPath, "utf8"));
} catch (err) {
  fail(`could not parse npm ls output: ${err instanceof Error ? err.message : String(err)}`);
}
if (!lsTree?.dependencies) fail("npm ls reported no dependency tree; run `npm install` first.");

// name@version pairs reachable from the production root (nested entries may
// repeat a hoisted version; the physical location comes from the lockfile).
const prodVersions = new Map(); // name -> Set(version)
function noteVersion(name, pkg) {
  if (!prodVersions.has(name)) prodVersions.set(name, new Set());
  prodVersions.get(name).add(pkg.version);
}
function collect(pkg) {
  if (!pkg || typeof pkg !== "object" || pkg.invalid || pkg.extraneous) return;
  for (const [childName, child] of Object.entries(pkg.dependencies ?? {})) {
    if (!child || typeof child !== "object" || child.invalid || child.extraneous) continue;
    if (child.version) noteVersion(childName, child);
    collect(child);
  }
}
for (const [name, pkg] of Object.entries(lsTree.dependencies)) {
  if (!pkg || typeof pkg !== "object" || pkg.invalid || pkg.extraneous) continue;
  if (pkg.version) noteVersion(name, pkg);
  collect(pkg);
}
if (prodVersions.size === 0) fail("npm ls reported no production dependencies.");

// --- Physical locations from package-lock.json ---
const lockPath = path.join(root, "package-lock.json");
if (!existsSync(lockPath)) fail("package-lock.json not found; run `npm install` first.");
const lock = JSON.parse(readFileSync(lockPath, "utf8"));
const lockPackages = lock.packages ?? {};

const copyPlan = [];
for (const [key, info] of Object.entries(lockPackages)) {
  if (!key.startsWith("node_modules")) continue;
  if (info?.dev || info?.optional || info?.extraneous) continue;
  const name = info.name ?? key.replace(/^.*node_modules[\\/]/, "");
  const versions = prodVersions.get(name);
  if (!versions || !versions.has(info.version)) continue;
  const from = path.join(root, key);
  if (!existsSync(from)) continue;
  copyPlan.push({ from, to: path.join(pluginDir, key) });
}
if (copyPlan.length === 0) fail("no lockfile packages matched the production closure; run `npm install` first.");

const targetModules = path.join(pluginDir, "node_modules");
rmSync(targetModules, { recursive: true, force: true });
for (const { from, to } of copyPlan) {
  mkdirSync(path.dirname(to), { recursive: true });
  cpSync(from, to, { recursive: true, dereference: true });
}
const bundledNames = copyPlan.map(({ from }) => path.relative(sourceModules, from));
console.log(`sync-plugin-dist: bundled ${copyPlan.length} production packages -> ${path.relative(root, targetModules)}`);
console.log(`sync-plugin-dist: packages: ${bundledNames.join(", ")}`);