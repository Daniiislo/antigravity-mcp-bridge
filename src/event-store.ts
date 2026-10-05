import EventEmitter from "node:events";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
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

export function sanitizeAggregate(
  val: unknown,
  depth = 0,
  currentChars = { count: 0 },
  maxChars = 4_096,
  maxDepth = 8,
  maxKeys = 50,
  maxArrayElements = 50
): unknown {
  if (val === undefined || val === null) return val;
  if (currentChars.count >= maxChars) return "[truncated]";
  if (depth > maxDepth) return "[max_depth_exceeded]";

  if (typeof val === "string") {
    const remaining = maxChars - currentChars.count;
    if (remaining <= 0) return "[truncated]";
    if (val.length <= remaining) {
      currentChars.count += val.length;
      return val;
    }
    const truncated = val.slice(0, Math.max(0, remaining - 18)) + " ... [truncated]";
    currentChars.count += truncated.length;
    return truncated;
  }

  if (typeof val === "number" || typeof val === "boolean") {
    currentChars.count += 8;
    return val;
  }

  if (typeof val === "bigint" || typeof val === "symbol" || typeof val === "function") {
    const str = String(val);
    currentChars.count += str.length;
    return str;
  }

  if (Array.isArray(val)) {
    const arr: unknown[] = [];
    const elementsToProcess = val.slice(0, maxArrayElements);
    for (const item of elementsToProcess) {
      if (currentChars.count >= maxChars) {
        arr.push("[truncated]");
        break;
      }
      arr.push(sanitizeAggregate(item, depth + 1, currentChars, maxChars, maxDepth, maxKeys, maxArrayElements));
    }
    if (val.length > maxArrayElements) {
      arr.push(`... [${val.length - maxArrayElements} items truncated]`);
    }
    return arr;
  }

  if (typeof val === "object") {
    // Avoid circular/special objects
    if (val === process.env) return undefined;
    const clean: Record<string, unknown> = {};
    const entries = Object.entries(val as Record<string, unknown>);
    const entriesToProcess = entries.slice(0, maxKeys);
    for (const [k, v] of entriesToProcess) {
      if (currentChars.count >= maxChars) {
        clean._truncated = true;
        break;
      }
      currentChars.count += k.length + 4;
      clean[k] = sanitizeAggregate(v, depth + 1, currentChars, maxChars, maxDepth, maxKeys, maxArrayElements);
    }
    if (entries.length > maxKeys) {
      clean._keys_truncated = entries.length - maxKeys;
    }
    return clean;
  }

  return String(val);
}

