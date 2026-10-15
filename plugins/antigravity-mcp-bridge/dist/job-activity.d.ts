/**
 * Pure helpers that derive per-job evidence (denials, tool activity, attention
 * warnings) from raw agy step events. They are shared by the live job record
 * and the NDJSON replay so both paths report the same thing.
 */
export interface ToolActivity {
    tool_calls: number;
    /** Unique files written by file-writing tools (max 20). */
    files_changed: string[];
    commands_run: number;
    tool_errors: number;
}
type StepLike = Record<string, unknown>;
export declare function isCommandTool(name: string): boolean;
export declare function isFileWritingTool(name: string): boolean;
/** Truncate a command/path target so one denial never bloats a payload. */
export declare function boundTarget(target: string): string;
/**
 * Normalized denial entry for a tool step that agy rejected with a permission
 * error, e.g. `ViewFile (read_file): <path>`. Returns undefined otherwise.
 */
export declare function stepDenial(step: StepLike): string | undefined;
/** Add an entry unless an equal or more specific one (with a target) is already present. */
export declare function addDeniedAction(list: string[], entry: string): void;
/** The CommandLine of the most recent command-running step, for attributing a result-level command denial. */
export declare function lastCommandLine(steps: readonly StepLike[]): string | undefined;
/**
 * Attach a target to a result-level denial that has none: a denied command
 * shows no step error, so the closest evidence is the last command step.
 */
export declare function withCommandTarget(entry: string, steps: readonly StepLike[]): string;
/** Summarize one job's tool steps. agy emits several updates per step, so each step_index counts once. */
export declare function summarizeToolActivity(steps: readonly StepLike[]): ToolActivity;
/** The agy stderr line explaining an auto-denied permission, when one was printed. */
export declare function extractStderrHint(stderr: string): string | undefined;
/** The permission named by agy's headless auto-deny stderr line (e.g. `command`), when one was printed. */
export declare function stderrDeniedPermission(stderr: string): string | undefined;
/** Best effort, never throws: the real path when a denied target is a symlink/junction alias of an allowed directory. */
export declare function aliasRealPath(target: string, allowedDirs: readonly string[]): string | undefined;
export interface WarningInput {
    role: "implementer" | "tester";
    status: string;
    deniedActions: readonly string[];
    toolActivity?: ToolActivity | undefined;
    stderrHint?: string | undefined;
    untrustedDeniedBaseline?: boolean | undefined;
    /** Workspace plus configured add-dirs, used to recognise alias paths. */
    allowedDirs?: readonly string[] | undefined;
}
/** Attention signals for a job. These never change the job status. */
export declare function buildJobWarnings(input: WarningInput): string[];
export {};
