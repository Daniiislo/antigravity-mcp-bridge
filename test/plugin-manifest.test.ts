import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("Agent Plugins Manifests", () => {
  const pluginJsonPath = path.join(root, "plugin.json");
  const mcpJsonPath = path.join(root, "mcp.json");
  const pkgPath = path.join(root, "package.json");

  it("plugin.json exists and satisfies Agent Plugins and OpenAI interface essentials", () => {
    expect(existsSync(pluginJsonPath)).toBe(true);

    const raw = readFileSync(pluginJsonPath, "utf8");
    const plugin = JSON.parse(raw);
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));

    // Schema and identity
    expect(plugin.$schema).toBe("https://agent-plugins.org/schemas/1.0.0/plugin.schema.json");
    expect(plugin.name).toBe(pkg.name);
    expect(plugin.version).toBe(pkg.version);
    expect(typeof plugin.description).toBe("string");
    expect(plugin.description.length).toBeGreaterThan(0);
    expect(plugin.license).toBe(pkg.license);

    // OpenAI interface presentation
    expect(plugin.interface).toBeDefined();
    expect(plugin.interface.displayName).toBe("Antigravity Bridge");
    expect(typeof plugin.interface.shortDescription).toBe("string");
    expect(typeof plugin.interface.longDescription).toBe("string");
    expect(plugin.interface.developerName).toBe("Daniiislo");
    expect(plugin.interface.category).toBe("Development");
    expect(Array.isArray(plugin.interface.capabilities)).toBe(true);
    expect(plugin.interface.capabilities).toContain("Interactive");
    expect(plugin.interface.capabilities).toContain("Write");

    // OpenAI extension namespace
    expect(plugin.extensions?.["com.openai"]?.interface).toBeDefined();
    expect(plugin.extensions["com.openai"].interface.displayName).toBe("Antigravity Bridge");
    expect(plugin.extensions["com.openai"].interface.developerName).toBe("Daniiislo");
  });

  it("mcp.json exists and defines a portable stdio server configuration", () => {
    expect(existsSync(mcpJsonPath)).toBe(true);

    const raw = readFileSync(mcpJsonPath, "utf8");
    const mcp = JSON.parse(raw);

    expect(mcp.$schema).toBe("https://agent-plugins.org/schemas/1.0.0/mcp.schema.json");
    expect(mcp.mcpServers).toBeDefined();
    expect(mcp.mcpServers["antigravity-bridge"]).toBeDefined();

    const server = mcp.mcpServers["antigravity-bridge"];
    expect(server.type).toBe("stdio");
    expect(server.command).toBe("node");
    expect(Array.isArray(server.args)).toBe(true);
    expect(server.args.length).toBeGreaterThanOrEqual(1);

    // Server script must point to relative path within repo
    const serverScript = server.args[0];
    expect(serverScript).toMatch(/^\.?\/?dist\/index\.js$/);

    // Resolved path must exist
    const resolvedScriptPath = path.resolve(root, serverScript);
    expect(existsSync(resolvedScriptPath)).toBe(true);
  });

  it("mcp.json contains no machine-specific absolute paths or drive letters", () => {
    const raw = readFileSync(mcpJsonPath, "utf8");

    // Must not contain machine-specific Windows drive prefixes or user home paths
    // Match a single drive letter followed by colon and slash (e.g. C:\ or F:/), avoiding URL schemes
    expect(raw).not.toMatch(/(?:^|[\s"'`=])([a-zA-Z]:[\\/])/);
    expect(raw).not.toContain("F:\\");
    expect(raw).not.toContain("C:\\");
    expect(raw).not.toContain("C:/");
    expect(raw).not.toContain("/home/");
    expect(raw).not.toContain("/Users/");
  });

  it("plugin.json contains no machine-specific absolute paths", () => {
    const raw = readFileSync(pluginJsonPath, "utf8");

    // Match a single drive letter followed by colon and slash, avoiding URL schemes
    expect(raw).not.toMatch(/(?:^|[\s"'`=])([a-zA-Z]:[\\/])/);
    expect(raw).not.toContain("F:\\");
    expect(raw).not.toContain("C:\\");
    expect(raw).not.toContain("/home/");
    expect(raw).not.toContain("/Users/");
  });

  it("distributable plugin directory matches the shipping layout of known-good plugins", () => {
    // Same shape as mem0's integrations/codex-plugin and overpowers' plugins/overpowers:
    // a dedicated subdirectory holding .codex-plugin/plugin.json + .mcp.json + runtime code,
    // never mixed into the repository root.
    const pluginDir = path.join(root, "plugins", "antigravity-mcp-bridge");
    expect(existsSync(path.join(pluginDir, ".codex-plugin", "plugin.json"))).toBe(true);
    expect(existsSync(path.join(pluginDir, ".mcp.json"))).toBe(true);
    expect(existsSync(path.join(pluginDir, "dist", "index.js"))).toBe(true);

    // Production dependency closure is bundled (same pattern as OpenAI's
    // bundled browser plugin) so installs never run npm — including transitive
    // dependencies the server imports at runtime.
    for (const dep of [
      "@modelcontextprotocol/server",
      "@modelcontextprotocol/ext-tasks",
      "@modelcontextprotocol/core",
      "zod"
    ]) {
      expect(existsSync(path.join(pluginDir, "node_modules", dep))).toBe(true);
    }

    // Root-level plugin.json/mcp.json would shadow the .codex-plugin manifest and
    // break `codex plugin add` with "missing or invalid plugin.json".
    expect(existsSync(path.join(pluginDir, "plugin.json"))).toBe(false);
    expect(existsSync(path.join(pluginDir, "mcp.json"))).toBe(false);

    const pluginManifest = JSON.parse(readFileSync(path.join(pluginDir, ".codex-plugin", "plugin.json"), "utf8"));
    expect(pluginManifest.name).toBe("antigravity-mcp-bridge");
    expect(pluginManifest.mcpServers).toBe("./.mcp.json");

    const mcp = JSON.parse(readFileSync(path.join(pluginDir, ".mcp.json"), "utf8"));
    const server = mcp.mcpServers["antigravity-bridge"];
    expect(server.command).toBe("node");
    expect(server.args[0]).toMatch(/^\.?\/?dist\/index\.js$/);
    expect(existsSync(path.resolve(pluginDir, server.args[0]))).toBe(true);
  });

  it("marketplace.json is portable: relative plugin path, installable from any clone", () => {
    const marketplaceJsonPath = path.join(root, ".agents", "plugins", "marketplace.json");
    expect(existsSync(marketplaceJsonPath)).toBe(true);

    const raw = readFileSync(marketplaceJsonPath, "utf8");
    const marketplace = JSON.parse(raw);

    // The marketplace identity must not leak a development-machine name
    expect(marketplace.name).toBe("antigravity-bridge");

    const entry = marketplace.plugins?.find((p: { name: string }) => p.name === "antigravity-mcp-bridge");
    expect(entry).toBeDefined();

    // The plugin source must be a relative subdirectory so any clone location works
    expect(entry.source.path).toBe("./plugins/antigravity-mcp-bridge");
    expect(existsSync(path.resolve(root, entry.source.path, ".codex-plugin", "plugin.json"))).toBe(true);

    // No machine-specific absolute paths anywhere in the catalog
    expect(raw).not.toMatch(/(?:^|[\s"'`=])([a-zA-Z]:[\\/])/);
    expect(raw).not.toContain("F:\\");
    expect(raw).not.toContain("C:\\");
    expect(raw).not.toContain("C:/");
    expect(raw).not.toContain("/home/");
    expect(raw).not.toContain("/Users/");
  });
});
