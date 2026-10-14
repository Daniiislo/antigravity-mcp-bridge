/** Check only explicitly requested executables. Never execute probes or reveal PATH. */
export declare function checkRequiredTools(names: string[], env?: NodeJS.ProcessEnv): void;
