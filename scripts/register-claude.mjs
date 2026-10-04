#!/usr/bin/env node

import { runClaudeInstallerCli } from "../dist/installer.js";

runClaudeInstallerCli().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
