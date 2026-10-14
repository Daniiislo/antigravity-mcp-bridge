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
export declare function resolveAllowedWorkspace(cwd: string, roots: string[]): string;
export declare function loadConfig(env?: NodeJS.ProcessEnv, startDirectory?: string, options?: {
    resolveExecutable?: boolean;
    fileExists?: (p: string) => boolean;
}): BridgeConfig;
