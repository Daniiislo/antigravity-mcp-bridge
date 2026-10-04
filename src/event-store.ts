import EventEmitter from "node:events";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { normalizeDeniedAction, type AgyUsage } from "./agy-protocol.js";

export function boundText(
  text: string | undefined,
  maxChars = 32_768,
  suffix = " ... [truncated]"
): string | undefined {
  if (text === undefined) return undefined;
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + suffix;
}

export function boundStepEvent(
  event: Record<string, unknown>,
  maxFieldChars = 4_096
): Record<string, unknown> {
  const bounded: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(event)) {
    if (typeof v === "string") {
      bounded[k] = v.length > maxFieldChars
        ? v.slice(0, maxFieldChars) + " ... [truncated]"
        : v;
    } else if (v && typeof v === "object") {
      try {
        const str = JSON.stringify(v);
        if (str.length > maxFieldChars) {
          bounded[k] = { ...((v as Record<string, unknown>) || {}), _truncated: true };
        } else {
          bounded[k] = v;
        }
      } catch {
        bounded[k] = v;
      }
    } else {
      bounded[k] = v;
    }
  }
  return bounded;
}

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
  maxFieldBytes?: number | undefined;
}

export interface JobHistorySummary {
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
  usage?: AgyUsage | undefined;
  result?: string | undefined;
  error?: string | undefined;
}

const FORBIDDEN_ENV_KEYS = new Set([
  "env",
  "processenv",
  "process_env",
  "environment",
  "node_env"
]);

export class EventStore extends EventEmitter {
  private currentCursor = 0;
  private readonly events: NormalizedEvent[] = [];
  private readonly runsDir: string;
  private readonly maxFieldBytes: number;

  constructor(options: EventStoreOptions) {
    super();
    this.runsDir = options.runsDir;
    this.maxFieldBytes = options.maxFieldBytes ?? 32_768;
  }

  recordEvent(input: RecordEventInput): NormalizedEvent {
    this.currentCursor += 1;
    const sanitizedData = this.sanitizeData(input.data);
    const event: NormalizedEvent = {
      cursor: this.currentCursor,
      timestamp: new Date().toISOString(),
      eventType: input.eventType,
      workerId: input.workerId,
      ...(input.jobId ? { jobId: input.jobId } : {}),
      data: sanitizedData
    };

    this.events.push(event);

    if (input.jobId) {
      this.persistEventToDisk(input.jobId, event);
    }

    this.emit("event", event);
    if (input.jobId) {
      this.emit(`job:${input.jobId}`, event);
    }

    return event;
  }

  getEvents(filter: {
    workerId?: string | undefined;
    jobId?: string | undefined;
    afterCursor?: number | undefined;
    limit?: number | undefined;
  }): { events: NormalizedEvent[]; latest_cursor: number; has_more: boolean } {
    let matched = this.events;

    if (filter.workerId) {
      matched = matched.filter((e) => e.workerId === filter.workerId);
    }
    if (filter.jobId) {
      matched = matched.filter((e) => e.jobId === filter.jobId);
    }
    if (filter.afterCursor !== undefined) {
      matched = matched.filter((e) => e.cursor > filter.afterCursor!);
    }

    const limit = filter.limit ?? 50;
    const hasMore = matched.length > limit;
    const paged = matched.slice(0, limit);

    return {
      events: paged,
      latest_cursor: this.currentCursor,
      has_more: hasMore
    };
  }

