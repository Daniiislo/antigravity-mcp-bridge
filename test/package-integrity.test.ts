import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("Package Integrity", () => {
  it("packed tarball contains all runtime files referenced by scripts and excludes test/work/docs", () => {
    const raw = execSync("npm pack --dry-run --json", { cwd: root, encoding: "utf8" });
    const parsed = JSON.parse(raw);
    const files: string[] = parsed[0].files.map((f: { path: string }) => f.path);

    // Required files
    expect(files).toContain("scripts/smoke.mjs");
    expect(files).toContain("scripts/register-codex.mjs");
    expect(files).toContain("scripts/register-claude.mjs");
    expect(files).toContain("scripts/register-plugin.mjs");
    expect(files).toContain("scripts/fixtures/fake-agy.mjs");
    expect(files).toContain("plugin.json");
    expect(files).toContain("mcp.json");
    expect(files).toContain("dist/index.js");
    expect(files).toContain("dist/dashboard-server.js");
    expect(files).toContain("dist/dashboard-assets.js");
    expect(files).toContain("dist/installer.js");
    expect(files).toContain("README.md");
    expect(files).toContain("LICENSE");
    expect(files).toContain("package.json");

    // Must NOT contain internal/test/work directories
    for (const f of files) {
      expect(f.startsWith("test/")).toBe(false);
      expect(f.startsWith("work/")).toBe(false);
      expect(f.startsWith("docs/")).toBe(false);
      expect(f.startsWith(".antigravity-bridge/")).toBe(false);
      expect(f.startsWith(".github/")).toBe(false);
      expect(f.endsWith(".log")).toBe(false);
      expect(f.endsWith(".tmp")).toBe(false);
    }
  });

  it("packaged smoke script references an existing packaged fixture", () => {
    const smokePath = path.join(root, "scripts", "smoke.mjs");
    const smokeContent = readFileSync(smokePath, "utf8");
    expect(smokeContent).toMatch(/scripts["'],\s*["']fixtures["'],\s*["']fake-agy\.mjs/);
    expect(smokeContent).not.toContain("test/fixtures/fake-agy.mjs");
    expect(smokeContent).not.toMatch(/test["'],\s*["']fixtures["'],\s*["']fake-agy\.mjs/);
  });

  it("packaged register-codex script references existing dist/installer.js", () => {
    const regPath = path.join(root, "scripts", "register-codex.mjs");
    const regContent = readFileSync(regPath, "utf8");
    expect(regContent).toContain("dist/installer.js");
  });

  it("packaged register-claude script references existing dist/installer.js", () => {
    const regPath = path.join(root, "scripts", "register-claude.mjs");
    expect(readFileSync(regPath, "utf8")).toContain("dist/installer.js");
  });

  it("packaged register-plugin script references root manifests and dist", () => {
    const regPath = path.join(root, "scripts", "register-plugin.mjs");
    const regContent = readFileSync(regPath, "utf8");
    expect(regContent).toContain("plugin.json");
    expect(regContent).toContain("mcp.json");
    expect(regContent).toContain("dist");
  });
});
