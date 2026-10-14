import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, readUserAllowedRoots, resolveAllowedWorkspace, resolveCandidateRunsDirs, resolveDefaultRunsDir, resolveUserConfigPath } from "../src/config.js";

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
    expect(() => resolveAllowedWorkspace(sibling, [root])).toThrow(/Workspace rejected/i);
  });

  it("rejects a path that is not an existing directory", () => {
    expect(() => resolveAllowedWorkspace(path.join(tmpdir(), "missing-agy-dir"), [tmpdir()])).toThrow(/existing directory/i);
  });

  it("explains the fix when a workspace is outside the allowed roots", () => {
    const base = mkdtempSync(path.join(tmpdir(), "agy-hint-"));
    created.push(base);
    const allowed = path.join(base, "allowed");
    const rejected = path.join(base, "rejected");
    mkdirSync(allowed);
    mkdirSync(rejected);

    expect(() => resolveAllowedWorkspace(rejected, [allowed]))
      .toThrow(/config\.json[\s\S]*allowed_roots[\s\S]*AGY_ALLOWED_ROOTS/);
  });
});

describe("per-user config file", () => {
  it("resolves the config path under the user home unless overridden", () => {
    expect(resolveUserConfigPath({}, "C:\\Users\\Ada"))
      .toBe("C:\\Users\\Ada\\.antigravity-bridge\\config.json");
    expect(resolveUserConfigPath({ AGY_USER_CONFIG: "D:\\cfg\\bridge.json" }, "C:\\Users\\Ada"))
      .toBe("D:\\cfg\\bridge.json");
  });

  it("reads allowed_roots from the config file", () => {
    const home = mkdtempSync(path.join(tmpdir(), "agy-home-read-"));
    created.push(home);
    const configDir = path.join(home, ".antigravity-bridge");
    mkdirSync(configDir);
    writeFileSync(
      path.join(configDir, "config.json"),
      JSON.stringify({ allowed_roots: [path.join(home, "projects")] })
    );
    mkdirSync(path.join(home, "projects"));

    expect(readUserAllowedRoots({}, home)).toEqual([path.join(home, "projects")]);
  });

  it("returns undefined when the file is absent or omits allowed_roots", () => {
    const home = mkdtempSync(path.join(tmpdir(), "agy-home-absent-"));
    created.push(home);

    expect(readUserAllowedRoots({}, home)).toBeUndefined();

    const configDir = path.join(home, ".antigravity-bridge");
    mkdirSync(configDir);
    writeFileSync(path.join(configDir, "config.json"), JSON.stringify({}));

    expect(readUserAllowedRoots({}, home)).toBeUndefined();
  });

  it("rejects malformed config files instead of guessing the boundary", () => {
    const home = mkdtempSync(path.join(tmpdir(), "agy-home-bad-"));
    created.push(home);
    const configDir = path.join(home, ".antigravity-bridge");
    mkdirSync(configDir);

    writeFileSync(path.join(configDir, "config.json"), "{ not json");
    expect(() => readUserAllowedRoots({}, home)).toThrow(/not valid JSON/);

    writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ allowed_roots: "C:\\Projects" }));
    expect(() => readUserAllowedRoots({}, home)).toThrow(/allowed_roots must be an array/);
  });

  it("precedence: env beats config file, config file beats user home default", () => {
    const home = mkdtempSync(path.join(tmpdir(), "agy-home-prec-"));
    created.push(home);
    const envRoot = path.join(home, "env-root");
    const fileRoot = path.join(home, "file-root");
    mkdirSync(envRoot);
    mkdirSync(fileRoot);

    const configDir = path.join(home, ".antigravity-bridge");
    mkdirSync(configDir);
    writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ allowed_roots: [fileRoot] }));

    const fromFile = loadConfig({}, process.cwd(), { resolveExecutable: false, homeDirectory: home });
    expect(fromFile.allowedRoots).toEqual([realpathSync.native(fileRoot)]);

    const fromEnv = loadConfig({ AGY_ALLOWED_ROOTS: envRoot }, process.cwd(), { resolveExecutable: false, homeDirectory: home });
    expect(fromEnv.allowedRoots).toEqual([realpathSync.native(envRoot)]);

    rmSync(configDir, { recursive: true, force: true });
    const fromDefault = loadConfig({}, process.cwd(), { resolveExecutable: false, homeDirectory: home });
    expect(fromDefault.allowedRoots).toEqual([realpathSync.native(home)]);
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

  it("discovers candidate runs directories including Windows packaged sandbox storage", () => {
    const fakeHome = mkdtempSync(path.join(tmpdir(), "fake-user-home-"));
    created.push(fakeHome);
    const fakePackageRuns = path.join(
      fakeHome,
      "AppData",
      "Local",
      "Packages",
      "OpenAI.Codex_abc123",
      "LocalCache",
      "Local",
      "antigravity-mcp-bridge",
      "runs"
    );
    mkdirSync(fakePackageRuns, { recursive: true });

    const candidates = resolveCandidateRunsDirs(undefined, {}, "win32", fakeHome);
    expect(candidates.length).toBeGreaterThanOrEqual(2);
    expect(candidates[0]).toBe(path.win32.join(fakeHome, "AppData", "Local", "antigravity-mcp-bridge", "runs"));
    expect(candidates).toContain(fakePackageRuns);
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

  it("does not read the real user's config file in tests", () => {
    // Isolated home so a developer's ~/.antigravity-bridge/config.json can
    // never change what these tests observe. The fake home becomes the
    // allowed-roots fallback, proving no other roots leaked from this machine.
    const fakeHome = mkdtempSync(path.join(tmpdir(), "agy-isolated-home-"));
    created.push(fakeHome);
    const cfg = loadConfig({}, process.cwd(), { resolveExecutable: false, homeDirectory: fakeHome });
    expect(cfg.allowedRoots).toEqual([realpathSync.native(fakeHome)]);
  });

  it("supports an inactivity timeout plus a separate absolute cap while honoring the legacy alias", () => {
    const defaults = loadConfig({}, process.cwd(), { resolveExecutable: false });
    expect(defaults.defaultTimeoutMs).toBe(300_000);
    expect(defaults.maxTurnTimeoutMs).toBe(1_800_000);
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
