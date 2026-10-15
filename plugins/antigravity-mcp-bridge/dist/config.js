import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { resolveAgyExecutable } from "./resolve-executable.js";
export function resolveDefaultRunsDir(env = process.env, platform = process.platform, homeDirectory = homedir()) {
    if (platform === "win32") {
        const localAppData = env.LOCALAPPDATA?.trim();
        const base = localAppData || path.win32.join(homeDirectory, "AppData", "Local");
        return path.win32.join(base, "antigravity-mcp-bridge", "runs");
    }
    if (platform === "darwin") {
        return path.posix.join(homeDirectory, "Library", "Application Support", "antigravity-mcp-bridge", "runs");
    }
    const xdgStateHome = env.XDG_STATE_HOME?.trim();
    const base = xdgStateHome || path.posix.join(homeDirectory, ".local", "state");
    return path.posix.join(base, "antigravity-mcp-bridge", "runs");
}
export function resolveCandidateRunsDirs(configuredRunsDir, env = process.env, platform = process.platform, homeDirectory = homedir()) {
    if (configuredRunsDir) {
        return [configuredRunsDir];
    }
    if (env.AGY_RUNS_DIR) {
        return [env.AGY_RUNS_DIR];
    }
    const primary = resolveDefaultRunsDir(env, platform, homeDirectory);
    const candidates = [primary];
    if (platform === "win32") {
        // When Codex Desktop runs on Windows, Windows Desktop Bridge (MSIX) virtualizes
        // LOCALAPPDATA into the package LocalCache folder. Detect this folder so that
        // external terminal tools like `npm run dashboard` can see Codex's runs.
        const pathMod = process.platform === "win32" ? path.win32 : path;
        try {
            const packagesDir = pathMod.join(homeDirectory, "AppData", "Local", "Packages");
            if (existsSync(packagesDir)) {
                const entries = readdirSync(packagesDir);
                for (const entry of entries) {
                    if (entry.toLowerCase().startsWith("openai.codex_")) {
                        const codexRuns = pathMod.join(packagesDir, entry, "LocalCache", "Local", "antigravity-mcp-bridge", "runs");
                        if (existsSync(codexRuns) && !candidates.some((c) => c.toLowerCase() === codexRuns.toLowerCase())) {
                            candidates.push(codexRuns);
                        }
                    }
                }
            }
        }
        catch {
            // Ignore filesystem errors while scanning candidate sandbox packages
        }
        // Also check standard native AppData\Local if primary runsDir was set to package or another folder
        try {
            const nativeStandard = pathMod.join(homeDirectory, "AppData", "Local", "antigravity-mcp-bridge", "runs");
            if (existsSync(nativeStandard) && !candidates.some((c) => c.toLowerCase() === nativeStandard.toLowerCase())) {
                candidates.push(nativeStandard);
            }
        }
        catch {
            // Ignore
        }
        // Also check legacy Codex plugin cache if present
        try {
            const pluginCacheBase = pathMod.join(homeDirectory, ".codex", "plugins", "cache", "local-marketplace", "antigravity-mcp-bridge");
            if (existsSync(pluginCacheBase)) {
                for (const ver of readdirSync(pluginCacheBase)) {
                    const legacyRuns = pathMod.join(pluginCacheBase, ver, ".antigravity-bridge", "runs");
                    if (existsSync(legacyRuns) && !candidates.some((c) => c.toLowerCase() === legacyRuns.toLowerCase())) {
                        candidates.push(legacyRuns);
                    }
                }
            }
        }
        catch {
            // Ignore
        }
    }
    return candidates;
}
function booleanValue(env, name, fallback) {
    const raw = env[name];
    if (raw === undefined || raw === "")
        return fallback;
    if (raw === "true" || raw === "1")
        return true;
    if (raw === "false" || raw === "0")
        return false;
    throw new Error(`${name} must be true, false, 1, or 0`);
}
function positiveInteger(env, name, fallback) {
    const raw = env[name];
    if (raw === undefined || raw === "")
        return fallback;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value <= 0)
        throw new Error(`${name} must be a positive integer`);
    return value;
}
function portNumber(env, name, fallback) {
    const raw = env[name];
    if (raw === undefined || raw === "")
        return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 0 || value > 65535) {
        throw new Error(`${name} must be an integer between 0 and 65535`);
    }
    return value;
}
function optionalEffort(raw) {
    if (!raw)
        return undefined;
    if (["low", "medium", "high", "xhigh", "max"].includes(raw))
        return raw;
    throw new Error("AGY_EFFORT must be low, medium, high, xhigh, or max");
}
/**
 * Per-user configuration file, so marketplace installs (whose working
 * directory is a versioned plugin cache) can still name the real workspace
 * roots Antigravity workers may touch. Env variables keep precedence.
 */
