import { spawn } from "node:child_process";
import readline from "node:readline";
import { parseAgyEvent } from "./agy-protocol.js";
import { terminateProcessTree } from "./process-tree.js";
export class AgyTimeoutError extends Error {
    timeoutKind;
    constructor(kind, milliseconds) {
        const label = kind === "inactivity" ? "inactivity" : "maximum duration";
        super(`Antigravity turn timed out due to ${label} after ${milliseconds}ms`);
        this.name = "AgyTimeoutError";
        this.timeoutKind = kind;
    }
}
export class AgyBudgetError extends Error {
    budgetKind;
    constructor(kind, limit) {
        const label = kind === "steps" ? "logical steps" : "observed turn tokens";
        super(`Antigravity turn reached the ${label} budget (${limit}) before completion`);
        this.name = "AgyBudgetError";
        this.budgetKind = kind;
    }
}
const USAGE_KEYS = [
    "input_tokens", "output_tokens", "thinking_tokens", "cache_read_tokens", "total_tokens"
];
function usageDelta(current, previous) {
    const delta = {};
    for (const key of USAGE_KEYS) {
        const currentValue = current[key] ?? 0;
        const previousValue = previous?.[key] ?? 0;
        delta[key] = currentValue >= previousValue ? currentValue - previousValue : currentValue;
    }
    return delta;
}
export class AgyWorker {
    options;
    child;
    pending;
    tail = Promise.resolve();
    queueDepth = 0;
    conversationId;
    completedTurns = 0;
    lastResult;
    recentStderr = "";
    stopGeneration = 0;
    invalidation;
    terminating = false;
    lastCumulativeUsage;
    usageBaselineTrusted = true;
    unsafeTerminationError;
    constructor(options) {
        this.options = options;
    }
    delegate(task, timeouts = {}) {
        if (this.unsafeTerminationError)
            return Promise.reject(this.unsafeRestartError());
        if (!task.trim())
            return Promise.reject(new Error("task must not be empty"));
        const inactivityTimeoutMs = typeof timeouts === "number"
            ? timeouts
            : (timeouts.inactivityTimeoutMs ?? this.options.defaultTimeoutMs);
        const maxDurationMs = typeof timeouts === "number"
            ? (this.options.defaultMaxTurnMs ?? Math.max(this.options.defaultTimeoutMs * 4, inactivityTimeoutMs))
            : (timeouts.maxDurationMs ?? this.options.defaultMaxTurnMs ?? Math.max(this.options.defaultTimeoutMs * 4, inactivityTimeoutMs));
        const maxSteps = typeof timeouts === "number"
            ? (this.options.defaultMaxSteps ?? Number.POSITIVE_INFINITY)
            : (timeouts.maxSteps ?? this.options.defaultMaxSteps ?? Number.POSITIVE_INFINITY);
        const maxTokens = typeof timeouts === "number"
            ? (this.options.defaultMaxTokens ?? Number.POSITIVE_INFINITY)
            : (timeouts.maxTokens ?? this.options.defaultMaxTokens ?? Number.POSITIVE_INFINITY);
        if (!Number.isFinite(inactivityTimeoutMs) || inactivityTimeoutMs <= 0) {
            return Promise.reject(new Error("inactivity timeout must be positive"));
        }
        if (!Number.isFinite(maxDurationMs) || maxDurationMs <= 0) {
            return Promise.reject(new Error("maximum duration must be positive"));
        }
        if (maxDurationMs < inactivityTimeoutMs) {
            return Promise.reject(new Error("maximum duration must be greater than or equal to the inactivity timeout"));
        }
        if (!(maxSteps > 0) || !(maxTokens > 0) || (Number.isFinite(maxSteps) && !Number.isSafeInteger(maxSteps)) || (Number.isFinite(maxTokens) && !Number.isSafeInteger(maxTokens))) {
            return Promise.reject(new Error("step and token budgets must be positive"));
        }
        const generation = this.stopGeneration;
        this.queueDepth += 1;
        const job = this.tail.then(() => {
            if (generation !== this.stopGeneration)
                throw new Error("Antigravity worker was stopped before the queued turn started");
            if (this.unsafeTerminationError)
                throw this.unsafeRestartError();
            return this.runTurn(task, inactivityTimeoutMs, maxDurationMs, maxSteps, maxTokens);
        });
        this.tail = job.catch(() => undefined);
        return job.finally(() => { this.queueDepth -= 1; });
    }
    status() {
        return {
            role: this.options.role,
            state: this.child ? (this.pending ? "busy" : "idle") : "stopped",
            ...(this.child?.pid ? { pid: this.child.pid } : {}),
            cwd: this.options.cwd,
            ...(this.conversationId ? { conversationId: this.conversationId } : {}),
            queueDepth: this.queueDepth,
            completedTurns: this.completedTurns,
            ...(this.lastResult ? { lastResult: this.lastResult } : {}),
            recentStderr: this.recentStderr
        };
    }
    async stop() {
        this.stopGeneration += 1;
        this.clearConversation();
        if (this.invalidation)
            await this.invalidation;
        if (!this.child)
            return;
        await this.invalidate(new Error("Antigravity worker was stopped"), false);
    }
    getConversationId() {
        return this.conversationId;
    }
    cancelActiveTurn(reason = "Antigravity active turn was canceled") {
        if (!this.pending && !this.invalidation)
            return false;
        this.clearConversation();
        if (this.pending)
            void this.invalidate(new Error(reason), false);
        return true;
    }
    interruptActiveTurn(error) {
        if (this.pending)
            void this.invalidate(error, true);
    }
    /**
     * Request graceful completion of the active turn: the CLI is asked to wrap up
     * and return its terminal result before the hard deadline kills the process.
     * Returns true when a turn is active and a finish request was sent.
     */
    requestGracefulFinish() {
        if (!this.pending || !this.child || this.terminating)
            return false;
        const line = JSON.stringify({ event: "user", message: { content: "FINISH_NOW: Stop further exploration and edits. Summarize exactly what you completed, verified, and what remains unfinished in a concise final response now." } }) + "\n";
        try {
            this.child.stdin.write(line);
            return true;
        }
        catch {
            return false;
        }
    }
    runTurn(task, inactivityTimeoutMs, maxDurationMs, maxSteps, maxTokens) {
        this.ensureStarted();
        if (!this.child)
            return Promise.reject(new Error("Antigravity worker did not start"));
        return new Promise((resolve, reject) => {
            this.pending = {
                resolve,
                reject,
                progress: [],
                startedAtMs: Date.now(),
                inactivityTimeoutMs,
                maxDurationMs,
                maxSteps,
                maxTokens,
                observedStepIds: new Set(),
                observedTokens: 0,
                stepTokenUsage: new Map(),
                anonymousSteps: 0
            };
            this.resetInactivityTimer();
            this.pending.maxDurationTimer = setTimeout(() => {
                void this.invalidate(new AgyTimeoutError("max_duration", maxDurationMs), true);
            }, maxDurationMs);
            const line = JSON.stringify({ event: "user", message: { content: task } }) + "\n";
            try {
                this.child.stdin.write(line, (error) => {
                    if (error)
                        void this.invalidate(new Error(`Failed to write to Antigravity: ${error.message}`), true);
                });
            }
            catch (error) {
                void this.invalidate(new Error(`Failed to write to Antigravity: ${error instanceof Error ? error.message : String(error)}`), true);
            }
        });
    }
    ensureStarted() {
        if (this.child)
            return;
        const args = [
            ...(this.options.prefixArgs ?? []),
            "--input-format", "stream-json", "--output-format", "stream-json", "--print-timeout", "0", "--mode", this.options.mode,
            "--add-dir", this.options.cwd,
            ...(this.options.addDirs ?? []).filter((dir) => dir !== this.options.cwd).flatMap((dir) => ["--add-dir", dir]),
            "--disable-slash-commands"
        ];
        if (this.conversationId)
            args.push("--conversation", this.conversationId);
        else
            args.push("--new-project");
        if (this.options.model)
            args.push("--model", this.options.model);
        if (this.options.effort)
            args.push("--effort", this.options.effort);
        if (this.options.agent)
            args.push("--agent", this.options.agent);
        if (this.options.sandbox)
            args.push("--sandbox");
        if (this.options.dangerouslySkipPermissions)
            args.push("--dangerously-skip-permissions");
        const child = spawn(this.options.executable, args, {
            cwd: this.options.cwd,
            shell: false,
            windowsHide: true,
            detached: process.platform !== "win32",
            stdio: ["pipe", "pipe", "pipe"]
        });
        this.child = child;
        this.recentStderr = "";
        const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
        lines.on("line", (line) => this.handleLine(line));
        child.stderr.on("data", (chunk) => this.appendStderr(chunk.toString("utf8")));
        child.on("error", (error) => { void this.invalidate(new Error(`Failed to start Antigravity: ${error.message}`), true); });
        child.on("exit", (code, signal) => {
            if (this.child !== child)
                return;
            void this.invalidate(new Error(`Antigravity exited before a result (code=${code ?? "null"}, signal=${signal ?? "null"})`), true);
        });
    }
    handleLine(line) {
        if (this.terminating)
            return;
        if (!line.trim())
            return;
        let event;
        try {
            event = parseAgyEvent(line);
        }
        catch (error) {
            void this.invalidate(error instanceof Error ? error : new Error(String(error)), true);
            return;
        }
        if (event.event === "init") {
            if (event.conversation_id) {
                if (this.conversationId && this.conversationId !== event.conversation_id)
                    this.lastCumulativeUsage = undefined;
                this.conversationId = event.conversation_id;
            }
            this.resetInactivityTimer();
            this.options.onRawEvent?.({ type: "init", conversationId: event.conversation_id, init: event.init });
            return;
        }
        if (event.event === "step_update") {
            const update = event.step_update;
            if (this.pending && update) {
                const indexedStep = typeof update.step_index === "number" && Number.isSafeInteger(update.step_index);
                const stepId = indexedStep ? String(update.step_index)
                    : (String(update.state ?? "").toUpperCase() === "DONE" ? `anonymous-${++this.pending.anonymousSteps}` : undefined);
                if (stepId !== undefined && !this.pending.observedStepIds.has(stepId)) {
                    if (this.pending.observedStepIds.size >= this.pending.maxSteps) {
                        void this.invalidate(new AgyBudgetError("steps", this.pending.maxSteps), true);
                        return;
                    }
                    if (this.pending.observedTokens >= this.pending.maxTokens) {
                        void this.invalidate(new AgyBudgetError("tokens", this.pending.maxTokens), true);
                        return;
                    }
                    this.pending.observedStepIds.add(stepId);
                }
                if (String(update.state ?? "").toUpperCase() === "DONE" &&
                    String(update.step_type ?? "").toLowerCase() === "agent_response" &&
                    typeof update.usage?.total_tokens === "number" &&
                    Number.isFinite(update.usage.total_tokens) &&
                    update.usage.total_tokens > 0) {
                    const usageKey = stepId ?? `usage-${++this.pending.anonymousSteps}`;
                    const previous = this.pending.stepTokenUsage.get(usageKey) ?? 0;
                    this.pending.observedTokens += Math.max(0, update.usage.total_tokens - previous);
                    this.pending.stepTokenUsage.set(usageKey, Math.max(previous, update.usage.total_tokens));
                }
                const summary = [update.step_type, update.state].filter(Boolean).join(":");
                if (summary)
                    this.pending.progress.push(summary);
                if (this.pending.progress.length > 50)
                    this.pending.progress.shift();
                this.resetInactivityTimer();
            }
            this.options.onRawEvent?.({ type: "step", stepUpdate: event.step_update });
            return;
        }
        if (event.event !== "result")
            return;
        const result = event.result;
        if (!result) {
            void this.invalidate(new Error("Antigravity emitted a result event without result data"), true);
            return;
        }
        if (!this.pending) {
            void this.invalidate(new Error("Antigravity emitted a result with no pending turn"), true);
            return;
        }
        this.conversationId = result.conversation_id || this.conversationId;
        this.lastResult = result;
        this.options.onRawEvent?.({ type: "result", result });
        const cumulativeUsage = result.usage;
        const turnUsage = this.usageBaselineTrusted
            ? usageDelta(cumulativeUsage, this.lastCumulativeUsage)
            : undefined;
        this.lastCumulativeUsage = cumulativeUsage;
        this.usageBaselineTrusted = true;
        if (result.status !== "SUCCESS") {
            const errorText = result.error || `Antigravity ended with status ${result.status}`;
            const guidance = /UNAVAILABLE|503|eligibility|quota/i.test(errorText)
                ? " Service-side availability/quota error: treat this worker as BLOCKED, not a retry signal — do not re-dispatch the same brief against it."
                : "";
            void this.invalidate(new Error(errorText + guidance), true, true);
            return;
        }
        if (!result.response.trim()) {
            const deniedCount = Array.isArray(result.denied_actions) ? result.denied_actions.length : 0;
            const deniedMsg = deniedCount > 0 ? ` (${deniedCount} action(s) denied)` : "";
            const guidance = deniedCount > 0
                ? " Denied actions mean a required permission was not granted: fix the narrow permission cause and retry deliberately; never widen permissions silently."
                : "";
            void this.invalidate(new Error(`Antigravity returned SUCCESS with an empty response${deniedMsg}.${guidance}`), true, true);
            return;
        }
        const pending = this.pending;
        this.pending = undefined;
        this.clearPendingTimers(pending);
        this.completedTurns += 1;
        pending.resolve({
            role: this.options.role,
            response: result.response,
            conversationId: result.conversation_id,
            status: result.status,
            durationSeconds: Math.max(0, (Date.now() - pending.startedAtMs) / 1_000),
            cliDurationSeconds: result.duration_seconds,
            numTurns: result.num_turns,
            ...(turnUsage ? { usage: turnUsage } : {}),
            cumulativeUsage,
            progress: pending.progress
        });
    }
    appendStderr(text) {
        this.recentStderr = (this.recentStderr + text).slice(-this.options.maxStderrBytes);
        this.options.onRawEvent?.({ type: "stderr", text });
    }
    resetInactivityTimer() {
        const pending = this.pending;
        if (!pending)
            return;
        if (pending.inactivityTimer)
            clearTimeout(pending.inactivityTimer);
        pending.inactivityTimer = setTimeout(() => {
            const err = new AgyTimeoutError("inactivity", pending.inactivityTimeoutMs);
            err.message = `${err.message}. No progress event arrived for ${pending.inactivityTimeoutMs}ms — the turn may have been generating one large quiet output. Check last_progress: if it shows an ACTIVE step, retry once with a higher inactivity_timeout_seconds instead of restarting from scratch.`;
            void this.invalidate(err, true);
        }, pending.inactivityTimeoutMs);
    }
    clearPendingTimers(pending) {
        if (pending.inactivityTimer)
            clearTimeout(pending.inactivityTimer);
        if (pending.maxDurationTimer)
            clearTimeout(pending.maxDurationTimer);
    }
    clearConversation() {
        this.conversationId = undefined;
        this.lastCumulativeUsage = undefined;
        this.usageBaselineTrusted = true;
    }
    unsafeRestartError() {
        return new Error(`Antigravity worker is unsafe to restart after unconfirmed process-tree termination; close it and create a new worker. ${this.unsafeTerminationError?.message ?? ""}`.trim());
    }
    async invalidate(error, preserveConversation, terminalUsageObserved = false) {
        if (this.invalidation)
            return this.invalidation;
        const child = this.child;
        this.child = undefined;
        const pending = this.pending;
        this.pending = undefined;
        if (pending)
            this.clearPendingTimers(pending);
        if (!preserveConversation)
            this.clearConversation();
        else if (pending && !terminalUsageObserved)
            this.usageBaselineTrusted = false;
        this.terminating = true;
        const work = (async () => {
            let rejection = error;
            if (child) {
                try {
                    await (this.options.terminateTree ?? terminateProcessTree)(child);
                }
                catch (terminationError) {
                    const detail = terminationError instanceof Error ? terminationError.message : String(terminationError);
                    this.unsafeTerminationError = new Error(`Antigravity process tree termination could not be confirmed: ${detail}`);
                    this.recentStderr = (this.recentStderr + `\n${this.unsafeTerminationError.message}`).slice(-this.options.maxStderrBytes);
                    rejection = this.unsafeTerminationError;
                }
            }
            this.terminating = false;
            pending?.reject(rejection);
        })();
        this.invalidation = work.finally(() => {
            this.invalidation = undefined;
            this.terminating = false;
        });
        return this.invalidation;
    }
}
//# sourceMappingURL=agy-worker.js.map