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

  it("marketplace.json is portable: relative plugin path, installable from any clone", () => {
    const marketplaceJsonPath = path.join(root, ".agents", "plugins", "marketplace.json");
    expect(existsSync(marketplaceJsonPath)).toBe(true);

    const raw = readFileSync(marketplaceJsonPath, "utf8");
    const marketplace = JSON.parse(raw);

    // The marketplace identity must not leak a development-machine name
    expect(marketplace.name).toBe("antigravity-bridge");

    const entry = marketplace.plugins?.find((p: { name: string }) => p.name === "antigravity-mcp-bridge");
    expect(entry).toBeDefined();

    // The plugin source must be relative so any clone location works
    expect(entry.source.path).toBe(".");
    expect(() => JSON.stringify(entry.source.path)).not.toThrow();
    expect(existsSync(path.resolve(root, entry.source.path, "plugin.json"))).toBe(true);

    // No machine-specific absolute paths anywhere in the catalog
    expect(raw).not.toMatch(/(?:^|[\s"'`=])([a-zA-Z]:[\\/])/);
    expect(raw).not.toContain("F:\\");
    expect(raw).not.toContain("C:\\");
    expect(raw).not.toContain("C:/");
    expect(raw).not.toContain("/home/");
    expect(raw).not.toContain("/Users/");
  });
});
