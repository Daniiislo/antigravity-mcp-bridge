import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import type { AgyEvent, AgyTerminalResult, DelegationResult } from "./agy-protocol.js";
import { parseAgyEvent } from "./agy-protocol.js";
import type { Role } from "./config.js";
import { terminateProcessTree } from "./process-tree.js";

export type AgyWorkerRawEvent =
  | { type: "init"; conversationId?: string | undefined; init?: { cwd?: string | undefined; tools?: string[] | undefined } | undefined }
  | { type: "step"; stepUpdate?: { step_type?: string | undefined; state?: string | undefined; text_delta?: string | undefined; [k: string]: unknown } | undefined }
  | { type: "result"; result: AgyTerminalResult }
  | { type: "stderr"; text: string };

export interface AgyWorkerOptions {
  role: Role;
  cwd: string;
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

interface PendingTurn {
  resolve: (result: DelegationResult) => void;
  reject: (error: Error) => void;
  progress: string[];
  startedAtMs: number;
  inactivityTimeoutMs: number;
  maxDurationMs: number;
  inactivityTimer?: NodeJS.Timeout | undefined;
  maxDurationTimer?: NodeJS.Timeout | undefined;
}

export interface DelegationTimeouts {
  inactivityTimeoutMs?: number | undefined;
  maxDurationMs?: number | undefined;
}

export type TimeoutKind = "inactivity" | "max_duration";

export class AgyTimeoutError extends Error {
  readonly timeoutKind: TimeoutKind;

  constructor(kind: TimeoutKind, milliseconds: number) {
    const label = kind === "inactivity" ? "inactivity" : "maximum duration";
    super(`Antigravity turn timed out due to ${label} after ${milliseconds}ms`);
    this.name = "AgyTimeoutError";
    this.timeoutKind = kind;
  }
}

const USAGE_KEYS: Array<keyof import("./agy-protocol.js").AgyUsage> = [
  "input_tokens", "output_tokens", "thinking_tokens", "cache_read_tokens", "total_tokens"
];

function usageDelta(
  current: import("./agy-protocol.js").AgyUsage,
  previous: import("./agy-protocol.js").AgyUsage | undefined
): import("./agy-protocol.js").AgyUsage {
  const delta = {} as import("./agy-protocol.js").AgyUsage;
  for (const key of USAGE_KEYS) {
    const currentValue = current[key] ?? 0;
    const previousValue = previous?.[key] ?? 0;
    delta[key] = currentValue >= previousValue ? currentValue - previousValue : currentValue;
  }
  return delta;
}

export class AgyWorker {
  private child: ChildProcessWithoutNullStreams | undefined;
  private pending: PendingTurn | undefined;
  private tail: Promise<unknown> = Promise.resolve();
  private queueDepth = 0;
  private conversationId: string | undefined;
  private completedTurns = 0;
  private lastResult?: AgyTerminalResult;
  private recentStderr = "";
  private stopGeneration = 0;
  private invalidation: Promise<void> | undefined;
  private terminating = false;
  private lastCumulativeUsage: import("./agy-protocol.js").AgyUsage | undefined;
  private usageBaselineTrusted = true;
  private unsafeTerminationError: Error | undefined;

  constructor(private readonly options: AgyWorkerOptions) {}

  delegate(task: string, timeouts: number | DelegationTimeouts = {}): Promise<DelegationResult> {
    if (this.unsafeTerminationError) return Promise.reject(this.unsafeRestartError());
    if (!task.trim()) return Promise.reject(new Error("task must not be empty"));
    const inactivityTimeoutMs = typeof timeouts === "number"
      ? timeouts
      : (timeouts.inactivityTimeoutMs ?? this.options.defaultTimeoutMs);
    const maxDurationMs = typeof timeouts === "number"
      ? (this.options.defaultMaxTurnMs ?? Math.max(this.options.defaultTimeoutMs * 4, inactivityTimeoutMs))
      : (timeouts.maxDurationMs ?? this.options.defaultMaxTurnMs ?? Math.max(this.options.defaultTimeoutMs * 4, inactivityTimeoutMs));
    if (!Number.isFinite(inactivityTimeoutMs) || inactivityTimeoutMs <= 0) {
      return Promise.reject(new Error("inactivity timeout must be positive"));
    }
    if (!Number.isFinite(maxDurationMs) || maxDurationMs <= 0) {
      return Promise.reject(new Error("maximum duration must be positive"));
    }
    if (maxDurationMs < inactivityTimeoutMs) {
      return Promise.reject(new Error("maximum duration must be greater than or equal to the inactivity timeout"));
    }
    const generation = this.stopGeneration;
    this.queueDepth += 1;
    const job = this.tail.then(() => {
      if (generation !== this.stopGeneration) throw new Error("Antigravity worker was stopped before the queued turn started");
      if (this.unsafeTerminationError) throw this.unsafeRestartError();
      return this.runTurn(task, inactivityTimeoutMs, maxDurationMs);
    });
    this.tail = job.catch(() => undefined);
    return job.finally(() => { this.queueDepth -= 1; });
  }

