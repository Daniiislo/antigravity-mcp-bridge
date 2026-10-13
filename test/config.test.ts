import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, resolveAllowedWorkspace, resolveDefaultRunsDir } from "../src/config.js";

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
  it("uses one per-user runs directory independent of the server start directory", () => {
    const first = mkdtempSync(path.join(tmpdir(), "agy-start-a-"));
    const second = mkdtempSync(path.join(tmpdir(), "agy-start-b-"));
    created.push(first, second);

    const firstCfg = loadConfig({}, first, { resolveExecutable: false });
    const secondCfg = loadConfig({}, second, { resolveExecutable: false });

    expect(firstCfg.runsDir).toBe(resolveDefaultRunsDir({}));
    expect(secondCfg.runsDir).toBe(firstCfg.runsDir);
    expect(firstCfg.runsDir).not.toContain(".antigravity-bridge");
  });

  it("uses platform-appropriate stable per-user locations", () => {
    expect(resolveDefaultRunsDir(
      { LOCALAPPDATA: "C:\\Users\\Ada\\AppData\\Local" },
      "win32",
      "C:\\Users\\Ada"
    )).toBe("C:\\Users\\Ada\\AppData\\Local\\antigravity-mcp-bridge\\runs");

    expect(resolveDefaultRunsDir({}, "darwin", "/Users/ada"))
      .toBe("/Users/ada/Library/Application Support/antigravity-mcp-bridge/runs");
    expect(resolveDefaultRunsDir({ XDG_STATE_HOME: "/var/state/ada" }, "linux", "/home/ada"))
      .toBe("/var/state/ada/antigravity-mcp-bridge/runs");
    expect(resolveDefaultRunsDir({}, "linux", "/home/ada"))
      .toBe("/home/ada/.local/state/antigravity-mcp-bridge/runs");
  });

  it("lets AGY_RUNS_DIR fully override the shared default", () => {
    const customRunsDir = path.join(tmpdir(), "agy-custom-runs");
    const cfg = loadConfig(
      { AGY_RUNS_DIR: customRunsDir },
      process.cwd(),
      { resolveExecutable: false }
    );
    expect(cfg.runsDir).toBe(customRunsDir);
  });

  it("rejects ambiguous boolean and non-positive timeout values", () => {
    expect(() => loadConfig({ AGY_SANDBOX: "sometimes" }, process.cwd())).toThrow(/AGY_SANDBOX/);
    expect(() => loadConfig({ AGY_DEFAULT_TIMEOUT_SECONDS: "0" }, process.cwd())).toThrow(/AGY_DEFAULT_TIMEOUT_SECONDS/);
    expect(() => loadConfig({
      AGY_DEFAULT_INACTIVITY_TIMEOUT_SECONDS: "30",
      AGY_MAX_TURN_SECONDS: "10"
    }, process.cwd())).toThrow(/AGY_MAX_TURN_SECONDS.*inactivity/i);
  });

  it("supports an inactivity timeout plus a separate absolute cap while honoring the legacy alias", () => {
    const defaults = loadConfig({}, process.cwd(), { resolveExecutable: false });
    expect(defaults.defaultTimeoutMs).toBe(300_000);
    expect(defaults.maxTurnTimeoutMs).toBe(600_000);
    expect(defaults.maxSteps).toBeUndefined();
    expect(defaults.maxTurnTokens).toBeUndefined();

    const legacy = loadConfig({ AGY_DEFAULT_TIMEOUT_SECONDS: "45" }, process.cwd(), { resolveExecutable: false });
    expect(legacy.defaultTimeoutMs).toBe(45_000);

    const explicit = loadConfig({
      AGY_DEFAULT_TIMEOUT_SECONDS: "45",
      AGY_DEFAULT_INACTIVITY_TIMEOUT_SECONDS: "20",
      AGY_MAX_TURN_SECONDS: "120"
    }, process.cwd(), { resolveExecutable: false });
    expect(explicit.defaultTimeoutMs).toBe(20_000);
    expect(explicit.maxTurnTimeoutMs).toBe(120_000);
  });

  it("validates configurable step and token budgets", () => {
    const configured = loadConfig({
      AGY_MAX_STEPS: "24",
      AGY_MAX_TURN_TOKENS: "30000"
    }, process.cwd(), { resolveExecutable: false });
    expect(configured.maxSteps).toBe(24);
    expect(configured.maxTurnTokens).toBe(30_000);
    expect(() => loadConfig({ AGY_MAX_STEPS: "0" }, process.cwd(), { resolveExecutable: false }))
      .toThrow(/AGY_MAX_STEPS/);
    expect(() => loadConfig({ AGY_MAX_TURN_TOKENS: "many" }, process.cwd(), { resolveExecutable: false }))
      .toThrow(/AGY_MAX_TURN_TOKENS/);
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
