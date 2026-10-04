#!/usr/bin/env node
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distInstaller = path.join(root, "dist", "installer.js");

if (!existsSync(distInstaller)) {
  console.error(
    "Error: dist/installer.js not found.\n" +
    "Please build the project first with:\n" +
    "  npm run build\n"
  );
  process.exit(1);
}

const { runInstallerCli } = await import(pathToFileURL(distInstaller).href);
await runInstallerCli();
