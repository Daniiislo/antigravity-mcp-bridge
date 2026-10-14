import { type AgyUsage, type DelegationResult } from "./agy-protocol.js";
import { type BudgetKind, type TimeoutKind, type WorkerStatus } from "./agy-worker.js";
import { type BridgeConfig, type Role } from "./config.js";
import { type CleanJobsOptions, type CleanJobsResult, type JobHistorySummary, type NormalizedEvent } from "./event-store.js";
import { type ListModelsResult } from "./model-catalog.js";
import { DashboardServer } from "./dashboard-server.js";
export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "canceled" | "orphaned";
export interface DispatchOptions {
    requestKey?: string | undefined;
    totalDurationSeconds?: number | undefined;
}
export interface DispatchTaskResult {
    jobId: string;
    workerId: string;
    role: Role;
    status: JobStatus;
    /** Advisory: present when the brief looks like multiple bundled workstreams. */
    warnings?: string[];
}
export interface CreateWorkerOptions {
    requiredTools?: string[] | undefined;
    role: Role;
    workspace: string;
    model?: string | undefined;
    effort?: BridgeConfig["effort"] | undefined;
    constraints?: string | undefined;
}
export interface ExplicitWorkerInfo {
    workerId: string;
    role: Role;
    workspace: string;
    model?: string | undefined;
    effort?: string | undefined;
    hasConstraints: boolean;
    status: "idle" | "busy" | "closed";
    conversationId?: string | undefined;
    createdAt: string;
}
export interface JobRecord {
    jobId: string;
    workerId: string;
    role: Role;
    workspace: string;
    brief: string;
    effectivePrompt: string;
    timeoutMs?: number | undefined;
    maxDurationMs?: number | undefined;
    maxSteps?: number | undefined;
    maxTurnTokens?: number | undefined;
    requestKey?: string | undefined;
    requestFingerprint?: string | undefined;
    deadlineTimer?: NodeJS.Timeout | undefined;
    gracefulFinishTimer?: NodeJS.Timeout | undefined;
    deadlineAt?: string | undefined;
    totalDurationSeconds?: number | undefined;
    status: JobStatus;
    createdAt: string;
    startedAt?: string | undefined;
    finishedAt?: string | undefined;
    durationSeconds?: number | undefined;
    cliDurationSeconds?: number | undefined;
    usage?: AgyUsage | undefined;
    cumulativeUsage?: AgyUsage | undefined;
    result?: string | undefined;
    error?: string | undefined;
    conversationId?: string | undefined;
    timeoutKind?: TimeoutKind | undefined;
    budgetKind?: BudgetKind | undefined;
    lastActivityAt?: string | undefined;
    lastProgress?: string | undefined;
    stepEvents: Array<{
        step_type?: string | undefined;
        state?: string | undefined;
        text_delta?: string | undefined;
        [k: string]: unknown;
    }>;
    deniedActions: string[];
}
export interface WaitTaskResult {
    job_id: string;
    worker_id: string;
    status: JobStatus;
    terminal: boolean;
    cursor: number;
    events: NormalizedEvent[];
}
export type TerminalTaskResult = InspectTaskResult & {
    terminal: true;
};
export interface InspectTaskOptions {
    includePrompt?: boolean | undefined;
    includeSteps?: boolean | undefined;
    stepOffset?: number | undefined;
    stepLimit?: number | undefined;
}
export interface InspectTaskResult {
    deadline_at?: string | undefined;
    total_duration_seconds?: number | undefined;
    job_id: string;
    worker_id: string;
    role: Role;
    workspace: string;
    status: JobStatus;
    brief?: string | undefined;
    effective_prompt?: string | undefined;
    created_at: string;
    started_at?: string | undefined;
    finished_at?: string | undefined;
    duration_seconds?: number | undefined;
    cli_duration_seconds?: number | undefined;
    inactivity_timeout_seconds?: number | undefined;
    max_duration_seconds?: number | undefined;
    max_steps?: number | undefined;
    max_turn_tokens?: number | undefined;
    conversation_id?: string | undefined;
    timeout_kind?: TimeoutKind | undefined;
    budget_kind?: BudgetKind | undefined;
    last_activity_at?: string | undefined;
    last_progress?: string | undefined;
    total_steps: number;
    step_offset?: number | undefined;
    step_limit?: number | undefined;
    has_more_steps?: boolean | undefined;
    step_events?: Array<{
        step_type?: string | undefined;
        state?: string | undefined;
        text_delta?: string | undefined;
        [k: string]: unknown;
    }>;
    total_denied_actions: number;
    denied_actions: string[];
    has_more_denied_actions: boolean;
    usage?: AgyUsage | undefined;
    cumulative_usage?: AgyUsage | undefined;
    result?: string | undefined;
    error?: string | undefined;
    caller_payload_chars: number;
    response_char_budget: number;
    response_truncated: boolean;
}
export declare class WorkerManager {
    private readonly config;
    private readonly prefixArgs;
    private readonly implicitWorkers;
    private readonly explicitWorkers;
    private readonly jobs;
    private requestHistory?;
    private readonly eventStore;
    private readonly modelCatalog;
    private readonly runsDir;
    private readonly fallbackRunsDirs;
    private dashboardServer?;
    private workerCounter;
    private jobCounter;
    constructor(config: BridgeConfig, prefixArgs?: string[], options?: {
        runsDir?: string | undefined;
        fallbackRunsDirs?: string[] | undefined;
    });
    getRunsDir(): string;
    getFallbackRunsDirs(): string[];
    listModels(options?: {
        refresh?: boolean | undefined;
    }): Promise<ListModelsResult>;
    getRuntimeInfo(): {
        build_id: string;
        wait_mode: string;
        inactivity_seconds: number;
        maximum_turn_seconds: number;
        steps_budget: number | null;
        observed_token_budget: number | null;
        tasks_capability_gated: boolean;
    };
    /**
     * Usage protocol served to the host agent through the MCP initialize result.
     * Generated from live config so every bridge version teaches its own current
     * rules — no external skill or cached documentation can drift from it.
     */
    serverInstructions(): string;
    createWorker(options: CreateWorkerOptions): Promise<ExplicitWorkerInfo>;
    dispatchTask(workerId: string, brief: string, timeoutSeconds?: number | undefined, maxDurationSeconds?: number | undefined, options?: DispatchOptions): Promise<DispatchTaskResult>;
    /**
     * Heuristic advisory for briefs that bundle several workstreams into one
     * turn. Evidence from failed runs: briefs mixing 3-4 workstreams with many
     * file targets (2.5k-4.5k chars) died at the deadline while focused
     * single-workstream briefs finished comfortably. Warn so the controller can
     * split into sequential dispatches on the same worker (conversation persists
     * between jobs, so context is not lost).
     */
    private briefWarnings;
    sendFollowup(workerId: string, finding: string, timeoutSeconds?: number | undefined, maxDurationSeconds?: number | undefined, options?: DispatchOptions): Promise<{
        jobId: string;
        workerId: string;
        role: Role;
        status: JobStatus;
    }>;
    waitTask(jobId: string, options?: {
        waitMs?: number | undefined;
        afterCursor?: number | undefined;
    }): Promise<WaitTaskResult>;
    waitTaskUntilTerminal(jobId: string, options?: {
        signal?: AbortSignal | undefined;
    }): Promise<TerminalTaskResult>;
    private waitAbortedError;
    inspectTask(jobId: string, options?: InspectTaskOptions): InspectTaskResult;
    hasLiveJob(jobId: string): boolean;
    private compactInspection;
    private elapsedSeconds;
    cancelTask(jobId: string): Promise<{
        jobId: string;
        status: JobStatus;
        active: boolean;
    }>;
    closeWorker(workerId: string): Promise<{
        workerId: string;
        status: "closed";
    }>;
    getEvents(filter: {
        workerId?: string | undefined;
        jobId?: string | undefined;
        afterCursor?: number | undefined;
        limit?: number | undefined;
    }): {
        events: NormalizedEvent[];
        latest_cursor: number;
        has_more: boolean;
    };
    getHistory(filter?: {
        workerId?: string | undefined;
        status?: string | undefined;
        limit?: number | undefined;
    }): Promise<{
        jobs: JobHistorySummary[];
    }>;
    getExplicitWorkersList(): Array<{
        workerId: string;
        role: Role;
        workspace: string;
        model?: string | undefined;
        effort?: string | undefined;
        constraints?: string | undefined;
        status: string;
        createdAt: string;
        queueDepth: number;
    }>;
    getJobDetail(jobId: string): Record<string, unknown> | undefined;
    getDashboardUrl(options?: {
        workerId?: string | undefined;
        jobId?: string | undefined;
        workspace?: string | undefined;
    }): Promise<string | undefined>;
    getDashboardServer(): DashboardServer | undefined;
    deleteJob(jobId: string): Promise<{
        success: boolean;
        jobId: string;
    }>;
    cleanJobs(options?: CleanJobsOptions): Promise<CleanJobsResult>;
    delegate(role: Role, task: string, cwd: string, timeoutSeconds?: number | undefined, maxDurationSeconds?: number | undefined): Promise<DelegationResult>;
    status(role?: Role | undefined): WorkerStatus[];
    stop(role?: Role | undefined): Promise<void>;
    reset(role?: Role | undefined): Promise<void>;
    private handleRawWorkerEvent;
    private expireQueuedJob;
    private processWorkerQueue;
}
