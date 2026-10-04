import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, resolveAllowedWorkspace } from "../src/config.js";

const created: string[] = [];
afterEach(() => {
  for (const directory of created.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("workspace boundary", () => {
  it("accepts a real descendant but rejects a sibling sharing the root prefix", () => {
    const base = mkdtempSync(path.join(tmpdir(), "agy-root-"));
    created.push(base);
    const root = path.join(base, "work");
    const child = path.join(root, "project");
    const sibling = path.join(base, "work-evil");
    mkdirSync(child, { recursive: true });
    mkdirSync(sibling);

    expect(resolveAllowedWorkspace(child, [root])).toBe(realpathSync.native(child));
    expect(() => resolveAllowedWorkspace(sibling, [root])).toThrow(/outside allowed roots/i);
  });

  it("rejects a path that is not an existing directory", () => {
    expect(() => resolveAllowedWorkspace(path.join(tmpdir(), "missing-agy-dir"), [tmpdir()])).toThrow(/existing directory/i);
  });
});

describe("configuration", () => {
  it("rejects ambiguous boolean and non-positive timeout values", () => {
    expect(() => loadConfig({ AGY_SANDBOX: "sometimes" }, process.cwd())).toThrow(/AGY_SANDBOX/);
    expect(() => loadConfig({ AGY_DEFAULT_TIMEOUT_SECONDS: "0" }, process.cwd())).toThrow(/AGY_DEFAULT_TIMEOUT_SECONDS/);
  });

  it("resolves executable with explicit AGY_BIN", () => {
    const fakeBin = path.resolve("/custom/tools/agy.exe");
    const cfg = loadConfig(
      { AGY_BIN: fakeBin },
      process.cwd(),
      { fileExists: () => true }
    );
    expect(cfg.executable).toBe(fakeBin);
  });

  it("throws actionable error if executable cannot be resolved", () => {
    expect(() =>
      loadConfig(
        { PATH: "" },
        process.cwd(),
        { fileExists: () => false }
      )
    ).toThrow(/Could not resolve Antigravity executable \(agy\)/);
  });

  it("allows bypassing executable resolution when resolveExecutable is false", () => {
    const cfg = loadConfig(
      {},
      process.cwd(),
      { resolveExecutable: false }
    );
    expect(cfg.executable).toBe("agy");
  });

  it("parses dashboard configuration with safe defaults and validates values", () => {
    const defaultCfg = loadConfig({}, process.cwd(), { resolveExecutable: false });
    expect(defaultCfg.dashboardEnabled).toBe(true);
    expect(defaultCfg.dashboardPort).toBe(0);

    const customCfg = loadConfig(
      { AGY_DASHBOARD_ENABLED: "false", AGY_DASHBOARD_PORT: "8420" },
      process.cwd(),
      { resolveExecutable: false }
    );
    expect(customCfg.dashboardEnabled).toBe(false);
    expect(customCfg.dashboardPort).toBe(8420);

    expect(() => loadConfig({ AGY_DASHBOARD_ENABLED: "maybe" }, process.cwd(), { resolveExecutable: false })).toThrow(/AGY_DASHBOARD_ENABLED/);
    expect(() => loadConfig({ AGY_DASHBOARD_PORT: "-1" }, process.cwd(), { resolveExecutable: false })).toThrow(/AGY_DASHBOARD_PORT/);
    expect(() => loadConfig({ AGY_DASHBOARD_PORT: "70000" }, process.cwd(), { resolveExecutable: false })).toThrow(/AGY_DASHBOARD_PORT/);
    expect(() => loadConfig({ AGY_DASHBOARD_PORT: "not-a-port" }, process.cwd(), { resolveExecutable: false })).toThrow(/AGY_DASHBOARD_PORT/);
  });
});