  status(): WorkerStatus {
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

  async stop(): Promise<void> {
    this.stopGeneration += 1;
    this.clearConversation();
    if (this.invalidation) await this.invalidation;
    if (!this.child) return;
    await this.invalidate(new Error("Antigravity worker was stopped"), false);
  }

  getConversationId(): string | undefined {
    return this.conversationId;
  }

  cancelActiveTurn(reason = "Antigravity active turn was canceled"): boolean {
    if (!this.pending && !this.invalidation) return false;
    this.clearConversation();
    if (this.pending) void this.invalidate(new Error(reason), false);
    return true;
  }

  private runTurn(task: string, inactivityTimeoutMs: number, maxDurationMs: number): Promise<DelegationResult> {
    this.ensureStarted();
    if (!this.child) return Promise.reject(new Error("Antigravity worker did not start"));
    return new Promise<DelegationResult>((resolve, reject) => {
      this.pending = {
        resolve,
        reject,
        progress: [],
        startedAtMs: Date.now(),
        inactivityTimeoutMs,
        maxDurationMs
      };
      this.resetInactivityTimer();
      this.pending.maxDurationTimer = setTimeout(() => {
        void this.invalidate(new AgyTimeoutError("max_duration", maxDurationMs), true);
      }, maxDurationMs);
      const line = JSON.stringify({ event: "user", message: { content: task } }) + "\n";
      try {
        this.child!.stdin.write(line, (error) => {
          if (error) void this.invalidate(new Error(`Failed to write to Antigravity: ${error.message}`), true);
        });
      } catch (error) {
        void this.invalidate(new Error(`Failed to write to Antigravity: ${error instanceof Error ? error.message : String(error)}`), true);
      }
    });
  }

  private ensureStarted(): void {
    if (this.child) return;
    const args = [
      ...(this.options.prefixArgs ?? []),
      "--input-format", "stream-json", "--output-format", "stream-json", "--print-timeout", "0", "--mode", this.options.mode
    ];
    if (this.conversationId) args.push("--conversation", this.conversationId);
    if (this.options.model) args.push("--model", this.options.model);
    if (this.options.effort) args.push("--effort", this.options.effort);
    if (this.options.agent) args.push("--agent", this.options.agent);
    if (this.options.sandbox) args.push("--sandbox");
    if (this.options.dangerouslySkipPermissions) args.push("--dangerously-skip-permissions");

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
    child.stderr.on("data", (chunk: Buffer) => this.appendStderr(chunk.toString("utf8")));
    child.on("error", (error) => { void this.invalidate(new Error(`Failed to start Antigravity: ${error.message}`), true); });
    child.on("exit", (code, signal) => {
      if (this.child !== child) return;
      void this.invalidate(new Error(`Antigravity exited before a result (code=${code ?? "null"}, signal=${signal ?? "null"})`), true);
    });
  }

  private handleLine(line: string): void {
    if (this.terminating) return;
    if (!line.trim()) return;

    let event: AgyEvent;
    try {
      event = parseAgyEvent(line);
    } catch (error) {
      void this.invalidate(error instanceof Error ? error : new Error(String(error)), true);
      return;
    }
    if (event.event === "init") {
      if (event.conversation_id) {
        if (this.conversationId && this.conversationId !== event.conversation_id) this.lastCumulativeUsage = undefined;
        this.conversationId = event.conversation_id;
      }
      this.resetInactivityTimer();
      this.options.onRawEvent?.({ type: "init", conversationId: event.conversation_id, init: event.init });
      return;
    }
    if (event.event === "step_update") {
      const update = event.step_update;
      if (this.pending && update) {
        const summary = [update.step_type, update.state].filter(Boolean).join(":");
        if (summary) this.pending.progress.push(summary);
        if (this.pending.progress.length > 50) this.pending.progress.shift();
        this.resetInactivityTimer();
      }
      this.options.onRawEvent?.({ type: "step", stepUpdate: event.step_update });
      return;
    }
    if (event.event !== "result") return;
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
      void this.invalidate(new Error(result.error || `Antigravity ended with status ${result.status}`), true, true);
      return;
    }
    if (!result.response.trim()) {
      const deniedCount = Array.isArray(result.denied_actions) ? result.denied_actions.length : 0;
      const deniedMsg = deniedCount > 0 ? ` (${deniedCount} action(s) denied)` : "";
      void this.invalidate(new Error(`Antigravity returned SUCCESS with an empty response${deniedMsg}`), true, true);
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

  private appendStderr(text: string): void {
    this.recentStderr = (this.recentStderr + text).slice(-this.options.maxStderrBytes);
    this.options.onRawEvent?.({ type: "stderr", text });
  }

  private resetInactivityTimer(): void {
    const pending = this.pending;
    if (!pending) return;
    if (pending.inactivityTimer) clearTimeout(pending.inactivityTimer);
    pending.inactivityTimer = setTimeout(() => {
      void this.invalidate(new AgyTimeoutError("inactivity", pending.inactivityTimeoutMs), true);
    }, pending.inactivityTimeoutMs);
  }

  private clearPendingTimers(pending: PendingTurn): void {
    if (pending.inactivityTimer) clearTimeout(pending.inactivityTimer);
    if (pending.maxDurationTimer) clearTimeout(pending.maxDurationTimer);
  }

  private clearConversation(): void {
    this.conversationId = undefined;
    this.lastCumulativeUsage = undefined;
    this.usageBaselineTrusted = true;
  }

  private unsafeRestartError(): Error {
    return new Error(`Antigravity worker is unsafe to restart after unconfirmed process-tree termination; close it and create a new worker. ${this.unsafeTerminationError?.message ?? ""}`.trim());
  }

  private async invalidate(error: Error, preserveConversation: boolean, terminalUsageObserved = false): Promise<void> {
    if (this.invalidation) return this.invalidation;
    const child = this.child;
    this.child = undefined;
    const pending = this.pending;
    this.pending = undefined;
    if (pending) this.clearPendingTimers(pending);
    if (!preserveConversation) this.clearConversation();
    else if (pending && !terminalUsageObserved) this.usageBaselineTrusted = false;
    this.terminating = true;

    const work = (async () => {
      let rejection = error;
      if (child) {
        try {
          await (this.options.terminateTree ?? terminateProcessTree)(child);
        } catch (terminationError) {
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
