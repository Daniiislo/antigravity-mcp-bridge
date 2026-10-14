import EventEmitter from "node:events";
import { type AgyUsage } from "./agy-protocol.js";
export declare function boundText(text: string | undefined, maxChars?: number, suffix?: string): string | undefined;
export declare function sanitizeAggregate(val: unknown, depth?: number, currentChars?: {
    count: number;
}, maxChars?: number, maxDepth?: number, maxKeys?: number, maxArrayElements?: number): unknown;
export declare function boundStepEvent(event: Record<string, unknown>, maxFieldChars?: number): Record<string, unknown>;
export type EventType = "lifecycle" | "init" | "step" | "result" | "stderr";
export interface NormalizedEvent {
    cursor: number;
    timestamp: string;
    eventType: EventType;
    workerId: string;
    jobId?: string | undefined;
    data: Record<string, unknown>;
}
export interface RecordEventInput {
    eventType: EventType;
    workerId: string;
    jobId?: string | undefined;
    data: Record<string, unknown>;
}
export interface EventStoreOptions {
    runsDir: string;
    fallbackRunsDirs?: string[] | undefined;
    maxFieldBytes?: number | undefined;
}
export interface CleanJobsOptions {
    all?: boolean | undefined;
    jobId?: string | undefined;
    workspace?: string | undefined;
    status?: string | string[] | undefined;
    terminalOnly?: boolean | undefined;
    olderThanDays?: number | undefined;
    keep?: number | undefined;
    excludeJobIds?: string[] | undefined;
}
export interface CleanJobsResult {
    deletedCount: number;
    deletedJobIds: string[];
}
export interface JobHistorySummary {
    request_key?: string | undefined;
    request_fingerprint?: string | undefined;
    job_id: string;
    worker_id: string;
    role: string;
    workspace: string;
    status: string;
    brief: string;
    created_at: string;
    started_at?: string | undefined;
    finished_at?: string | undefined;
    duration_seconds?: number | undefined;
    cli_duration_seconds?: number | undefined;
    usage?: AgyUsage | undefined;
    cumulative_usage?: AgyUsage | undefined;
    timeout_kind?: "inactivity" | "max_duration" | undefined;
    budget_kind?: "steps" | "tokens" | undefined;
    max_steps?: number | undefined;
    max_turn_tokens?: number | undefined;
    result?: string | undefined;
    error?: string | undefined;
}
export declare class EventStore extends EventEmitter {
    private currentCursor;
    private readonly events;
    private readonly runsDir;
    private readonly fallbackRunsDirs;
    private readonly maxFieldBytes;
    constructor(options: EventStoreOptions);
    private findJobFile;
    get latestCursor(): number;
    recordEvent(input: RecordEventInput): NormalizedEvent;
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
    readDiskHistory(filter?: {
        workerId?: string | undefined;
        status?: string | undefined;
        limit?: number | undefined;
    }): Promise<JobHistorySummary[]>;
    deleteJob(jobId: string): boolean;
    cleanJobs(options?: CleanJobsOptions): Promise<CleanJobsResult>;
    readDiskJob(jobId: string, options?: {
        stepOffset?: number | undefined;
        stepLimit?: number | undefined;
    }): {
        deadline_at?: string | undefined;
        total_duration_seconds?: number | undefined;
        job_id: string;
        worker_id: string;
        role: "implementer" | "tester";
        workspace: string;
        status: "queued" | "running" | "succeeded" | "failed" | "canceled" | "orphaned";
        brief: string;
        effective_prompt: string;
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
        timeout_kind?: "inactivity" | "max_duration" | undefined;
        budget_kind?: "steps" | "tokens" | undefined;
        last_activity_at?: string | undefined;
        last_progress?: string | undefined;
        total_steps: number;
        step_offset: number;
        step_limit: number;
        has_more_steps: boolean;
        step_events: Array<{
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
    } | undefined;
    readDiskJobEvents(jobId: string): NormalizedEvent[];
    private persistEventToDisk;
    private sanitizeData;
    private sanitizeValue;
}