export function resolveUserConfigPath(env = process.env, homeDirectory = homedir()) {
    if (env.AGY_USER_CONFIG)
        return path.resolve(env.AGY_USER_CONFIG);
    return path.join(homeDirectory, ".antigravity-bridge", "config.json");
}
function readUserConfigFile(env, homeDirectory, reader) {
    const file = resolveUserConfigPath(env, homeDirectory);
    if (!existsSync(file))
        return undefined;
    let parsed;
    try {
        parsed = JSON.parse(reader(file));
    }
    catch (error) {
        throw new Error(`${file} is not valid JSON: ${error.message}`);
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`${file} must contain a JSON object`);
    }
    return { file, config: parsed };
}
function parseToolset(value, source) {
    if (value === undefined || value === "")
        return undefined;
    if (value === "core" || value === "full")
        return value;
    throw new Error(`${source} must be "core" or "full"`);
}
/** Read `toolset` from the per-user config file; an invalid value is a hard error. */
export function readUserToolset(env = process.env, homeDirectory = homedir(), reader = (file) => readFileSync(file, "utf8")) {
    const loaded = readUserConfigFile(env, homeDirectory, reader);
    return loaded ? parseToolset(loaded.config.toolset, `${loaded.file}: toolset`) : undefined;
}
function directoryList(value, file, key) {
    if (value === undefined)
        return undefined;
    if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.trim() !== "")) {
        throw new Error(`${file}: ${key} must be an array of directory paths`);
    }
    return value;
}
/**
 * Read `allowed_roots` from the per-user config file. Returns undefined when
 * the file is absent; malformed JSON or a non-array value is a hard error so
 * a typo cannot silently widen or narrow the workspace boundary.
 */
