/**
 * Read-only Codex configuration self-check. The bridge cannot change the host,
 * but a missing direct-only namespace or a short tool timeout silently turns
 * one `wait_task` into model-driven polling, so it warns instead. Every failure
 * path (no file, unreadable, unparseable) yields no warning and never throws.
 */
export interface CodexServerEntry {
    name: string;
    command?: string | undefined;
    args: string[];
    toolTimeoutSec?: number | undefined;
}
export interface CodexConfigSummary {
    /** Undefined when the key is absent. */
    directOnlyNamespaces?: string[] | undefined;
    servers: CodexServerEntry[];
}
/**
 * Targeted TOML reader: only `features.code_mode.direct_only_tool_namespaces`
 * and the command/args/tool_timeout_sec of each `mcp_servers.<name>` table.
 * Everything else is skipped.
 */
export declare function parseCodexConfig(text: string): CodexConfigSummary;
export declare function resolveCodexConfigPath(env?: NodeJS.ProcessEnv, homeDirectory?: string): string;
export interface HostCheckOptions {
    clientName: string | undefined;
    env?: NodeJS.ProcessEnv | undefined;
    homeDirectory?: string | undefined;
    /** Job budget in seconds; a registered server timeout must exceed it. */
    budgetSeconds?: number | undefined;
    reader?: ((file: string) => string) | undefined;
}
export declare function hostWarnings(options: HostCheckOptions): string[];
