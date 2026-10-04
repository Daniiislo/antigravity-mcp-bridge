#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_ROOT = path.resolve(__dirname, "..");

export function parsePluginInstallerArgs(argv) {
  let catalog;
  let marketplaceDir;
  let name;
  let pluginRoot;
  let dryRun = false;
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg) continue;

    if (arg === "--catalog" && i + 1 < argv.length) {
      catalog = argv[++i];
    } else if (arg.startsWith("--catalog=")) {
      catalog = arg.slice("--catalog=".length);
    } else if (arg === "--marketplace-dir" && i + 1 < argv.length) {
      marketplaceDir = argv[++i];
    } else if (arg.startsWith("--marketplace-dir=")) {
      marketplaceDir = arg.slice("--marketplace-dir=".length);
    } else if (arg === "--name" && i + 1 < argv.length) {
      name = argv[++i];
    } else if (arg.startsWith("--name=")) {
      name = arg.slice("--name=".length);
    } else if (arg === "--plugin-root" && i + 1 < argv.length) {
      pluginRoot = argv[++i];
    } else if (arg.startsWith("--plugin-root=")) {
      pluginRoot = arg.slice("--plugin-root=".length);
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--help" || arg === "-h") {
      help = true;
    }
  }

  return { catalog, marketplaceDir, name, pluginRoot, dryRun, help };
}

export function validatePluginFiles(pluginRoot = DEFAULT_ROOT) {
  const resolvedRoot = path.resolve(pluginRoot);
  const pluginJsonPath = path.join(resolvedRoot, "plugin.json");
  const mcpJsonPath = path.join(resolvedRoot, "mcp.json");
  const distIndexPath = path.join(resolvedRoot, "dist", "index.js");

  if (!existsSync(pluginJsonPath)) {
    throw new Error(`plugin.json not found at ${pluginJsonPath}. Ensure root plugin manifest exists.`);
  }

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(pluginJsonPath, "utf8"));
  } catch (err) {
    throw new Error(`Failed to parse ${pluginJsonPath}: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!manifest || typeof manifest !== "object" || !manifest.name) {
    throw new Error(`Invalid plugin.json at ${pluginJsonPath}: missing required 'name' field.`);
  }

  if (!existsSync(mcpJsonPath)) {
    throw new Error(`mcp.json not found at ${mcpJsonPath}. Ensure root mcp manifest exists.`);
  }

  let mcpConfig;
  try {
    mcpConfig = JSON.parse(readFileSync(mcpJsonPath, "utf8"));
  } catch (err) {
    throw new Error(`Failed to parse ${mcpJsonPath}: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!mcpConfig || typeof mcpConfig !== "object" || !mcpConfig.mcpServers || typeof mcpConfig.mcpServers !== "object") {
    throw new Error(`Invalid mcp.json at ${mcpJsonPath}: missing required 'mcpServers' object.`);
  }

  if (!existsSync(distIndexPath)) {
    throw new Error(
      `Build artifact not found at ${distIndexPath}.\nPlease build the project first with:\n  npm run build`
    );
  }

  return { manifest, mcpConfig, resolvedRoot };
}

export function resolveCatalogPath(options = {}) {
  if (options.catalog) {
    return path.resolve(options.catalog);
  }
  if (options.marketplaceDir) {
    return path.resolve(options.marketplaceDir, "marketplace.json");
  }
  const baseDir = options.workspaceRoot ? path.resolve(options.workspaceRoot) : DEFAULT_ROOT;
  return path.join(baseDir, ".agents", "plugins", "marketplace.json");
}

export function buildMarketplaceEntry(pluginRoot, manifest, options = {}) {
  const resolvedPath = path.resolve(pluginRoot);
  const pluginName = options.name?.trim() || manifest.name || "antigravity-mcp-bridge";
  const category = manifest.interface?.category || "Development";

  return {
    name: pluginName,
    source: {
      source: "local",
      path: resolvedPath
    },
    policy: {
      installation: "AVAILABLE",
      authentication: "ON_INSTALL"
    },
    category
  };
}

export function mergeMarketplaceCatalog(existingCatalog, newEntry) {
  if (!existingCatalog || typeof existingCatalog !== "object") {
    return {
      name: "local-marketplace",
      interface: {
        displayName: "Local Plugins"
      },
      plugins: [newEntry]
    };
  }

  const catalog = JSON.parse(JSON.stringify(existingCatalog));
  if (!Array.isArray(catalog.plugins)) {
    catalog.plugins = [];
  }

  const existingIndex = catalog.plugins.findIndex(
    (item) => item && typeof item === "object" && item.name === newEntry.name
  );

  if (existingIndex >= 0) {
    catalog.plugins[existingIndex] = {
      ...catalog.plugins[existingIndex],
      ...newEntry
    };
  } else {
    catalog.plugins.push(newEntry);
  }

  return catalog;
}