export function readUserAllowedRoots(env = process.env, homeDirectory = homedir(), reader = (file) => readFileSync(file, "utf8")) {
    const loaded = readUserConfigFile(env, homeDirectory, reader);
    return loaded ? directoryList(loaded.config.allowed_roots, loaded.file, "allowed_roots") : undefined;
}
/** Read `add_dirs` (extra worker directories) from the per-user config file; same validation as allowed_roots. */
export function readUserAddDirs(env = process.env, homeDirectory = homedir(), reader = (file) => readFileSync(file, "utf8")) {
    const loaded = readUserConfigFile(env, homeDirectory, reader);
    return loaded ? directoryList(loaded.config.add_dirs, loaded.file, "add_dirs") : undefined;
}
function canonicalDirectory(input, label) {
    try {
        const canonical = realpathSync.native(path.resolve(input));
        if (!statSync(canonical).isDirectory())
            throw new Error("not a directory");
        return canonical;
    }
    catch {
        throw new Error(`${label} must be an existing directory: ${input}`);
    }
}
export function resolveAllowedWorkspace(cwd, roots) {
    const workspace = canonicalDirectory(cwd, "cwd");
    const allowed = roots.map((root) => canonicalDirectory(root, "allowed root"));
    const matches = allowed.some((root) => {
        const relative = path.relative(root, workspace);
        return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
    });
    if (!matches) {
        const hint = [
            `Workspace rejected: ${workspace}`,
            `Allowed roots: ${allowed.join(path.delimiter)}`,
            "To allow it, add the directory to allowed_roots in ~/.antigravity-bridge/config.json (create the file if missing):",
            '  { "allowed_roots": ["<your-project-directory>"] }',
            "or set the AGY_ALLOWED_ROOTS environment variable in your MCP server config, then restart the host."
        ].join("\n");
        throw new Error(hint);
    }
    return workspace;
}
export function loadConfig(env = process.env, startDirectory = process.cwd(), options) {
    const homeDirectory = options?.homeDirectory ?? homedir();
    const sandbox = booleanValue(env, "AGY_SANDBOX", false);
    const dangerouslySkipPermissions = booleanValue(env, "AGY_DANGEROUSLY_SKIP_PERMISSIONS", false);
    const defaultTimeoutMs = (env.AGY_DEFAULT_INACTIVITY_TIMEOUT_SECONDS !== undefined
        ? positiveInteger(env, "AGY_DEFAULT_INACTIVITY_TIMEOUT_SECONDS", 300)
        : positiveInteger(env, "AGY_DEFAULT_TIMEOUT_SECONDS", 300)) * 1_000;
    const maxTurnTimeoutMs = positiveInteger(env, "AGY_MAX_TURN_SECONDS", 1_800) * 1_000;
    if (maxTurnTimeoutMs < defaultTimeoutMs) {
        throw new Error("AGY_MAX_TURN_SECONDS must be greater than or equal to the inactivity timeout");
    }
    const maxStderrBytes = positiveInteger(env, "AGY_MAX_STDERR_BYTES", 32_768);
    const maxSteps = env.AGY_MAX_STEPS ? positiveInteger(env, "AGY_MAX_STEPS", 48) : undefined;
    const maxTurnTokens = env.AGY_MAX_TURN_TOKENS ? positiveInteger(env, "AGY_MAX_TURN_TOKENS", 60_000) : undefined;
    const workerRulesRaw = env.AGY_WORKER_RULES?.trim().toLowerCase();
    if (workerRulesRaw && !["on", "off", "true", "false", "1", "0"].includes(workerRulesRaw)) {
        throw new Error("AGY_WORKER_RULES must be on or off");
    }
    const workerRules = !["off", "false", "0"].includes(workerRulesRaw ?? "");
    const dashboardEnabled = booleanValue(env, "AGY_DASHBOARD_ENABLED", true);
    const dashboardPort = portNumber(env, "AGY_DASHBOARD_PORT", 0);
    // Precedence: AGY_ALLOWED_ROOTS env > per-user config file > user home.
    // A marketplace install's start directory is a versioned plugin cache, so
    // it is never a useful default; the user home keeps workers inside the
    // user's own tree while remaining a single, predictable fallback.
    const fileRoots = readUserAllowedRoots(env, homeDirectory, options?.configReader);
    const configuredRoots = env.AGY_ALLOWED_ROOTS?.split(path.delimiter).filter(Boolean)
        ?? fileRoots
        ?? [homeDirectory];
    const allowedRoots = configuredRoots.map((root) => canonicalDirectory(root, root === homeDirectory ? "user home (default allowed root)" : "AGY_ALLOWED_ROOTS entry"));
    // Same precedence for extra worker directories: AGY_ADD_DIRS env > config file > none.
    const configuredAddDirs = env.AGY_ADD_DIRS?.split(path.delimiter).filter(Boolean)
        ?? readUserAddDirs(env, homeDirectory, options?.configReader)
        ?? [];
    const addDirs = [...new Set(configuredAddDirs.map((dir) => canonicalDirectory(dir, "add_dirs entry")))];
    // Same precedence: AGY_TOOLSET env > config file > core.
    const toolset = parseToolset(env.AGY_TOOLSET?.trim(), "AGY_TOOLSET")
        ?? readUserToolset(env, homeDirectory, options?.configReader)
        ?? "core";
    const model = env.AGY_MODEL || undefined;
    const effort = optionalEffort(env.AGY_EFFORT);
    const agent = env.AGY_AGENT || undefined;
    let baseArgs;
    if (env.AGY_BASE_ARGS_JSON) {
        let parsed;
        try {
            parsed = JSON.parse(env.AGY_BASE_ARGS_JSON);
        }
        catch {
            throw new Error("AGY_BASE_ARGS_JSON must be valid JSON");
        }
        if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
            throw new Error("AGY_BASE_ARGS_JSON must be a JSON array of strings");
        }
        baseArgs = parsed;
    }
    const runsDir = env.AGY_RUNS_DIR || resolveDefaultRunsDir(env);
    let executable;
    if (options?.resolveExecutable === false) {
        executable = env.AGY_BIN || "agy";
    }
    else {
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
        addDirs,
        toolset,
        runsDir,
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
        ...(agent ? { agent } : {}),
        sandbox,
        dangerouslySkipPermissions,
        defaultTimeoutMs,
        maxTurnTimeoutMs,
        ...(maxSteps !== undefined ? { maxSteps } : {}),
        ...(maxTurnTokens !== undefined ? { maxTurnTokens } : {}),
        maxStderrBytes,
        workerRules,
        dashboardEnabled,
        dashboardPort
    };
}
//# sourceMappingURL=config.js.map