  async readDiskHistory(filter?: {
    workerId?: string | undefined;
    status?: string | undefined;
    limit?: number | undefined;
  }): Promise<JobHistorySummary[]> {
    if (!existsSync(this.runsDir)) return [];

    let files: string[] = [];
    try {
      files = readdirSync(this.runsDir).filter((f) => f.endsWith(".ndjson"));
    } catch (err) {
      console.error(`[antigravity-mcp-bridge] Failed to read runs directory: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }

    const summaries: JobHistorySummary[] = [];

    for (const file of files) {
      const filePath = path.join(this.runsDir, file);
      try {
        const content = readFileSync(filePath, "utf8");
        const lines = content.split(/\r?\n/).filter((line) => line.trim().length > 0);
        if (lines.length === 0) continue;

        let jobId = "";
        let workerId = "";
        let role = "implementer";
        let workspace = "";
        let status = "queued";
        let brief = "";
        let createdAt = "";
        let startedAt: string | undefined;
        let finishedAt: string | undefined;
        let durationSeconds: number | undefined;
        let usage: AgyUsage | undefined;
        let result: string | undefined;
        let error: string | undefined;

        for (const line of lines) {
          try {
            const evt = JSON.parse(line) as NormalizedEvent;
            if (evt.jobId) jobId = evt.jobId;
            if (evt.workerId) workerId = evt.workerId;
            const d = evt.data || {};

            if (evt.eventType === "lifecycle") {
              const state = (d.state || d.lifecycle) as string | undefined;
              if (state === "queued") {
                if (d.role) role = String(d.role);
                if (d.workspace) workspace = String(d.workspace);
                if (d.brief) brief = String(d.brief);
                if (!createdAt) createdAt = (d.created_at as string) || evt.timestamp;
                status = "queued";
              } else if (state === "started" || state === "running") {
                status = "running";
                if (!startedAt) startedAt = (d.started_at as string) || evt.timestamp;
              } else if (state === "succeeded") {
                status = "succeeded";
                finishedAt = (d.finished_at as string) || evt.timestamp;
                if (typeof d.duration_seconds === "number") durationSeconds = d.duration_seconds;
                if (typeof d.response === "string") result = d.response;
                if (d.usage) usage = d.usage as AgyUsage;
              } else if (state === "failed") {
                status = "failed";
                finishedAt = (d.finished_at as string) || evt.timestamp;
                if (typeof d.error === "string") error = d.error;
              } else if (state === "canceled") {
                status = "canceled";
                finishedAt = (d.finished_at as string) || evt.timestamp;
              }
            } else if (evt.eventType === "result") {
              const resStatus = d.status as string | undefined;
              if (resStatus === "SUCCESS") {
                status = "succeeded";
                if (typeof d.response === "string") result = d.response;
              } else {
                status = "failed";
                if (typeof d.error === "string") error = d.error;
              }
              finishedAt = evt.timestamp;
              if (typeof d.duration_seconds === "number") durationSeconds = d.duration_seconds;
              if (d.usage) usage = d.usage as AgyUsage;
            }
          } catch {
            // Ignore malformed line
          }
        }

        if (jobId) {
          summaries.push({
            job_id: jobId,
            worker_id: workerId,
            role,
            workspace,
            status,
            brief,
            created_at: createdAt || new Date().toISOString(),
            ...(startedAt ? { started_at: startedAt } : {}),
            ...(finishedAt ? { finished_at: finishedAt } : {}),
            ...(durationSeconds !== undefined ? { duration_seconds: durationSeconds } : {}),
            ...(usage ? { usage } : {}),
            ...(result ? { result } : {}),
            ...(error ? { error } : {})
          });
        }
      } catch (err) {
        console.error(`[antigravity-mcp-bridge] Failed to read run file ${file}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    let filtered = summaries;
    if (filter?.workerId) {
      filtered = filtered.filter((s) => s.worker_id === filter.workerId);
    }
    if (filter?.status) {
      filtered = filtered.filter((s) => s.status === filter.status);
    }

    // Sort newest first by created_at (or finished_at)
    filtered.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

    const limit = filter?.limit ?? 20;
    return filtered.slice(0, limit);
  }

  readDiskJob(
    jobId: string,
    options?: { stepOffset?: number | undefined; stepLimit?: number | undefined }
  ): {
    job_id: string;
    worker_id: string;
    role: "implementer" | "tester";
    workspace: string;
    status: "queued" | "running" | "succeeded" | "failed" | "canceled";
    brief: string;
    effective_prompt: string;
    created_at: string;
    started_at?: string | undefined;
    finished_at?: string | undefined;
    duration_seconds?: number | undefined;
    conversation_id?: string | undefined;
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
    result?: string | undefined;
    error?: string | undefined;
  } | undefined {
    if (!jobId || !existsSync(this.runsDir)) return undefined;

    const filePath = path.join(this.runsDir, `${jobId}.ndjson`);
    if (!existsSync(filePath)) return undefined;

    try {
      const content = readFileSync(filePath, "utf8");
      const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
      if (lines.length === 0) return undefined;

      let workerId = "";
      let role: "implementer" | "tester" = "implementer";
      let workspace = "";
      let status: "queued" | "running" | "succeeded" | "failed" | "canceled" = "queued";
      let brief = "";
      let effectivePrompt = "";
      let createdAt = "";
      let startedAt: string | undefined;
      let finishedAt: string | undefined;
      let durationSeconds: number | undefined;
      let conversationId: string | undefined;
      const stepEvents: Array<{
        step_type?: string | undefined;
        state?: string | undefined;
        text_delta?: string | undefined;
        [k: string]: unknown;
      }> = [];
      const deniedActions: string[] = [];
      let usage: AgyUsage | undefined;
      let result: string | undefined;
      let error: string | undefined;

      for (const line of lines) {
        try {
          const evt = JSON.parse(line) as NormalizedEvent;
          if (evt.workerId) workerId = evt.workerId;
          const d = evt.data || {};

          if (evt.eventType === "lifecycle") {
            const state = (d.state || d.lifecycle) as string | undefined;
            if (state === "queued") {
              if (d.role === "implementer" || d.role === "tester") role = d.role;
              if (d.workspace) workspace = String(d.workspace);
              if (d.brief) brief = String(d.brief);
              if (d.effective_prompt) effectivePrompt = String(d.effective_prompt);
              if (!createdAt) createdAt = (d.created_at as string) || evt.timestamp;
              status = "queued";
            } else if (state === "started" || state === "running") {
              status = "running";
              if (!startedAt) startedAt = (d.started_at as string) || evt.timestamp;
            } else if (state === "succeeded") {
              status = "succeeded";
              finishedAt = (d.finished_at as string) || evt.timestamp;
              if (typeof d.duration_seconds === "number") durationSeconds = d.duration_seconds;
              if (typeof d.response === "string") result = d.response;
              if (d.usage) usage = d.usage as AgyUsage;
              if (typeof d.conversation_id === "string") conversationId = d.conversation_id;
            } else if (state === "failed") {
              status = "failed";
              finishedAt = (d.finished_at as string) || evt.timestamp;
              if (typeof d.error === "string") error = d.error;
            } else if (state === "canceled") {
              status = "canceled";
              finishedAt = (d.finished_at as string) || evt.timestamp;
            }
            if (Array.isArray(d.denied_actions)) {
              for (const item of d.denied_actions) {
                const norm = normalizeDeniedAction(item);
                if (norm && !deniedActions.includes(norm)) {
                  deniedActions.push(norm);
                }
              }
            }
          } else if (evt.eventType === "init") {
            if (typeof d.conversation_id === "string") conversationId = d.conversation_id;
          } else if (evt.eventType === "step") {
            stepEvents.push(d);
            const stateStr = String(d.state || "");
            const stepTypeStr = String(d.step_type || "");
            const textDeltaStr = String(d.text_delta || "");
            if (
              stateStr.toUpperCase() === "DENIED" ||
              stepTypeStr.toLowerCase().includes("permission") ||
              textDeltaStr.toLowerCase().includes("permission denied")
            ) {
              const norm = normalizeDeniedAction(textDeltaStr || stateStr);
              if (norm && !deniedActions.includes(norm)) {
                deniedActions.push(norm);
              }
            }
          } else if (evt.eventType === "result") {
            if (typeof d.conversation_id === "string") conversationId = d.conversation_id;
            const resStatus = d.status as string | undefined;
            if (resStatus === "SUCCESS") {
              const resText = typeof d.response === "string" ? d.response : "";
              if (!resText.trim()) {
                status = "failed";
                if (!error) error = "Antigravity returned SUCCESS with an empty response";
              } else {
                status = "succeeded";
                result = resText;
              }
            } else if (resStatus && resStatus !== "SUCCESS") {
              status = "failed";
              if (typeof d.error === "string") error = d.error;
            }
            finishedAt = evt.timestamp;
            if (typeof d.duration_seconds === "number") durationSeconds = d.duration_seconds;
            if (d.usage) usage = d.usage as AgyUsage;

            const resDenied = Array.isArray(d.denied_actions)
              ? d.denied_actions
              : (Array.isArray(d.deniedActions) ? d.deniedActions : undefined);
            if (resDenied) {
              for (const item of resDenied) {
                const norm = normalizeDeniedAction(item);
                if (norm && !deniedActions.includes(norm)) {
                  deniedActions.push(norm);
                }
              }
            }
          }
        } catch {
          // Ignore malformed line
        }
      }

      const MAX_DENIED = 20;
      const totalDenied = deniedActions.length;
      const slicedDenied = deniedActions.slice(0, MAX_DENIED);
      const hasMoreDenied = totalDenied > slicedDenied.length;

      const offset = Math.max(options?.stepOffset ?? 0, 0);
      const limit = Math.min(Math.max(options?.stepLimit ?? 20, 1), 100);
      const totalSteps = stepEvents.length;
      const slicedSteps = stepEvents.slice(offset, offset + limit);
      const hasMoreSteps = totalSteps > offset + slicedSteps.length;
      const boundedSteps = slicedSteps.map((evt) => boundStepEvent(evt, 4_096));

      return {
        job_id: jobId,
        worker_id: workerId,
        role,
        workspace,
        status,
        brief: boundText(brief, 8_192) ?? "",
        effective_prompt: boundText(effectivePrompt || brief, 16_384) ?? "",
        created_at: createdAt || new Date().toISOString(),
        ...(startedAt ? { started_at: startedAt } : {}),
        ...(finishedAt ? { finished_at: finishedAt } : {}),
        ...(durationSeconds !== undefined ? { duration_seconds: durationSeconds } : {}),
        ...(conversationId ? { conversation_id: conversationId } : {}),
        total_steps: totalSteps,
        step_offset: offset,
        step_limit: limit,
        has_more_steps: hasMoreSteps,
        step_events: boundedSteps,
        total_denied_actions: totalDenied,
        denied_actions: slicedDenied,
        has_more_denied_actions: hasMoreDenied,
        ...(usage ? { usage } : {}),
        ...(result !== undefined ? { result: boundText(result, 32_768) } : {}),
        ...(error !== undefined ? { error: boundText(error, 16_384) } : {})
      };
    } catch (err) {
      console.error(`[antigravity-mcp-bridge] Failed to read job file ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }

  private persistEventToDisk(jobId: string, event: NormalizedEvent): void {
    try {
      if (!existsSync(this.runsDir)) {
        mkdirSync(this.runsDir, { recursive: true });
      }
      const filePath = path.join(this.runsDir, `${jobId}.ndjson`);
      const line = JSON.stringify(event) + "\n";
      appendFileSync(filePath, line, "utf8");
    } catch (err) {
      // Security/reliability invariant: logging failure is reported but does not throw or change agent result
      console.error(`[antigravity-mcp-bridge] Failed to append event to run log: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private sanitizeData(data: Record<string, unknown>): Record<string, unknown> {
    const clean: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(data)) {
      if (FORBIDDEN_ENV_KEYS.has(key.toLowerCase())) {
        continue;
      }
      clean[key] = this.sanitizeValue(value);
    }

    return clean;
  }

  private sanitizeValue(value: unknown): unknown {
    if (typeof value === "string") {
      if (value.length > this.maxFieldBytes) {
        return value.slice(0, this.maxFieldBytes) + " ... [truncated]";
      }
      return value;
    }

    if (Array.isArray(value)) {
      return value.map((item) => this.sanitizeValue(item));
    }

    if (value && typeof value === "object") {
      // Don't log process.env or process objects
      if (value === process.env || (value as { env?: unknown }).env !== undefined) {
        return undefined;
      }
      const obj = value as Record<string, unknown>;
      const cleaned: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj)) {
        if (FORBIDDEN_ENV_KEYS.has(k.toLowerCase())) continue;
        cleaned[k] = this.sanitizeValue(v);
      }
      return cleaned;
    }

    return value;
  }
}
