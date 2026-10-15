import { type ChildProcessWithoutNullStreams } from "node:child_process";
import type { AgyTerminalResult, DelegationResult } from "./agy-protocol.js";
import type { Role } from "./config.js";
export type AgyWorkerRawEvent = {
    type: "init";
    conversationId?: string | undefined;
    init?: {
        cwd?: string | undefined;
        tools?: string[] | undefined;
    } | undefined;
} | {
    type: "step";
    stepUpdate?: {
        step_index?: number | undefined;
        step_type?: string | undefined;
        state?: string | undefined;
        text_delta?: string | undefined;
        usage?: Partial<import("./agy-protocol.js").AgyUsage> | undefined;
        [k: string]: unknown;
    } | undefined;
} | {
    type: "result";
    result: AgyTerminalResult;
    /**
     * agy reports denied_actions cumulatively per conversation. This is the
     * part added by this turn (empty when the baseline is untrusted).
     */
    deniedDelta?: unknown[] | undefined;
    /** False when the previous turn was interrupted, so the cumulative list cannot be attributed to this turn. */
    deniedBaselineTrusted?: boolean | undefined;
} | {
    type: "stderr";
    text: string;
};
export interface AgyWorkerOptions {
    role: Role;
    cwd: string;
    /** Extra directories passed as additional --add-dir flags. */
    addDirs?: string[] | undefined;
    executable: string;
    prefixArgs?: string[] | undefined;
    mode: "accept-edits" | "plan";
    model?: string | undefined;
    effort?: string | undefined;
    agent?: string | undefined;
    sandbox: boolean;
    dangerouslySkipPermissions: boolean;
    defaultTimeoutMs: number;
    defaultMaxTurnMs?: number | undefined;
    defaultMaxSteps?: number | undefined;
    defaultMaxTokens?: number | undefined;
    maxStderrBytes: number;
    terminateTree?: ((child: ChildProcessWithoutNullStreams) => Promise<void>) | undefined;
    onRawEvent?: ((event: AgyWorkerRawEvent) => void) | undefined;
}
export interface WorkerStatus {
    role: Role;
    state: "idle" | "busy" | "stopped";
    pid?: number | undefined;
    cwd: string;
    conversationId?: string | undefined;
    queueDepth: number;
    completedTurns: number;
    lastResult?: AgyTerminalResult | undefined;
    recentStderr: string;
}
export interface DelegationTimeouts {
    inactivityTimeoutMs?: number | undefined;
    maxDurationMs?: number | undefined;
    maxSteps?: number | undefined;
    maxTokens?: number | undefined;
}
export type TimeoutKind = "inactivity" | "max_duration";
export declare class AgyTimeoutError extends Error {
    readonly timeoutKind: TimeoutKind;
    constructor(kind: TimeoutKind, milliseconds: number);
}
export type BudgetKind = "steps" | "tokens";
export declare class AgyBudgetError extends Error {
    readonly budgetKind: BudgetKind;
    constructor(kind: BudgetKind, limit: number);
}
export declare class AgyWorker {
    private readonly options;
    private child;
    private pending;
    private tail;
    private queueDepth;
    private conversationId;
    private completedTurns;
    private lastResult?;
    private recentStderr;
    private stopGeneration;
    private invalidation;
    private terminating;
    private lastCumulativeUsage;
    private usageBaselineTrusted;
    private lastDeniedCount;
    private deniedBaselineTrusted;
    private unsafeTerminationError;
    constructor(options: AgyWorkerOptions);
    delegate(task: string, timeouts?: number | DelegationTimeouts): Promise<DelegationResult>;
    status(): WorkerStatus;
    stop(): Promise<void>;
    getConversationId(): string | undefined;
    cancelActiveTurn(reason?: string): boolean;
    interruptActiveTurn(error: Error): void;
    /**
     * Request graceful completion of the active turn: the CLI is asked to wrap up
     * and return its terminal result before the hard deadline kills the process.
     * Returns true when a turn is active and a finish request was sent.
     */
    requestGracefulFinish(): boolean;
    private runTurn;
    private ensureStarted;
    private handleLine;
    private appendStderr;
    private resetInactivityTimer;
    private clearPendingTimers;
    private clearConversation;
    private unsafeRestartError;
    private invalidate;
}