export function boundStepEvent(
  event: Record<string, unknown>,
  maxFieldChars = 4_096
): Record<string, unknown> {
  const bounded = sanitizeAggregate(event, 0, { count: 0 }, maxFieldChars, 8, 30, 30);
  if (bounded && typeof bounded === "object" && !Array.isArray(bounded)) {
    return bounded as Record<string, unknown>;
  }
  return { value: bounded };
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

  get latestCursor(): number {
    return this.currentCursor;
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
            const evt = JSON.parse(line) as NormalizedEvent & Record<string, unknown>;
            if (evt.jobId) jobId = evt.jobId;
            else if (!jobId) jobId = file.replace(/\.ndjson$/, "");
            if (evt.workerId) workerId = evt.workerId;
            const d = (evt.data || evt.step_update || evt.result || evt.init || {}) as Record<string, unknown>;

            if (evt.eventType === "lifecycle") {
              const state = (d.state || d.lifecycle) as string | undefined;
              if (state === "queued") {
                if (d.role) role = String(d.role);
                if (d.workspace) workspace = String(d.workspace);
                if (d.brief) brief = String(d.brief);
                else if (d.task && !brief) brief = String(d.task);
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
            } else if (evt.eventType === "result" || evt.event === "result" || evt.result) {
              const resStatus = d.status as string | undefined;
              if (resStatus === "SUCCESS") {
                status = "succeeded";
                if (typeof d.response === "string") result = d.response;
              } else {
                status = "failed";
                if (typeof d.error === "string") error = d.error;
              }
              finishedAt = evt.timestamp || new Date().toISOString();
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

  deleteJob(jobId: string): boolean {
    if (!jobId || typeof jobId !== "string" || !/^[a-zA-Z0-9_-]+$/.test(jobId)) {
      throw new Error(`Invalid job ID for deletion: ${jobId}`);
    }
    const resolvedDir = path.resolve(this.runsDir);
    const targetPath = path.resolve(resolvedDir, `${jobId}.ndjson`);
    if (!targetPath.startsWith(resolvedDir)) {
      throw new Error(`Access denied: job path outside runs directory`);
    }

    let deleted = false;
    if (existsSync(targetPath)) {
      unlinkSync(targetPath);
      deleted = true;
    }

    // Purge in-memory events for this job
    for (let i = this.events.length - 1; i >= 0; i--) {
      if (this.events[i]?.jobId === jobId) {
        this.events.splice(i, 1);
      }
    }
    return deleted;
  }

  async cleanJobs(options: CleanJobsOptions = {}): Promise<CleanJobsResult> {
    const allSummaries = await this.readDiskHistory({ limit: 100_000 });
    const excludeSet = new Set(options.excludeJobIds || []);

    let candidates: JobHistorySummary[] = allSummaries.filter((s: JobHistorySummary) => !excludeSet.has(s.job_id));

    if (options.jobId) {
      candidates = candidates.filter((s: JobHistorySummary) => s.job_id === options.jobId);
    }

    if (options.workspace) {
      const targetWs = options.workspace.trim().toLowerCase();
      candidates = candidates.filter((s: JobHistorySummary) => {
        if (!s.workspace) return false;
        const norm = s.workspace.toLowerCase();
        return (
          norm === targetWs ||
          path.basename(s.workspace).toLowerCase() === targetWs ||
          norm.includes(targetWs)
        );
      });
    }

    if (options.terminalOnly) {
      candidates = candidates.filter((s: JobHistorySummary) => ["succeeded", "failed", "canceled"].includes(s.status));
    }

    if (options.status) {
      const allowedStatuses = Array.isArray(options.status) ? options.status : [options.status];
      candidates = candidates.filter((s: JobHistorySummary) => allowedStatuses.includes(s.status));
    }

    if (typeof options.olderThanDays === "number" && options.olderThanDays >= 0) {
      const cutoffMs = Date.now() - options.olderThanDays * 86_400_000;
      candidates = candidates.filter((s: JobHistorySummary) => new Date(s.created_at).getTime() < cutoffMs);
    }

    // Sort newest first
    candidates.sort((a: JobHistorySummary, b: JobHistorySummary) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

    // If keep is specified, preserve the newest N candidates
    if (typeof options.keep === "number" && options.keep > 0) {
      candidates = candidates.slice(options.keep);
    }

    const deletedJobIds: string[] = [];
    for (const item of candidates) {
      if (this.deleteJob(item.job_id)) {
        deletedJobIds.push(item.job_id);
      }
    }

    return {
      deletedCount: deletedJobIds.length,
      deletedJobIds
    };
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

    const runsRoot = path.resolve(this.runsDir);
    const filePath = path.resolve(runsRoot, `${jobId}.ndjson`);
    const relativePath = path.relative(runsRoot, filePath);
    if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) return undefined;
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
          const evt = JSON.parse(line) as NormalizedEvent & Record<string, unknown>;
          if (evt.workerId) workerId = evt.workerId;
          const d = (evt.data || evt.step_update || evt.result || evt.init || {}) as Record<string, unknown>;

          if (evt.eventType === "lifecycle") {
            const state = (d.state || d.lifecycle) as string | undefined;
            if (state === "queued") {
              if (d.role === "implementer" || d.role === "tester") role = d.role;
              if (d.workspace) workspace = String(d.workspace);
              if (d.brief) brief = String(d.brief);
              else if (d.task) brief = String(d.task);
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
          } else if (evt.eventType === "init" || evt.event === "init") {
            if (typeof d.conversation_id === "string") conversationId = d.conversation_id;
            else if (typeof evt.conversation_id === "string") conversationId = evt.conversation_id;
          } else if (evt.eventType === "step" || evt.event === "step_update" || evt.step_update) {
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
          } else if (evt.eventType === "result" || evt.event === "result" || evt.result) {
            if (typeof d.conversation_id === "string") conversationId = d.conversation_id;
            else if (typeof evt.conversation_id === "string") conversationId = evt.conversation_id;
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
            finishedAt = evt.timestamp || new Date().toISOString();
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

  readDiskJobEvents(jobId: string): NormalizedEvent[] {
    if (!jobId || !existsSync(this.runsDir)) return [];
    const filePath = path.join(this.runsDir, `${jobId}.ndjson`);
    if (!existsSync(filePath)) return [];

    try {
      const content = readFileSync(filePath, "utf8");
      const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
      const events: NormalizedEvent[] = [];
      let syntheticCursor = 0;

      for (const line of lines) {
        try {
          const raw = JSON.parse(line) as Record<string, unknown>;
          if (raw && typeof raw === "object") {
            syntheticCursor += 1;
            if (raw.eventType && raw.data) {
              events.push({
                cursor: typeof raw.cursor === "number" ? raw.cursor : syntheticCursor,
                timestamp: typeof raw.timestamp === "string" ? raw.timestamp : new Date().toISOString(),
                eventType: raw.eventType as EventType,
                workerId: typeof raw.workerId === "string" ? raw.workerId : "",
                jobId: typeof raw.jobId === "string" ? raw.jobId : jobId,
                data: (raw.data as Record<string, unknown>) || {}
              });
            } else if (raw.event === "step_update" || raw.step_update) {
              events.push({
                cursor: syntheticCursor,
                timestamp: new Date().toISOString(),
                eventType: "step",
                workerId: "",
                jobId,
                data: (raw.step_update as Record<string, unknown>) || raw
              });
            } else if (raw.event === "result" || raw.result) {
              events.push({
                cursor: syntheticCursor,
                timestamp: typeof raw.timestamp === "string" ? raw.timestamp : new Date().toISOString(),
                eventType: "result",
                workerId: typeof raw.workerId === "string" ? raw.workerId : "",
                jobId,
                data: (raw.result as Record<string, unknown>) || raw
              });
            } else if (raw.event === "init" || raw.init) {
              events.push({
                cursor: syntheticCursor,
                timestamp: typeof raw.timestamp === "string" ? raw.timestamp : new Date().toISOString(),
                eventType: "init",
                workerId: typeof raw.workerId === "string" ? raw.workerId : "",
                jobId,
                data: (raw.init as Record<string, unknown>) || raw
              });
            } else if (raw.event === "lifecycle" || raw.lifecycle) {
              events.push({
                cursor: syntheticCursor,
                timestamp: typeof raw.timestamp === "string" ? raw.timestamp : new Date().toISOString(),
                eventType: "lifecycle",
                workerId: typeof raw.workerId === "string" ? raw.workerId : "",
                jobId,
                data: (raw.data as Record<string, unknown>) || raw
              });
            } else if (raw.event === "stderr" || raw.stderr) {
              events.push({
                cursor: syntheticCursor,
                timestamp: typeof raw.timestamp === "string" ? raw.timestamp : new Date().toISOString(),
                eventType: "stderr",
                workerId: typeof raw.workerId === "string" ? raw.workerId : "",
                jobId,
                data: (raw.data as Record<string, unknown>) || raw
              });
            }
          }
        } catch {
          // ignore malformed line
        }
      }
      return events;
    } catch (err) {
      console.error(`[antigravity-mcp-bridge] Failed to read job events from ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
      return [];
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
