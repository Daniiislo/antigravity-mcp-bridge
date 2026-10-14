export interface ResolveExecutableOptions {
    env?: NodeJS.ProcessEnv | undefined;
    platform?: NodeJS.Platform | undefined;
    homedir?: string | undefined;
    cwd?: string | undefined;
    fileExists?: ((filePath: string) => boolean) | undefined;
}
export declare function resolveAgyExecutable(options?: ResolveExecutableOptions): string;
export declare function resolveCodexExecutable(options?: ResolveExecutableOptions): string;
export declare function resolveClaudeExecutable(options?: ResolveExecutableOptions): string;
