import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import type { AgyEvent, AgyTerminalResult, DelegationResult } from "./agy-protocol.js";
import { parseAgyEvent } from "./agy-protocol.js";
import type { Role } from "./config.js";

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
  maxStderrBytes: number;
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
  timer: NodeJS.Timeout;
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

  constructor(private readonly options: AgyWorkerOptions) {}

  delegate(task: string, timeoutMs = this.options.defaultTimeoutMs): Promise<DelegationResult> {
    if (!task.trim()) return Promise.reject(new Error("task must not be empty"));
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.reject(new Error("timeout must be positive"));
    const generation = this.stopGeneration;
    this.queueDepth += 1;
    const job = this.tail.then(() => {
      if (generation !== this.stopGeneration) throw new Error("Antigravity worker was stopped before the queued turn started");
      return this.runTurn(task, timeoutMs);
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
    const child = this.child;
    if (!child) return;
    this.invalidate(new Error("Antigravity worker was stopped"));
    if (child.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { child.kill(); resolve(); }, 750);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
      child.stdin.end();
    });
  }

  getConversationId(): string | undefined {
    return this.conversationId;
  }

  cancelActiveTurn(reason = "Antigravity active turn was canceled"): boolean {
    if (!this.pending) return false;
    this.conversationId = undefined;
    this.invalidate(new Error(reason));
    return true;
  }

  private runTurn(task: string, timeoutMs: number): Promise<DelegationResult> {
    this.ensureStarted();
    if (!this.child) return Promise.reject(new Error("Antigravity worker did not start"));
    return new Promise<DelegationResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.invalidate(new Error(`Antigravity turn timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending = { resolve, reject, progress: [], timer };
      const line = JSON.stringify({ event: "user", message: { content: task } }) + "\n";
      try {
        this.child!.stdin.write(line, (error) => {
          if (error) this.invalidate(new Error(`Failed to write to Antigravity: ${error.message}`));
        });
      } catch (error) {
        this.invalidate(new Error(`Failed to write to Antigravity: ${error instanceof Error ? error.message : String(error)}`));
      }
    });
  }

  private ensureStarted(): void {
    if (this.child) return;
    const args = [
      ...(this.options.prefixArgs ?? []),
      "--input-format", "stream-json", "--output-format", "stream-json", "--print-timeout", "0", "--mode", this.options.mode
    ];
    if (this.options.model) args.push("--model", this.options.model);
    if (this.options.effort) args.push("--effort", this.options.effort);
    if (this.options.agent) args.push("--agent", this.options.agent);
    if (this.options.sandbox) args.push("--sandbox");
    if (this.options.dangerouslySkipPermissions) args.push("--dangerously-skip-permissions");

    const child = spawn(this.options.executable, args, {
      cwd: this.options.cwd, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"]
    });
    this.child = child;
    this.recentStderr = "";
    const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => this.handleLine(line));
    child.stderr.on("data", (chunk: Buffer) => this.appendStderr(chunk.toString("utf8")));
    child.on("error", (error) => this.invalidate(new Error(`Failed to start Antigravity: ${error.message}`)));
    child.on("exit", (code, signal) => {
      if (this.child !== child) return;
      this.child = undefined;
      if (this.pending) this.failPending(new Error(`Antigravity exited before a result (code=${code ?? "null"}, signal=${signal ?? "null"})`));
    });
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;

    let event: AgyEvent;
    try {
      event = parseAgyEvent(line);
    } catch (error) {
      this.invalidate(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    if (event.event === "init") {
      if (event.conversation_id) this.conversationId = event.conversation_id;
      this.options.onRawEvent?.({ type: "init", conversationId: event.conversation_id, init: event.init });
      return;
    }
    if (event.event === "step_update") {
      const update = event.step_update;
      if (this.pending && update) {
        const summary = [update.step_type, update.state].filter(Boolean).join(":");
        if (summary) this.pending.progress.push(summary);
        if (this.pending.progress.length > 50) this.pending.progress.shift();
      }
      this.options.onRawEvent?.({ type: "step", stepUpdate: event.step_update });
      return;
    }
    if (event.event !== "result") return;
    const result = event.result;
    if (!result) {
      this.invalidate(new Error("Antigravity emitted a result event without result data"));
      return;
    }
    if (!this.pending) {
      this.invalidate(new Error("Antigravity emitted a result with no pending turn"));
      return;
    }
    this.conversationId = result.conversation_id || this.conversationId;
    this.lastResult = result;
    this.options.onRawEvent?.({ type: "result", result });
    if (result.status !== "SUCCESS") {
      this.invalidate(new Error(result.error || `Antigravity ended with status ${result.status}`));
      return;
    }
    if (!result.response.trim()) {
      const deniedCount = Array.isArray(result.denied_actions) ? result.denied_actions.length : 0;
      const deniedMsg = deniedCount > 0 ? ` (${deniedCount} action(s) denied)` : "";
      this.invalidate(new Error(`Antigravity returned SUCCESS with an empty response${deniedMsg}`));
      return;
    }
    const pending = this.pending;
    this.pending = undefined;
    clearTimeout(pending.timer);
    this.completedTurns += 1;
    pending.resolve({
      role: this.options.role,
      response: result.response,
      conversationId: result.conversation_id,
      status: result.status,
      durationSeconds: result.duration_seconds,
      numTurns: result.num_turns,
      usage: result.usage,
      progress: pending.progress
    });
  }

  private appendStderr(text: string): void {
    this.recentStderr = (this.recentStderr + text).slice(-this.options.maxStderrBytes);
    this.options.onRawEvent?.({ type: "stderr", text });
  }

  private failPending(error: Error): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = undefined;
    clearTimeout(pending.timer);
    pending.reject(error);
  }

  private invalidate(error: Error): void {
    const child = this.child;
    this.child = undefined;
    this.failPending(error);
    if (child && child.exitCode === null) child.kill();
  }
}
