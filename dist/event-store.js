import EventEmitter from "node:events";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { normalizeDeniedAction } from "./agy-protocol.js";
export function boundText(text, maxChars = 32_768, suffix = " ... [truncated]") {
    if (text === undefined)
        return undefined;
    if (text.length <= maxChars)
        return text;
    return text.slice(0, maxChars) + suffix;
}
export function sanitizeAggregate(val, depth = 0, currentChars = { count: 0 }, maxChars = 4_096, maxDepth = 8, maxKeys = 50, maxArrayElements = 50) {
    if (val === undefined || val === null)
        return val;
    if (currentChars.count >= maxChars)
        return "[truncated]";
    if (depth > maxDepth)
        return "[max_depth_exceeded]";
    if (typeof val === "string") {
        const remaining = maxChars - currentChars.count;
        if (remaining <= 0)
            return "[truncated]";
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
        const arr = [];
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
        if (val === process.env)
            return undefined;
        const clean = {};
        const entries = Object.entries(val);
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
export function boundStepEvent(event, maxFieldChars = 4_096) {
    const bounded = sanitizeAggregate(event, 0, { count: 0 }, maxFieldChars, 8, 30, 30);
    if (bounded && typeof bounded === "object" && !Array.isArray(bounded)) {
        return bounded;
    }
    return { value: bounded };
}
const FORBIDDEN_ENV_KEYS = new Set([
    "env",
    "processenv",
    "process_env",
    "environment",
    "node_env"
]);
export class EventStore extends EventEmitter {
    currentCursor = 0;
    events = [];
    runsDir;
    fallbackRunsDirs;
    maxFieldBytes;
    constructor(options) {
        super();
        this.runsDir = options.runsDir;
        this.fallbackRunsDirs = (options.fallbackRunsDirs || []).filter((dir) => dir && dir.toLowerCase() !== options.runsDir.toLowerCase());
        this.maxFieldBytes = options.maxFieldBytes ?? 32_768;
    }
    findJobFile(jobId) {
        if (!jobId || typeof jobId !== "string" || !/^[a-zA-Z0-9_-]+$/.test(jobId)) {
            return undefined;
        }
        const allDirs = [this.runsDir, ...this.fallbackRunsDirs];
        for (const dir of allDirs) {
            if (!existsSync(dir))
                continue;
            const runsRoot = path.resolve(dir);
            const filePath = path.resolve(runsRoot, `${jobId}.ndjson`);
            const relative = path.relative(runsRoot, filePath);
            if (!relative.startsWith("..") && !path.isAbsolute(relative) && existsSync(filePath)) {
                return filePath;
            }
        }
        return undefined;
    }
    get latestCursor() {
        return this.currentCursor;
    }
    recordEvent(input) {
        this.currentCursor += 1;
        const sanitizedData = this.sanitizeData(input.data);
        const event = {
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
    getEvents(filter) {
        let matched = this.events;
        if (filter.workerId) {
            matched = matched.filter((e) => e.workerId === filter.workerId);
        }
        if (filter.jobId) {
            matched = matched.filter((e) => e.jobId === filter.jobId);
        }
        if (filter.afterCursor !== undefined) {
            matched = matched.filter((e) => e.cursor > filter.afterCursor);
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
    async readDiskHistory(filter) {
        const allDirs = [this.runsDir, ...this.fallbackRunsDirs];
        const summaries = [];
        const seenJobIds = new Set();
        for (const dir of allDirs) {
            if (!existsSync(dir))
                continue;
            let files = [];
            try {
                files = readdirSync(dir).filter((f) => f.endsWith(".ndjson"));
            }
            catch (err) {
                console.error(`[antigravity-mcp-bridge] Failed to read runs directory ${dir}: ${err instanceof Error ? err.message : String(err)}`);
                continue;
            }
            for (const file of files) {
                const filePath = path.join(dir, file);
                try {
                    const content = readFileSync(filePath, "utf8");
                    const lines = content.split(/\r?\n/).filter((line) => line.trim().length > 0);
                    if (lines.length === 0)
                        continue;
                    let jobId = "";
                    let workerId = "";
                    let role = "implementer";
                    let workspace = "";
                    let status = "queued";
                    let brief = "";
                    let requestKey;
                    let requestFingerprint;
                    let createdAt = "";
                    let startedAt;
                    let finishedAt;
                    let durationSeconds;
                    let cliDurationSeconds;
                    let usage;
                    let cumulativeUsage;
                    let hasModernCumulativeUsage = false;
                    let timeoutKind;
                    let budgetKind;
                    let maxSteps;
                    let maxTurnTokens;
                    let result;
                    let error;
                    for (const line of lines) {
                        try {
                            const evt = JSON.parse(line);
                            if (evt.jobId)
                                jobId = evt.jobId;
                            else if (!jobId)
                                jobId = file.replace(/\.ndjson$/, "");
                            if (evt.workerId)
                                workerId = evt.workerId;
                            const d = (evt.data || evt.step_update || evt.result || evt.init || {});
                            if (evt.eventType === "lifecycle") {
                                const state = (d.state || d.lifecycle);
                                if (state === "queued") {
                                    if (d.role)
                                        role = String(d.role);
                                    if (d.workspace)
                                        workspace = String(d.workspace);
                                    if (typeof d.request_key === "string")
                                        requestKey = d.request_key;
                                    if (typeof d.request_fingerprint === "string")
                                        requestFingerprint = d.request_fingerprint;
                                    if (d.brief)
                                        brief = String(d.brief);
                                    else if (d.task && !brief)
                                        brief = String(d.task);
                                    if (typeof d.max_steps === "number")
                                        maxSteps = d.max_steps;
                                    if (typeof d.max_turn_tokens === "number")
                                        maxTurnTokens = d.max_turn_tokens;
                                    if (!createdAt)
                                        createdAt = d.created_at || evt.timestamp;
                                    status = "queued";
                                }
                                else if (state === "started" || state === "running") {
                                    status = "running";
                                    if (!startedAt)
                                        startedAt = d.started_at || evt.timestamp;
                                }
                                else if (state === "succeeded") {
                                    status = "succeeded";
                                    finishedAt = d.finished_at || evt.timestamp;
                                    if (typeof d.duration_seconds === "number")
                                        durationSeconds = d.duration_seconds;
                                    if (typeof d.cli_duration_seconds === "number")
                                        cliDurationSeconds = d.cli_duration_seconds;
                                    if (typeof d.response === "string")
                                        result = d.response;
                                    if (d.usage)
                                        usage = d.usage;
                                    if (d.cumulative_usage) {
                                        cumulativeUsage = d.cumulative_usage;
                                        hasModernCumulativeUsage = true;
                                    }
                                }
                                else if (state === "failed") {
                                    status = "failed";
                                    finishedAt = d.finished_at || evt.timestamp;
                                    if (typeof d.error === "string")
                                        error = d.error;
                                    if (typeof d.duration_seconds === "number")
                                        durationSeconds = d.duration_seconds;
                                    if (d.timeout_kind === "inactivity" || d.timeout_kind === "max_duration")
                                        timeoutKind = d.timeout_kind;
                                    if (d.budget_kind === "steps" || d.budget_kind === "tokens")
                                        budgetKind = d.budget_kind;
                                }
                                else if (state === "canceled") {
                                    status = "canceled";
                                    finishedAt = d.finished_at || evt.timestamp;
                                }
                            }
                            else if (evt.eventType === "result" || evt.event === "result" || evt.result) {
                                const resStatus = d.status;
                                if (resStatus === "SUCCESS") {
                                    status = "succeeded";
                                    if (typeof d.response === "string")
                                        result = d.response;
                                }
                                else {
                                    status = "failed";
                                    if (typeof d.error === "string")
                                        error = d.error;
                                }
                                finishedAt = evt.timestamp || new Date().toISOString();
                                if (typeof d.duration_seconds === "number")
                                    cliDurationSeconds = d.duration_seconds;
                                if (d.usage)
                                    cumulativeUsage = d.usage;
                            }
                        }
                        catch {
                            // Ignore malformed line
                        }
                    }
                    if (durationSeconds === undefined && startedAt && finishedAt) {
                        durationSeconds = Math.max(0, (Date.parse(finishedAt) - Date.parse(startedAt)) / 1_000);
                    }
                    else if (durationSeconds === undefined && cliDurationSeconds !== undefined) {
                        // Legacy run files stored only the CLI-reported duration.
                        durationSeconds = cliDurationSeconds;
                    }
                    if (!usage && cumulativeUsage && !hasModernCumulativeUsage)
                        usage = cumulativeUsage;
                    // A run file that never reached a terminal lifecycle state cannot prove
                    // its child process survived a bridge restart. Older builds left such
                    // jobs reporting "running" forever, misleading controllers into waiting
                    // on dead work. Mark clearly-stale non-terminal records as orphaned.
                    const NON_TERMINAL_STATUSES = new Set(["queued", "running"]);
                    if (NON_TERMINAL_STATUSES.has(status) && finishedAt === undefined) {
                        let lastEventTime = NaN;
                        try {
                            const lastLine = JSON.parse(lines[lines.length - 1]);
                            if (lastLine?.timestamp)
                                lastEventTime = Date.parse(lastLine.timestamp);
                        }
                        catch { /* malformed last line; treat as unknown age */ }
                        if (!Number.isFinite(lastEventTime) && createdAt)
                            lastEventTime = Date.parse(createdAt);
                        const ageMs = Number.isFinite(lastEventTime) ? Date.now() - lastEventTime : Infinity;
                        if (ageMs > 6 * 60 * 60 * 1_000) {
                            status = "orphaned";
                            error = "Bridge stopped before this job reached a terminal state; its process cannot be resumed. Inspect the partial diff and dispatch a new bounded job instead of retrying this ID.";
                        }
                    }
                    if (jobId && !seenJobIds.has(jobId)) {
                        seenJobIds.add(jobId);
                        summaries.push({
                            ...(requestKey ? { request_key: requestKey, request_fingerprint: requestFingerprint } : {}),
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
                            ...(cliDurationSeconds !== undefined ? { cli_duration_seconds: cliDurationSeconds } : {}),
                            ...(usage ? { usage } : {}),
                            ...(cumulativeUsage ? { cumulative_usage: cumulativeUsage } : {}),
                            ...(timeoutKind ? { timeout_kind: timeoutKind } : {}),
                            ...(budgetKind ? { budget_kind: budgetKind } : {}),
                            ...(maxSteps !== undefined ? { max_steps: maxSteps } : {}),
                            ...(maxTurnTokens !== undefined ? { max_turn_tokens: maxTurnTokens } : {}),
                            ...(result ? { result } : {}),
                            ...(error ? { error } : {})
                        });
                    }
                }
                catch (err) {
                    console.error(`[antigravity-mcp-bridge] Failed to read run file ${file}: ${err instanceof Error ? err.message : String(err)}`);
                }
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
    deleteJob(jobId) {
        if (!jobId || typeof jobId !== "string" || !/^[a-zA-Z0-9_-]+$/.test(jobId)) {
            throw new Error(`Invalid job ID for deletion: ${jobId}`);
        }
        let deleted = false;
        const allDirs = [this.runsDir, ...this.fallbackRunsDirs];
        for (const dir of allDirs) {
            if (!existsSync(dir))
                continue;
            const resolvedDir = path.resolve(dir);
            const targetPath = path.resolve(resolvedDir, `${jobId}.ndjson`);
            if (targetPath.startsWith(resolvedDir) && existsSync(targetPath)) {
                unlinkSync(targetPath);
                deleted = true;
            }
        }
        // Purge in-memory events for this job
        for (let i = this.events.length - 1; i >= 0; i--) {
            if (this.events[i]?.jobId === jobId) {
                this.events.splice(i, 1);
            }
        }
        return deleted;
    }
    async cleanJobs(options = {}) {
        const allSummaries = await this.readDiskHistory({ limit: 100_000 });
        const excludeSet = new Set(options.excludeJobIds || []);
        let candidates = allSummaries.filter((s) => !excludeSet.has(s.job_id));
        if (options.jobId) {
            candidates = candidates.filter((s) => s.job_id === options.jobId);
        }
        if (options.workspace) {
            const targetWs = options.workspace.trim().toLowerCase();
            candidates = candidates.filter((s) => {
                if (!s.workspace)
                    return false;
                const norm = s.workspace.toLowerCase();
                return (norm === targetWs ||
                    path.basename(s.workspace).toLowerCase() === targetWs ||
                    norm.includes(targetWs));
            });
        }
        if (options.terminalOnly) {
            candidates = candidates.filter((s) => ["succeeded", "failed", "canceled", "orphaned"].includes(s.status));
        }
        if (options.status) {
            const allowedStatuses = Array.isArray(options.status) ? options.status : [options.status];
            candidates = candidates.filter((s) => allowedStatuses.includes(s.status));
        }
        if (typeof options.olderThanDays === "number" && options.olderThanDays >= 0) {
            const cutoffMs = Date.now() - options.olderThanDays * 86_400_000;
            candidates = candidates.filter((s) => new Date(s.created_at).getTime() < cutoffMs);
        }
        // Sort newest first
        candidates.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
        // If keep is specified, preserve the newest N candidates
        if (typeof options.keep === "number" && options.keep > 0) {
            candidates = candidates.slice(options.keep);
        }
        const deletedJobIds = [];
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
    readDiskJob(jobId, options) {
        const filePath = this.findJobFile(jobId);
        if (!filePath)
            return undefined;
        try {
            const content = readFileSync(filePath, "utf8");
            const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
            if (lines.length === 0)
                return undefined;
            let workerId = "";
            let role = "implementer";
            let workspace = "";
            let status = "queued";
            let brief = "";
            let effectivePrompt = "";
            let createdAt = "";
            let startedAt;
            let finishedAt;
            let durationSeconds;
            let cliDurationSeconds;
            let conversationId;
            let inactivityTimeoutSeconds;
            let maxDurationSeconds;
            let deadlineAt;
            let totalDurationSeconds;
            let maxSteps;
            let maxTurnTokens;
            let timeoutKind;
            let budgetKind;
            let lastActivityAt;
            let lastProgress;
            const stepEvents = [];
            const deniedActions = [];
            let usage;
            let cumulativeUsage;
            let hasModernCumulativeUsage = false;
            let result;
            let error;
            for (const line of lines) {
                try {
                    const evt = JSON.parse(line);
                    if (evt.workerId)
                        workerId = evt.workerId;
                    const d = (evt.data || evt.step_update || evt.result || evt.init || {});
                    if (evt.eventType === "lifecycle") {
                        const state = (d.state || d.lifecycle);
                        if (state === "queued") {
                            if (d.role === "implementer" || d.role === "tester")
                                role = d.role;
                            if (d.workspace)
                                workspace = String(d.workspace);
                            if (d.brief)
                                brief = String(d.brief);
                            else if (d.task)
                                brief = String(d.task);
                            if (d.effective_prompt)
                                effectivePrompt = String(d.effective_prompt);
                            if (typeof d.inactivity_timeout_seconds === "number")
                                inactivityTimeoutSeconds = d.inactivity_timeout_seconds;
                            else if (typeof d.timeout_seconds === "number")
                                inactivityTimeoutSeconds = d.timeout_seconds;
                            if (typeof d.max_duration_seconds === "number")
                                maxDurationSeconds = d.max_duration_seconds;
                            if (typeof d.deadline_at === "string")
                                deadlineAt = d.deadline_at;
                            if (typeof d.total_duration_seconds === "number")
                                totalDurationSeconds = d.total_duration_seconds;
                            if (typeof d.max_steps === "number")
                                maxSteps = d.max_steps;
                            if (typeof d.max_turn_tokens === "number")
                                maxTurnTokens = d.max_turn_tokens;
                            if (!createdAt)
                                createdAt = d.created_at || evt.timestamp;
                            status = "queued";
                        }
                        else if (state === "started" || state === "running") {
                            status = "running";
                            if (!startedAt)
                                startedAt = d.started_at || evt.timestamp;
                        }
                        else if (state === "succeeded") {
                            status = "succeeded";
                            finishedAt = d.finished_at || evt.timestamp;
                            if (typeof d.duration_seconds === "number")
                                durationSeconds = d.duration_seconds;
                            if (typeof d.cli_duration_seconds === "number")
                                cliDurationSeconds = d.cli_duration_seconds;
                            if (typeof d.response === "string")
                                result = d.response;
                            if (d.usage)
                                usage = d.usage;
                            if (d.cumulative_usage) {
                                cumulativeUsage = d.cumulative_usage;
                                hasModernCumulativeUsage = true;
                            }
                            if (typeof d.conversation_id === "string")
                                conversationId = d.conversation_id;
                        }
                        else if (state === "failed") {
                            status = "failed";
                            finishedAt = d.finished_at || evt.timestamp;
                            if (typeof d.error === "string")
                                error = d.error;
                            if (typeof d.duration_seconds === "number")
                                durationSeconds = d.duration_seconds;
                            if (d.timeout_kind === "inactivity" || d.timeout_kind === "max_duration")
                                timeoutKind = d.timeout_kind;
                            if (d.budget_kind === "steps" || d.budget_kind === "tokens")
                                budgetKind = d.budget_kind;
                        }
                        else if (state === "canceled") {
                            status = "canceled";
                            finishedAt = d.finished_at || evt.timestamp;
                        }
                        if (Array.isArray(d.denied_actions)) {
                            for (const item of d.denied_actions) {
                                const norm = normalizeDeniedAction(item);
                                if (norm && !deniedActions.includes(norm)) {
                                    deniedActions.push(norm);
                                }
                            }
                        }
                    }
                    else if (evt.eventType === "init" || evt.event === "init") {
                        lastActivityAt = evt.timestamp || lastActivityAt;
                        if (typeof d.conversation_id === "string")
                            conversationId = d.conversation_id;
                        else if (typeof evt.conversation_id === "string")
                            conversationId = evt.conversation_id;
                    }
                    else if (evt.eventType === "step" || evt.event === "step_update" || evt.step_update) {
                        stepEvents.push(d);
                        lastActivityAt = evt.timestamp || lastActivityAt;
                        const stateStr = String(d.state || "");
                        const stepTypeStr = String(d.step_type || "");
                        const textDeltaStr = String(d.text_delta || "");
                        lastProgress = [stepTypeStr, stateStr, textDeltaStr].filter(Boolean).join(": ").slice(0, 512);
                        if (stateStr.toUpperCase() === "DENIED" ||
                            stepTypeStr.toLowerCase().includes("permission") ||
                            textDeltaStr.toLowerCase().includes("permission denied")) {
                            const norm = normalizeDeniedAction(textDeltaStr || stateStr);
                            if (norm && !deniedActions.includes(norm)) {
                                deniedActions.push(norm);
                            }
                        }
                    }
                    else if (evt.eventType === "result" || evt.event === "result" || evt.result) {
                        if (typeof d.conversation_id === "string")
                            conversationId = d.conversation_id;
                        else if (typeof evt.conversation_id === "string")
                            conversationId = evt.conversation_id;
                        const resStatus = d.status;
                        if (resStatus === "SUCCESS") {
                            const resText = typeof d.response === "string" ? d.response : "";
                            if (!resText.trim()) {
                                status = "failed";
                                if (!error)
                                    error = "Antigravity returned SUCCESS with an empty response";
                            }
                            else {
                                status = "succeeded";
                                result = resText;
                            }
                        }
                        else if (resStatus && resStatus !== "SUCCESS") {
                            status = "failed";
                            if (typeof d.error === "string")
                                error = d.error;
                        }
                        finishedAt = evt.timestamp || new Date().toISOString();
                        if (typeof d.duration_seconds === "number")
                            cliDurationSeconds = d.duration_seconds;
                        if (d.usage)
                            cumulativeUsage = d.usage;
                        lastActivityAt = evt.timestamp || lastActivityAt;
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
                }
                catch {
                    // Ignore malformed line
                }
            }
            if (durationSeconds === undefined && startedAt && finishedAt) {
                durationSeconds = Math.max(0, (Date.parse(finishedAt) - Date.parse(startedAt)) / 1_000);
            }
            else if (durationSeconds === undefined && cliDurationSeconds !== undefined) {
                // Legacy run files stored only the CLI-reported duration.
                durationSeconds = cliDurationSeconds;
            }
            if (!usage && cumulativeUsage && !hasModernCumulativeUsage)
                usage = cumulativeUsage;
            // Same orphan marking as readDiskHistory: a run file that never reached a
            // terminal state cannot be resumed after a bridge restart.
            if ((status === "queued" || status === "running") && finishedAt === undefined) {
                const referenceTime = Date.parse(lastActivityAt || createdAt);
                const ageMs = Number.isFinite(referenceTime) ? Date.now() - referenceTime : Infinity;
                if (ageMs > 6 * 60 * 60 * 1_000) {
                    status = "orphaned";
                    error = "Bridge stopped before this job reached a terminal state; its process cannot be resumed. Inspect the partial diff and dispatch a new bounded job instead of retrying this ID.";
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
                ...(deadlineAt ? { deadline_at: deadlineAt, total_duration_seconds: totalDurationSeconds } : {}),
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
                ...(cliDurationSeconds !== undefined ? { cli_duration_seconds: cliDurationSeconds } : {}),
                ...(inactivityTimeoutSeconds !== undefined ? { inactivity_timeout_seconds: inactivityTimeoutSeconds } : {}),
                ...(maxDurationSeconds !== undefined ? { max_duration_seconds: maxDurationSeconds } : {}),
                ...(maxSteps !== undefined ? { max_steps: maxSteps } : {}),
                ...(maxTurnTokens !== undefined ? { max_turn_tokens: maxTurnTokens } : {}),
                ...(conversationId ? { conversation_id: conversationId } : {}),
                ...(timeoutKind ? { timeout_kind: timeoutKind } : {}),
                ...(budgetKind ? { budget_kind: budgetKind } : {}),
                ...(lastActivityAt ? { last_activity_at: lastActivityAt } : {}),
                ...(lastProgress ? { last_progress: lastProgress } : {}),
                total_steps: totalSteps,
                step_offset: offset,
                step_limit: limit,
                has_more_steps: hasMoreSteps,
                step_events: boundedSteps,
                total_denied_actions: totalDenied,
                denied_actions: slicedDenied,
                has_more_denied_actions: hasMoreDenied,
                ...(usage ? { usage } : {}),
                ...(cumulativeUsage ? { cumulative_usage: cumulativeUsage } : {}),
                ...(result !== undefined ? { result: boundText(result, 32_768) } : {}),
                ...(error !== undefined ? { error: boundText(error, 16_384) } : {})
            };
        }
        catch (err) {
            console.error(`[antigravity-mcp-bridge] Failed to read job file ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
            return undefined;
        }
    }
    readDiskJobEvents(jobId) {
        const filePath = this.findJobFile(jobId);
        if (!filePath)
            return [];
        try {
            const content = readFileSync(filePath, "utf8");
            const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
            const events = [];
            let syntheticCursor = 0;
            for (const line of lines) {
                try {
                    const raw = JSON.parse(line);
                    if (raw && typeof raw === "object") {
                        syntheticCursor += 1;
                        if (raw.eventType && raw.data) {
                            events.push({
                                cursor: typeof raw.cursor === "number" ? raw.cursor : syntheticCursor,
                                timestamp: typeof raw.timestamp === "string" ? raw.timestamp : new Date().toISOString(),
                                eventType: raw.eventType,
                                workerId: typeof raw.workerId === "string" ? raw.workerId : "",
                                jobId: typeof raw.jobId === "string" ? raw.jobId : jobId,
                                data: raw.data || {}
                            });
                        }
                        else if (raw.event === "step_update" || raw.step_update) {
                            events.push({
                                cursor: syntheticCursor,
                                timestamp: new Date().toISOString(),
                                eventType: "step",
                                workerId: "",
                                jobId,
                                data: raw.step_update || raw
                            });
                        }
                        else if (raw.event === "result" || raw.result) {
                            events.push({
                                cursor: syntheticCursor,
                                timestamp: typeof raw.timestamp === "string" ? raw.timestamp : new Date().toISOString(),
                                eventType: "result",
                                workerId: typeof raw.workerId === "string" ? raw.workerId : "",
                                jobId,
                                data: raw.result || raw
                            });
                        }
                        else if (raw.event === "init" || raw.init) {
                            events.push({
                                cursor: syntheticCursor,
                                timestamp: typeof raw.timestamp === "string" ? raw.timestamp : new Date().toISOString(),
                                eventType: "init",
                                workerId: typeof raw.workerId === "string" ? raw.workerId : "",
                                jobId,
                                data: raw.init || raw
                            });
                        }
                        else if (raw.event === "lifecycle" || raw.lifecycle) {
                            events.push({
                                cursor: syntheticCursor,
                                timestamp: typeof raw.timestamp === "string" ? raw.timestamp : new Date().toISOString(),
                                eventType: "lifecycle",
                                workerId: typeof raw.workerId === "string" ? raw.workerId : "",
                                jobId,
                                data: raw.data || raw
                            });
                        }
                        else if (raw.event === "stderr" || raw.stderr) {
                            events.push({
                                cursor: syntheticCursor,
                                timestamp: typeof raw.timestamp === "string" ? raw.timestamp : new Date().toISOString(),
                                eventType: "stderr",
                                workerId: typeof raw.workerId === "string" ? raw.workerId : "",
                                jobId,
                                data: raw.data || raw
                            });
                        }
                    }
                }
                catch {
                    // ignore malformed line
                }
            }
            return events;
        }
        catch (err) {
            console.error(`[antigravity-mcp-bridge] Failed to read job events from ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
            return [];
        }
    }
    persistEventToDisk(jobId, event) {
        try {
            if (!existsSync(this.runsDir)) {
                mkdirSync(this.runsDir, { recursive: true });
            }
            const filePath = path.join(this.runsDir, `${jobId}.ndjson`);
            const line = JSON.stringify(event) + "\n";
            appendFileSync(filePath, line, "utf8");
        }
        catch (err) {
            // Security/reliability invariant: logging failure is reported but does not throw or change agent result
            console.error(`[antigravity-mcp-bridge] Failed to append event to run log: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    sanitizeData(data) {
        const clean = {};
        for (const [key, value] of Object.entries(data)) {
            if (FORBIDDEN_ENV_KEYS.has(key.toLowerCase())) {
                continue;
            }
            clean[key] = this.sanitizeValue(value);
        }
        return clean;
    }
    sanitizeValue(value) {
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
            if (value === process.env || value.env !== undefined) {
                return undefined;
            }
            const obj = value;
            const cleaned = {};
            for (const [k, v] of Object.entries(obj)) {
                if (FORBIDDEN_ENV_KEYS.has(k.toLowerCase()))
                    continue;
                cleaned[k] = this.sanitizeValue(v);
            }
            return cleaned;
        }
        return value;
    }
}
//# sourceMappingURL=event-store.js.map