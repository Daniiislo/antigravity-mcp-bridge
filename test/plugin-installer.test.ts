import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildMarketplaceEntry,
  installPlugin,
  mergeMarketplaceCatalog,
  parsePluginInstallerArgs,
  resolveCatalogPath,
  validatePluginFiles
  // @ts-ignore
} from "../scripts/register-plugin.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testTmpDir = path.join(root, "test", "fixtures", "tmp-installer-test");

describe("Plugin Installer & Marketplace Registration", () => {
  beforeEach(() => {
    if (existsSync(testTmpDir)) {
      rmSync(testTmpDir, { recursive: true, force: true });
    }
    mkdirSync(testTmpDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testTmpDir)) {
      rmSync(testTmpDir, { recursive: true, force: true });
    }
  });

  describe("parsePluginInstallerArgs", () => {
    it("parses flags correctly including --dry-run, --catalog, --name", () => {
      const parsed = parsePluginInstallerArgs([
        "--catalog", "path/to/custom-marketplace.json",
        "--name", "custom-bridge",
        "--dry-run"
      ]);
      expect(parsed.catalog).toBe("path/to/custom-marketplace.json");
      expect(parsed.name).toBe("custom-bridge");
      expect(parsed.dryRun).toBe(true);
      expect(parsed.help).toBe(false);
    });

    it("parses equals syntax flags", () => {
      const parsed = parsePluginInstallerArgs([
        "--catalog=my-cat.json",
        "--marketplace-dir=some-dir",
        "--name=my-name",
        "--plugin-root=/my/root"
      ]);
      expect(parsed.catalog).toBe("my-cat.json");
      expect(parsed.marketplaceDir).toBe("some-dir");
      expect(parsed.name).toBe("my-name");
      expect(parsed.pluginRoot).toBe("/my/root");
    });

    it("parses help flag", () => {
      expect(parsePluginInstallerArgs(["--help"]).help).toBe(true);
      expect(parsePluginInstallerArgs(["-h"]).help).toBe(true);
    });
  });

  describe("resolveCatalogPath", () => {
    it("resolves explicit catalog path when provided", () => {
      const catalog = path.join(testTmpDir, "custom.json");
      expect(resolveCatalogPath({ catalog })).toBe(path.resolve(catalog));
    });

    it("resolves marketplace.json inside marketplaceDir when provided", () => {
      expect(resolveCatalogPath({ marketplaceDir: testTmpDir })).toBe(
        path.resolve(testTmpDir, "marketplace.json")
      );
    });

    it("defaults to .agents/plugins/marketplace.json inside workspace root", () => {
      const expected = path.join(root, ".agents", "plugins", "marketplace.json");
      expect(resolveCatalogPath({ workspaceRoot: root })).toBe(expected);
    });
  });

  describe("buildMarketplaceEntry", () => {
    it("constructs valid marketplace entry with explicit resolved path", () => {
      const manifest = {
        name: "antigravity-mcp-bridge",
        interface: { category: "Development" }
      };

      const entry = buildMarketplaceEntry(root, manifest);

      expect(entry.name).toBe("antigravity-mcp-bridge");
      expect(entry.source.source).toBe("local");
      expect(entry.source.path).toBe(path.resolve(root));
      expect(entry.policy).toEqual({
        installation: "AVAILABLE",
        authentication: "ON_INSTALL"
      });
      expect(entry.category).toBe("Development");
    });

    it("supports custom name override", () => {
      const manifest = { name: "antigravity-mcp-bridge" };
      const entry = buildMarketplaceEntry(root, manifest, { name: "override-bridge" });
      expect(entry.name).toBe("override-bridge");
    });
  });

  describe("mergeMarketplaceCatalog", () => {
    const sampleEntry = {
      name: "antigravity-mcp-bridge",
      source: { source: "local", path: path.resolve(root) },
      policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
      category: "Development"
    };

    it("creates a new valid catalog structure when catalog is empty or null", () => {
      const catalog = mergeMarketplaceCatalog(null, sampleEntry);
      expect(catalog.name).toBe("local-marketplace");
      expect(catalog.interface.displayName).toBe("Local Plugins");
      expect(catalog.plugins).toHaveLength(1);
      expect(catalog.plugins[0]).toEqual(sampleEntry);
    });

    it("preserves unrelated marketplace entries and catalog metadata", () => {
      const existingCatalog = {
        name: "team-marketplace",
        interface: { displayName: "Team Plugins" },
        plugins: [
          {
            name: "unrelated-tool",
            source: { source: "local", path: "/opt/tools/unrelated" },
            policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
            category: "Utilities"
          },
          {
            name: "another-plugin",
            source: { source: "git", url: "https://example.com/repo.git" }
          }
        ]
      };

      const merged = mergeMarketplaceCatalog(existingCatalog, sampleEntry);

      expect(merged.name).toBe("team-marketplace");
      expect(merged.interface.displayName).toBe("Team Plugins");
      expect(merged.plugins).toHaveLength(3);
      expect(merged.plugins[0]?.name).toBe("unrelated-tool");
      expect(merged.plugins[1]?.name).toBe("another-plugin");
      expect(merged.plugins[2]?.name).toBe("antigravity-mcp-bridge");
    });

    it("is idempotent: updates existing entry in-place without duplicating", () => {
      const initialCatalog = {
        name: "local-marketplace",
        interface: { displayName: "Local Plugins" },
        plugins: [
          {
            name: "antigravity-mcp-bridge",
            source: { source: "local", path: "/old/path" },
            policy: { installation: "NOT_AVAILABLE", authentication: "NONE" },
            category: "Other"
          },
          {
            name: "other-entry",
            source: { source: "local", path: "/other" }
          }
        ]
      };

      const updated = mergeMarketplaceCatalog(initialCatalog, sampleEntry);

      expect(updated.plugins).toHaveLength(2);
      expect(updated.plugins[0]?.name).toBe("antigravity-mcp-bridge");
      expect(updated.plugins[0]?.source.path).toBe(path.resolve(root));
      expect(updated.plugins[0]?.policy.installation).toBe("AVAILABLE");
      expect(updated.plugins[1]?.name).toBe("other-entry");

      // Merging a second time keeps length 2
      const updatedTwice = mergeMarketplaceCatalog(updated, sampleEntry);
      expect(updatedTwice.plugins).toHaveLength(2);
    });
  });

  describe("installPlugin execution and dry-run", () => {
    it("dry-run computes plan and does not modify disk", () => {
      const catalogPath = path.join(testTmpDir, "dry-run-catalog.json");

      const result = installPlugin({
        catalog: catalogPath,
        dryRun: true,
        pluginRoot: root
      });

      expect(result.dryRun).toBe(true);
      expect(result.action).toBe("would_create");
      expect(result.catalogPath).toBe(path.resolve(catalogPath));
      expect(result.pluginEntry.name).toBe("antigravity-mcp-bridge");
      expect(existsSync(catalogPath)).toBe(false);
    });

    it("installs entry into new catalog file atomically", () => {
      const catalogPath = path.join(testTmpDir, "sub", "dir", "marketplace.json");

      const result = installPlugin({
        catalog: catalogPath,
        dryRun: false,
        pluginRoot: root
      });

      expect(result.dryRun).toBe(false);
      expect(result.action).toBe("created");
      expect(existsSync(catalogPath)).toBe(true);

      const written = JSON.parse(readFileSync(catalogPath, "utf8"));
      expect(written.plugins).toHaveLength(1);
      expect(written.plugins[0].name).toBe("antigravity-mcp-bridge");
      expect(written.plugins[0].source.path).toBe(path.resolve(root));
    });

    it("idempotently updates existing catalog file and preserves unrelated entries", () => {
      const catalogPath = path.join(testTmpDir, "existing-marketplace.json");
      const initialCatalog = {
        name: "my-marketplace",
        interface: { displayName: "Existing Marketplace" },
        plugins: [
          {
            name: "existing-service",
            source: { source: "local", path: "/existing/path" }
          }
        ]
      };
      writeFileSync(catalogPath, JSON.stringify(initialCatalog, null, 2), "utf8");

      // First run: should add antigravity-mcp-bridge
      const res1 = installPlugin({
        catalog: catalogPath,
        dryRun: false,
        pluginRoot: root
      });
      expect(res1.action).toBe("created");

      let content = JSON.parse(readFileSync(catalogPath, "utf8"));
      expect(content.plugins).toHaveLength(2);
      expect(content.plugins[0].name).toBe("existing-service");
      expect(content.plugins[1].name).toBe("antigravity-mcp-bridge");

      // Second run: should update existing in place, not duplicate
      const res2 = installPlugin({
        catalog: catalogPath,
        dryRun: false,
        pluginRoot: root
      });
      expect(res2.action).toBe("updated");

      content = JSON.parse(readFileSync(catalogPath, "utf8"));
      expect(content.plugins).toHaveLength(2);
      expect(content.plugins[0].name).toBe("existing-service");
      expect(content.plugins[1].name).toBe("antigravity-mcp-bridge");
    });

    it("validates missing manifests with actionable errors", () => {
      const emptyDir = path.join(testTmpDir, "empty-plugin");
      mkdirSync(emptyDir, { recursive: true });

      expect(() => validatePluginFiles(emptyDir)).toThrow(/plugin\.json not found/);
    });
  });
});