export function atomicWriteJsonFile(targetPath, data) {
  const resolvedPath = path.resolve(targetPath);
  const dir = path.dirname(resolvedPath);
  mkdirSync(dir, { recursive: true });

  const tempPath = `${resolvedPath}.tmp.${Date.now()}_${process.pid}`;
  const serialized = JSON.stringify(data, null, 2) + "\n";

  try {
    writeFileSync(tempPath, serialized, "utf8");
    renameSync(tempPath, resolvedPath);
  } catch (error) {
    if (existsSync(tempPath)) {
      try {
        unlinkSync(tempPath);
      } catch {
        // ignore secondary error during cleanup
      }
    }
    throw new Error(`Failed to write marketplace catalog atomically at ${resolvedPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function installPlugin(options = {}) {
  const pluginRoot = options.pluginRoot ? path.resolve(options.pluginRoot) : DEFAULT_ROOT;
  const { manifest, resolvedRoot } = validatePluginFiles(pluginRoot);
  const catalogPath = resolveCatalogPath({
    catalog: options.catalog,
    marketplaceDir: options.marketplaceDir,
    workspaceRoot: pluginRoot
  });

  const entry = buildMarketplaceEntry(resolvedRoot, manifest, { name: options.name });

  let existingCatalog = null;
  if (existsSync(catalogPath)) {
    try {
      existingCatalog = JSON.parse(readFileSync(catalogPath, "utf8"));
    } catch (err) {
      throw new Error(`Failed to parse existing marketplace catalog at ${catalogPath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const isExisting = existingCatalog && Array.isArray(existingCatalog.plugins) &&
    existingCatalog.plugins.some((p) => p && p.name === entry.name);

  const mergedCatalog = mergeMarketplaceCatalog(existingCatalog, entry);

  if (options.dryRun) {
    return {
      dryRun: true,
      action: isExisting ? "would_update" : "would_create",
      catalogPath,
      pluginEntry: entry,
      catalog: mergedCatalog
    };
  }

  atomicWriteJsonFile(catalogPath, mergedCatalog);

  return {
    dryRun: false,
    action: isExisting ? "updated" : "created",
    catalogPath,
    pluginEntry: entry,
    catalog: mergedCatalog
  };
}

export async function runPluginInstallerCli(argv = process.argv.slice(2)) {
  const options = parsePluginInstallerArgs(argv);

  if (options.help) {
    console.log(`
Antigravity MCP Bridge - Local Marketplace Plugin Registration

Usage:
  npm run register:plugin [options]
  node scripts/register-plugin.mjs [options]

Options:
  --catalog <path>          Path to target marketplace.json (default: <workspace>/.agents/plugins/marketplace.json)
  --marketplace-dir <path>  Directory containing marketplace.json
  --name <name>             Plugin name to register (default from plugin.json: antigravity-mcp-bridge)
  --plugin-root <path>      Path to plugin root directory (default: current workspace root)
  --dry-run                 Show the planned registration without modifying any catalog file
  --help, -h                Show this help message

Description:
  Registers a local marketplace entry for Antigravity MCP Bridge discoverable
  by Codex and ChatGPT Desktop.

  By default, registers in the repository-local marketplace:
    <workspace>/.agents/plugins/marketplace.json
  without touching host or user home configurations (~/ or %USERPROFILE%).

  To register directly in your personal marketplace instead, pass:
    npm run register:plugin -- --catalog "$HOME/.agents/plugins/marketplace.json"
  or on Windows:
    npm run register:plugin -- --catalog "%USERPROFILE%\\.agents\\plugins\\marketplace.json"

  Alternatively, register the repository path via Codex CLI:
    codex plugin marketplace add "${DEFAULT_ROOT}"

Alternatives:
  Direct MCP server registration (without marketplace):
    npm run register:codex   # Direct Codex MCP registration
    npm run register:claude  # Direct Claude Code MCP registration
`);
    return;
  }

  const result = installPlugin(options);

  if (result.dryRun) {
    console.log("\n=== Antigravity Bridge Plugin Registration (DRY RUN) ===");
    console.log(`Target Catalog:    ${result.catalogPath}`);
    console.log(`Action:            ${result.action === "would_update" ? "Update existing entry" : "Create new entry"}`);
    console.log(`Plugin Name:       ${result.pluginEntry.name}`);
    console.log(`Resolved Path:     ${result.pluginEntry.source.path}`);
    console.log("\nPlanned Entry in marketplace.json:");
    console.log(JSON.stringify(result.pluginEntry, null, 2));
    console.log("\nPlanned Full Catalog:");
    console.log(JSON.stringify(result.catalog, null, 2));
    console.log("\nNo changes made (--dry-run enabled).\n");
    return;
  }

  console.log(`\nSuccessfully ${result.action} plugin entry "${result.pluginEntry.name}".`);
  console.log(`Catalog location: ${result.catalogPath}`);
  console.log(`Resolved path:    ${result.pluginEntry.source.path}`);
  console.log("\nNotice:");
  console.log("  - In Codex / ChatGPT Desktop, reload or start a new chat/task to discover the plugin.");
  console.log("  - To register in personal marketplace: pass --catalog pointing to ~/.agents/plugins/marketplace.json");
  console.log("  - Or add with Codex CLI: codex plugin marketplace add " + `"${result.pluginEntry.source.path}"\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  runPluginInstallerCli().catch((err) => {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  });
}
