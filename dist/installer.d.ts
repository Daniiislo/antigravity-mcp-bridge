import { type ResolveExecutableOptions } from "./resolve-executable.js";
export interface InstallerCliOptions {
    name: string;
    roots: string[];
    agyBin?: string | undefined;
    codexBin?: string | undefined;
    claudeBin?: string | undefined;
    dryRun: boolean;
    help?: boolean | undefined;
}
export interface BuildRegistrationOptions {
    name?: string | undefined;
    roots?: string[] | undefined;
    agyBin?: string | undefined;
    codexBin?: string | undefined;
    claudeBin?: string | undefined;
    serverScriptPath?: string | undefined;
    nodeBin?: string | undefined;
    platform?: NodeJS.Platform | undefined;
    resolveOptions?: ResolveExecutableOptions | undefined;
}
export interface CodexRegistrationPlan {
    name: string;
    command: string;
    args: string[];
    agyBin: string;
    roots: string[];
    rootsString: string;
    nodeBin: string;
    serverScriptPath: string;
    powershellCommand: string;
    bashCommand: string;
    getCommand: string;
    removeCommand: string;
}
export type ClaudeRegistrationPlan = CodexRegistrationPlan;
export interface RegistrationResult {
    dryRun: boolean;
    plan: CodexRegistrationPlan;
    stdout?: string | undefined;
    stderr?: string | undefined;
    exitCode?: number | undefined;
}
export declare function parseInstallerArgs(argv: string[]): InstallerCliOptions;
export declare function validateSafeShellString(value: string, label?: string): void;
export declare function quoteBashArg(arg: string): string;
export declare function quotePowerShellArg(arg: string): string;
export declare function formatBashCommand(parts: string[]): string;
export declare function formatPowerShellCommand(command: string, args: string[]): string;
export declare function buildCodexRegistration(options?: BuildRegistrationOptions): CodexRegistrationPlan;
/**
 * `codex mcp add` has no flag for the per-server tool timeout, so a CLI
 * registration leaves Codex at its 300 s default, which cuts long jobs short.
 * These lines tell the user the one-time config edit that fixes it.
 */
export declare function codexHostConfigHint(name: string, toolTimeoutSeconds?: number): string[];
export declare function buildClaudeRegistration(options?: BuildRegistrationOptions): ClaudeRegistrationPlan;
export declare function executeCodexRegistration(plan: CodexRegistrationPlan, options?: {
    dryRun?: boolean;
    execFn?: (cmd: string, args: string[]) => Promise<{
        stdout: string;
        stderr: string;
        exitCode: number;
    }>;
}): Promise<RegistrationResult>;
export declare const executeClaudeRegistration: typeof executeCodexRegistration;
export declare function runInstallerCli(argv?: string[]): Promise<void>;
export declare function runClaudeInstallerCli(argv?: string[]): Promise<void>;
