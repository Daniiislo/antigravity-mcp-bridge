import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import { resolveAgyExecutable, type ResolveExecutableOptions } from "./resolve-executable.js";

export type Role = "implementer" | "tester";

export interface BridgeConfig {
  executable: string;
  baseArgs?: string[];
  allowedRoots: string[];
  runsDir?: string;
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  agent?: string;
  sandbox: boolean;
  dangerouslySkipPermissions: boolean;
  defaultTimeoutMs: number;
  maxStderrBytes: number;
  dashboardEnabled?: boolean;
  dashboardPort?: number;
}

function booleanValue(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  throw new Error(`${name} must be true, false, 1, or 0`);
}

function positiveInteger(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function portNumber(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 65535) {
    throw new Error(`${name} must be an integer between 0 and 65535`);
  }
  return value;
}

function optionalEffort(raw: string | undefined): BridgeConfig["effort"] {
  if (!raw) return undefined;
  if (["low", "medium", "high", "xhigh", "max"].includes(raw)) return raw as BridgeConfig["effort"];
  throw new Error("AGY_EFFORT must be low, medium, high, xhigh, or max");
}

function canonicalDirectory(input: string, label: string): string {
  try {
    const canonical = realpathSync.native(path.resolve(input));
    if (!statSync(canonical).isDirectory()) throw new Error("not a directory");
    return canonical;
  } catch {
    throw new Error(`${label} must be an existing directory: ${input}`);
  }
}

export function resolveAllowedWorkspace(cwd: string, roots: string[]): string {
  const workspace = canonicalDirectory(cwd, "cwd");
  const allowed = roots.map((root) => canonicalDirectory(root, "allowed root"));
  const matches = allowed.some((root) => {
    const relative = path.relative(root, workspace);
    return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
  });
  if (!matches) throw new Error(`cwd is outside allowed roots: ${workspace}`);
  return workspace;
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  startDirectory = process.cwd(),
  options?: { resolveExecutable?: boolean; fileExists?: (p: string) => boolean }
): BridgeConfig {
  const sandbox = booleanValue(env, "AGY_SANDBOX", false);
  const dangerouslySkipPermissions = booleanValue(env, "AGY_DANGEROUSLY_SKIP_PERMISSIONS", false);
  const defaultTimeoutMs = positiveInteger(env, "AGY_DEFAULT_TIMEOUT_SECONDS", 900) * 1_000;
  const maxStderrBytes = positiveInteger(env, "AGY_MAX_STDERR_BYTES", 32_768);
  const dashboardEnabled = booleanValue(env, "AGY_DASHBOARD_ENABLED", true);
  const dashboardPort = portNumber(env, "AGY_DASHBOARD_PORT", 0);

  const configuredRoots = env.AGY_ALLOWED_ROOTS?.split(path.delimiter).filter(Boolean) ?? [startDirectory];
  const allowedRoots = configuredRoots.map((root) => canonicalDirectory(root, "AGY_ALLOWED_ROOTS entry"));
  const model = env.AGY_MODEL || undefined;
  const effort = optionalEffort(env.AGY_EFFORT);
  const agent = env.AGY_AGENT || undefined;
  let baseArgs: string[] | undefined;
  if (env.AGY_BASE_ARGS_JSON) {
    let parsed: unknown;
    try { parsed = JSON.parse(env.AGY_BASE_ARGS_JSON); } catch { throw new Error("AGY_BASE_ARGS_JSON must be valid JSON"); }
    if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
      throw new Error("AGY_BASE_ARGS_JSON must be a JSON array of strings");
    }
    baseArgs = parsed;
  }
  const runsDir = env.AGY_RUNS_DIR || path.join(startDirectory, ".antigravity-bridge", "runs");

  let executable: string;
  if (options?.resolveExecutable === false) {
    executable = env.AGY_BIN || "agy";
  } else {
    executable = resolveAgyExecutable({
      env,
      cwd: startDirectory,
      ...(options?.fileExists ? { fileExists: options.fileExists } : {})
    });
  }

  return {
    executable,
    ...(baseArgs ? { baseArgs } : {}),
    allowedRoots,
    runsDir,
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(agent ? { agent } : {}),
    sandbox,
    dangerouslySkipPermissions,
    defaultTimeoutMs,
    maxStderrBytes,
    dashboardEnabled,
    dashboardPort
  };
}
