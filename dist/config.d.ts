export type Role = "implementer" | "tester";
export interface BridgeConfig {
    executable: string;
    baseArgs?: string[];
    allowedRoots: string[];
    /** Extra directories every worker may read in addition to its workspace (agy --add-dir). */
    addDirs?: string[];
    runsDir?: string;
    model?: string;
    effort?: "low" | "medium" | "high" | "xhigh" | "max";
    agent?: string;
    sandbox: boolean;
    dangerouslySkipPermissions: boolean;
    /** Legacy property name retained for API compatibility; now the inactivity timeout. */
    defaultTimeoutMs: number;
    maxTurnTimeoutMs?: number;
    /** Maximum logical Antigravity steps per turn. */
    maxSteps?: number;
    /** Maximum streamed turn tokens observed before another step may start. */
    maxTurnTokens?: number;
    maxStderrBytes: number;
    dashboardEnabled?: boolean;
    dashboardPort?: number;
}
export declare function resolveDefaultRunsDir(env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform, homeDirectory?: string): string;
export declare function resolveCandidateRunsDirs(configuredRunsDir?: string, env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform, homeDirectory?: string): string[];
/**
 * Per-user configuration file, so marketplace installs (whose working
 * directory is a versioned plugin cache) can still name the real workspace
 * roots Antigravity workers may touch. Env variables keep precedence.
 */
export declare function resolveUserConfigPath(env?: NodeJS.ProcessEnv, homeDirectory?: string): string;
export interface UserConfigFile {
    allowed_roots?: string[];
    add_dirs?: string[];
}
/**
 * Read `allowed_roots` from the per-user config file. Returns undefined when
 * the file is absent; malformed JSON or a non-array value is a hard error so
 * a typo cannot silently widen or narrow the workspace boundary.
 */
export declare function readUserAllowedRoots(env?: NodeJS.ProcessEnv, homeDirectory?: string, reader?: (file: string) => string): string[] | undefined;
/** Read `add_dirs` (extra worker directories) from the per-user config file; same validation as allowed_roots. */
export declare function readUserAddDirs(env?: NodeJS.ProcessEnv, homeDirectory?: string, reader?: (file: string) => string): string[] | undefined;
export declare function resolveAllowedWorkspace(cwd: string, roots: string[]): string;
export declare function loadConfig(env?: NodeJS.ProcessEnv, startDirectory?: string, options?: {
    resolveExecutable?: boolean;
    fileExists?: (p: string) => boolean;
    homeDirectory?: string;
    configReader?: (file: string) => string;
}): BridgeConfig;
