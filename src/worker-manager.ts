import { createHash, randomInt } from "node:crypto";
import { normalizeDeniedAction, type AgyTerminalResult, type AgyUsage, type DelegationResult } from "./agy-protocol.js";
import { AgyBudgetError, AgyTimeoutError, AgyWorker, type AgyWorkerRawEvent, type BudgetKind, type TimeoutKind, type WorkerStatus } from "./agy-worker.js";
import { resolveAllowedWorkspace, resolveCandidateRunsDirs, resolveDefaultRunsDir, type BridgeConfig, type Role } from "./config.js";
import {
  boundStepEvent,
  boundText,
  EventStore,
  type CleanJobsOptions,
  type CleanJobsResult,
  type JobHistorySummary,
  type NormalizedEvent
} from "./event-store.js";
import { ModelCatalog, type ListModelsResult } from "./model-catalog.js";
import { DashboardServer } from "./dashboard-server.js";
import { checkRequiredTools } from "./preflight.js";
import { runtimeInfo } from "./runtime-info.js";

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

interface ExplicitWorkerInternal {
  workerId: string;
  role: Role;
  workspace: string;
  model?: string | undefined;
  effort?: BridgeConfig["effort"] | undefined;
  constraints?: string | undefined;
  status: "idle" | "busy" | "closed";
  createdAt: string;
  worker: AgyWorker;
  queue: JobRecord[];
  activeJob?: JobRecord | undefined;
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

export type TerminalTaskResult = InspectTaskResult & { terminal: true };

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

export class WorkerManager {
  private readonly implicitWorkers = new Map<Role, AgyWorker>();
  private readonly explicitWorkers = new Map<string, ExplicitWorkerInternal>();
  private readonly jobs = new Map<string, JobRecord>();
  private requestHistory?: Promise<JobHistorySummary[]> | undefined;
  private readonly eventStore: EventStore;
  private readonly modelCatalog: ModelCatalog;
  private readonly runsDir: string;
  private readonly fallbackRunsDirs: string[];
  private dashboardServer?: DashboardServer | undefined;
  // Random numeric seeds retain the public ID format while preventing separate
  // MCP processes from generating the same IDs in a shared runs directory.
  private workerCounter = randomInt(1, 1_000_000_000);
  private jobCounter = randomInt(1, 1_000_000_000);

  constructor(
    private readonly config: BridgeConfig,
    private readonly prefixArgs: string[] = config.baseArgs ?? [],
    options?: { runsDir?: string | undefined; fallbackRunsDirs?: string[] | undefined }
  ) {
    const explicitRunsDir = options?.runsDir || config.runsDir;
    if (explicitRunsDir) {
      this.runsDir = explicitRunsDir;
      this.fallbackRunsDirs = options?.fallbackRunsDirs ?? [];
    } else {
      const candidateDirs = resolveCandidateRunsDirs();
      this.runsDir = candidateDirs[0] || resolveDefaultRunsDir();
      this.fallbackRunsDirs = options?.fallbackRunsDirs ?? candidateDirs.slice(1);
    }
    this.eventStore = new EventStore({
      runsDir: this.runsDir,
      fallbackRunsDirs: this.fallbackRunsDirs,
      maxFieldBytes: config.maxStderrBytes
    });
    this.modelCatalog = new ModelCatalog({
      executable: config.executable,
      prefixArgs: this.prefixArgs
    });
  }

  getRunsDir(): string {
    return this.runsDir;
  }

  getFallbackRunsDirs(): string[] {
    return this.fallbackRunsDirs;
  }

  async listModels(options?: { refresh?: boolean | undefined }): Promise<ListModelsResult> {
    return this.modelCatalog.listModels(options);
  }

  getRuntimeInfo() { return runtimeInfo(this.config); }

  /**
   * Usage protocol served to the host agent through the MCP initialize result.
   * Generated from live config so every bridge version teaches its own current
   * rules — no external skill or cached documentation can drift from it.
   */
  serverInstructions(): string {
    const info = runtimeInfo(this.config);
    return [
      "You are the controller for Antigravity CLI workers managed by this bridge.",
      "This server defines its own usage protocol; follow it instead of any remembered or externally documented procedure.",
      "",
      "WORKFLOW",
      "1. list_models (refresh: true) before pinning any non-default model or effort on create_worker; pass only IDs that command printed. An invalid model fails the whole dispatch.",
      "2. create_worker once per role (implementer edits; tester reviews in plan mode). One worker per role is enough; resume it for related fixes.",
      "3. dispatch_task with a decision-complete brief. One coherent workstream per dispatch: size the brief so it finishes within the deadline. A fresh conversation also spends time reading files before editing. A dispatch warning says the brief bundles multiple workstreams: split follow-ups into separate jobs on the same worker (its conversation persists, so context is not lost). Splitting costs nothing; a deadline kill costs the whole turn.",
      "4. wait_task once per job; it stays pending until terminal. Never poll status or events while a wait is possible. Host tool timeout must exceed the job deadline.",
      "5. Accept a terminal result only when: status succeeded, response non-empty, no denied actions, and required verification actually ran. A SUCCESS with an empty response or denied actions is failure.",
      "6. inspect_task / agy_events only for failure diagnostics; not after a successful wait.",
      "",
      `LIMITS (live from this build; do not assume other values)`,
      `- Inactivity timeout: ${info.inactivity_seconds}s without a meaningful progress event terminates the turn.`,
      `- Total deadline: ${info.maximum_turn_seconds}s default per job (dispatch total_duration_seconds may lower it). ${info.maximum_turn_seconds <= 600 ? "Keep briefs to 1-2 focused file edits." : "Near the deadline the bridge asks the worker to wrap up (FINISH_NOW); a result returned in that grace window is a normal handoff."}`,
      ...(info.steps_budget !== null ? [`- Step budget: ${info.steps_budget} steps per turn.`] : []),
      ...(info.observed_token_budget !== null ? [`- Observed token budget: ${info.observed_token_budget} per turn.`] : []),
      "",
      "FAILURE HANDLING",
      "- max_duration timeout: the brief did not fit the deadline. Do NOT re-dispatch the same brief, and do not escalate timeouts on one brief. Resume the same worker with a small inventory-and-finish brief covering only the remaining delta; never rewrite completed files.",
      "- inactivity timeout while progress shows an ACTIVE compose step: the turn was generating a large output quietly. Retry once with a higher inactivity_timeout_seconds instead of restarting from scratch.",
      "- Service-side 503/eligibility errors: BLOCKED for that worker, not a retry signal. Report or switch model once; do not loop dispatches.",
      "- ORPHANED_JOB (job stuck queued/running from a previous bridge session): its process is dead. Inspect the partial diff and dispatch a new bounded job under a new request key.",
      "- Timeout preserves the worker conversation: check the workspace diff before writing any salvage brief.",
      "",
      "RECOVERY",
      "- agy_history recovers job summaries after a bridge/MCP restart; inspect_task the persisted job for detail.",
      "- cancel_task obsolete jobs (cancelling an active turn invalidates that conversation); close_worker when the checkpoint is accepted."
    ].join("\n");
  }

  async createWorker(options: CreateWorkerOptions): Promise<ExplicitWorkerInfo> {
    const workspace = resolveAllowedWorkspace(options.workspace, this.config.allowedRoots);
    checkRequiredTools(options.requiredTools ?? []);
    this.workerCounter += 1;
    const workerId = `worker-${options.role}-${Date.now()}-${this.workerCounter}`;

    const effectiveEffort = options.effort ?? this.config.effort;
    const agyWorker = new AgyWorker({
      role: options.role,
      cwd: workspace,
      executable: this.config.executable,
      prefixArgs: this.prefixArgs,
      mode: options.role === "tester" ? "plan" : "accept-edits",
      model: options.model ?? this.config.model,
      effort: effectiveEffort,
      ...(this.config.agent ? { agent: this.config.agent } : {}),
      sandbox: this.config.sandbox,
      dangerouslySkipPermissions: this.config.dangerouslySkipPermissions,
      defaultTimeoutMs: this.config.defaultTimeoutMs,
      ...(this.config.maxTurnTimeoutMs ? { defaultMaxTurnMs: this.config.maxTurnTimeoutMs } : {}),
      ...(this.config.maxSteps ? { defaultMaxSteps: this.config.maxSteps } : {}),
      ...(this.config.maxTurnTokens ? { defaultMaxTokens: this.config.maxTurnTokens } : {}),
      maxStderrBytes: this.config.maxStderrBytes,
      onRawEvent: (raw) => {
        this.handleRawWorkerEvent(workerId, raw);
      }
    });

    const info: ExplicitWorkerInternal = {
      workerId,
      role: options.role,
      workspace,
      model: options.model ?? this.config.model,
      effort: effectiveEffort,
      constraints: options.constraints,
      status: "idle",
      createdAt: new Date().toISOString(),
      worker: agyWorker,
      queue: []
    };

    this.explicitWorkers.set(workerId, info);

    this.eventStore.recordEvent({
      eventType: "lifecycle",
      workerId,
      data: {
        lifecycle: "worker_created",
        role: options.role,
        workspace,
        model: info.model,
        effort: info.effort,
        constraints: options.constraints
      }
    });

    return {
      workerId,
      role: options.role,
      workspace,
      model: info.model,
      effort: info.effort,
      hasConstraints: Boolean(options.constraints),
      status: "idle",
      createdAt: info.createdAt
    };
  }

  async dispatchTask(
    workerId: string,
    brief: string,
    timeoutSeconds?: number | undefined,
    maxDurationSeconds?: number | undefined,
    options: DispatchOptions = {}
  ): Promise<DispatchTaskResult> {
    if (!brief.trim()) throw new Error("brief must not be empty");
    if (options.requestKey !== undefined && (!options.requestKey.trim() || options.requestKey.length > 128)) {
      throw new Error("request key must contain 1-128 characters");
    }
    if (options.totalDurationSeconds !== undefined && (!Number.isFinite(options.totalDurationSeconds) || options.totalDurationSeconds <= 0)) {
      throw new Error("total duration must be positive");
    }
    const requestFingerprint = createHash("sha256").update(JSON.stringify({ workerId, brief, timeoutSeconds, maxDurationSeconds, totalDurationSeconds: options.totalDurationSeconds })).digest("hex");
    if (options.requestKey) {
      const previous = [...this.jobs.values()].find(job => job.requestKey === options.requestKey);
      if (previous) {
        if (previous.requestFingerprint !== requestFingerprint) throw new Error("Conflicting retry for request key");
        return { jobId: previous.jobId, workerId: previous.workerId, role: previous.role, status: previous.status };
      }
      // Hydrate restart identities once, rather than rereading all logs on every dispatch.
      this.requestHistory ??= this.eventStore.readDiskHistory({ limit: 100_000 });
      const persisted = (await this.requestHistory).find(job => job.request_key === options.requestKey);
      const concurrent = [...this.jobs.values()].find(job => job.requestKey === options.requestKey);
      if (concurrent) {
        if (concurrent.requestFingerprint !== requestFingerprint) throw new Error("Conflicting retry for request key");
        return { jobId: concurrent.jobId, workerId: concurrent.workerId, role: concurrent.role, status: concurrent.status };
      }
      if (persisted) {
        if (persisted.request_fingerprint !== requestFingerprint) throw new Error("Conflicting retry for request key");
        if (persisted.status === "queued" || persisted.status === "running" || persisted.status === "orphaned") throw new Error(`ORPHANED_JOB: ${persisted.job_id}; inspect the original job before replacement`);
        return { jobId: persisted.job_id, workerId: persisted.worker_id, role: persisted.role as Role, status: persisted.status as JobStatus };
      }
    }
    const worker = this.explicitWorkers.get(workerId);
    if (!worker) {
      throw new Error(`Worker not found: ${workerId}`);
    }
    if (worker.status === "closed") {
      throw new Error(`Worker is closed: ${workerId}`);
    }
    if (timeoutSeconds !== undefined && (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0)) {
      throw new Error("inactivity timeout must be positive");
    }
    if (maxDurationSeconds !== undefined && (!Number.isFinite(maxDurationSeconds) || maxDurationSeconds <= 0)) {
      throw new Error("maximum duration must be positive");
    }
    const effectiveInactivitySeconds = timeoutSeconds ?? (this.config.defaultTimeoutMs / 1_000);
    const effectiveMaxDurationSeconds = maxDurationSeconds
      ?? (this.config.maxTurnTimeoutMs === undefined ? undefined : this.config.maxTurnTimeoutMs / 1_000);
    if (effectiveMaxDurationSeconds !== undefined && effectiveMaxDurationSeconds < effectiveInactivitySeconds) {
      throw new Error("maximum duration must be greater than or equal to the inactivity timeout");
    }

    this.jobCounter += 1;
    const jobId = `job-${Date.now()}-${this.jobCounter}`;

    const budgetInstruction = this.config.maxSteps || this.config.maxTurnTokens
      ? `[Budget]\n${this.config.maxSteps ?? "configured"} steps/${this.config.maxTurnTokens ?? "configured"} tokens max. Use one repo-native verification path; after one missing tool, report it. Reserve a concise final response.\n\n`
      : "";
    const effectivePrompt = budgetInstruction || worker.constraints
      ? `${budgetInstruction}${worker.constraints ? `[Constraints]\n${worker.constraints}\n\n` : ""}[Task]\n${brief}`
      : brief;

    const totalMs = (options.totalDurationSeconds ?? effectiveMaxDurationSeconds ?? 600) * 1_000;
    const deadlineAt = new Date(Date.now() + totalMs).toISOString();
    const job: JobRecord = {
      jobId,
      workerId,
      role: worker.role,
      workspace: worker.workspace,
      brief,
      effectivePrompt,
      ...(timeoutSeconds === undefined ? {} : { timeoutMs: timeoutSeconds * 1_000 }),
      ...(maxDurationSeconds === undefined ? {} : { maxDurationMs: maxDurationSeconds * 1_000 }),
      ...(this.config.maxSteps ? { maxSteps: this.config.maxSteps } : {}),
      ...(this.config.maxTurnTokens ? { maxTurnTokens: this.config.maxTurnTokens } : {}),
      ...(options.requestKey ? { requestKey: options.requestKey, requestFingerprint } : {}),
      deadlineAt,
      totalDurationSeconds: totalMs / 1_000,
      status: "queued",
      createdAt: new Date().toISOString(),
      stepEvents: [],
      deniedActions: []
    };

    this.jobs.set(jobId, job);
    worker.queue.push(job);

    this.eventStore.recordEvent({
      eventType: "lifecycle",
      workerId,
      jobId,
      data: {
        lifecycle: "queued",
        role: worker.role,
        workspace: worker.workspace,
        brief,
        effective_prompt: effectivePrompt,
        ...(timeoutSeconds === undefined ? {} : { inactivity_timeout_seconds: timeoutSeconds }),
        ...(maxDurationSeconds === undefined ? {} : { max_duration_seconds: maxDurationSeconds }),
        ...(this.config.maxSteps ? { max_steps: this.config.maxSteps } : {}),
        ...(this.config.maxTurnTokens ? { max_turn_tokens: this.config.maxTurnTokens } : {}),
        ...(options.requestKey ? { request_key: options.requestKey, request_fingerprint: requestFingerprint } : {}),
        deadline_at: deadlineAt,
        total_duration_seconds: totalMs / 1_000,
        created_at: job.createdAt
      }
    });

    job.deadlineTimer = setTimeout(() => {
      if (job.status === "running") {
        const error = new AgyTimeoutError("max_duration", totalMs);
        error.message = `Total job deadline exceeded during execution after ${totalMs}ms. The brief did not fit the deadline. Inspect the workspace diff, then resume the same worker with a small inventory-and-finish brief covering only the remaining delta — do not re-dispatch the same brief.`;
        worker.worker.interruptActiveTurn(error);
      } else if (job.status === "queued") {
        this.expireQueuedJob(worker, job);
      }
    }, Math.max(0, Date.parse(deadlineAt) - Date.now()));

    // Graceful deadline: shortly before the hard deadline, ask the CLI to wrap
    // up and hand off what it has. A turn that returns a terminal result within
    // the grace window succeeds and preserves the conversation, so partial work
    // is handed back instead of being killed mid-write.
    const GRACE_WINDOW_MS = 45_000;
    const gracefulDelayMs = Math.max(0, Date.parse(deadlineAt) - Date.now() - GRACE_WINDOW_MS);
    if (gracefulDelayMs > 0) {
      job.gracefulFinishTimer = setTimeout(() => {
        if (job.status === "running" && !worker.worker.requestGracefulFinish()) {
          // The CLI could not accept a finish request (process gone or between
          // turns); the hard deadline still applies.
        }
      }, gracefulDelayMs);
    }
    this.processWorkerQueue(worker);

    // Oversized-brief advisory: catch multi-workstream bundling at the
    // decision point instead of at the deadline. Soft signal, never blocks —
    // the job is already queued; the controller can still split follow-ups.
    const warnings = this.briefWarnings(brief, totalMs / 1_000);

    return {
      jobId,
      workerId,
      role: worker.role,
      status: job.status,
      ...(warnings.length > 0 ? { warnings } : {})
    };
  }

  /**
   * Heuristic advisory for briefs that bundle several workstreams into one
   * turn. Evidence from failed runs: briefs mixing 3-4 workstreams with many
   * file targets (2.5k-4.5k chars) died at the deadline while focused
   * single-workstream briefs finished comfortably. Warn so the controller can
   * split into sequential dispatches on the same worker (conversation persists
   * between jobs, so context is not lost).
   */
  private briefWarnings(brief: string, deadlineSeconds: number): string[] {
    const fileTargets = new Set(
      [...brief.matchAll(/[A-Za-z0-9_.-]+[\\/][A-Za-z0-9_.\\/-]+/g)].map((m) => m[0])
    ).size;
    if (brief.length <= 3_000 && fileTargets <= 5) return [];
    return [
      `Oversized brief: ${brief.length} chars, ${fileTargets} distinct file targets, ${deadlineSeconds}s deadline. ` +
      "This brief appears to bundle multiple workstreams into one turn. " +
      "Split it: dispatch each workstream as its own job on this same worker — the conversation persists between jobs, so the worker keeps context without re-reading everything."
    ];
  }

  async sendFollowup(
    workerId: string,
    finding: string,
    timeoutSeconds?: number | undefined,
    maxDurationSeconds?: number | undefined,
    options: DispatchOptions = {}
  ): Promise<{ jobId: string; workerId: string; role: Role; status: JobStatus }> {
    return this.dispatchTask(workerId, finding, timeoutSeconds, maxDurationSeconds, options);
  }

  async waitTask(jobId: string, options?: { waitMs?: number | undefined; afterCursor?: number | undefined }): Promise<WaitTaskResult> {
    const job = this.jobs.get(jobId);
    if (!job) {
      const persisted = this.eventStore.readDiskJob(jobId);
      if (persisted) {
        return {
          job_id: persisted.job_id,
          worker_id: persisted.worker_id,
          status: persisted.status,
          terminal: true,
          cursor: this.eventStore.latestCursor,
          events: [],
        };
      }
      throw new Error(`Job not found: ${jobId}`);
    }

    const isTerminal = () => job.status === "succeeded" || job.status === "failed" || job.status === "canceled";
    const afterCursor = options?.afterCursor;
    const MAX_WAIT_MS = 300_000;
    const boundedWaitMs = Math.min(Math.max(options?.waitMs ?? 300_000, 0), MAX_WAIT_MS);

    const shouldReturnImmediately = (): boolean => {
      if (isTerminal()) return true;
      if (afterCursor !== undefined) {
        const existing = this.eventStore.getEvents({ jobId, afterCursor });
        if (existing.events.length > 0) return true;
      }
      return false;
    };

    if (!shouldReturnImmediately() && boundedWaitMs > 0) {
      await new Promise<void>((resolve) => {
        let timer: NodeJS.Timeout;
        const listener = (evt: NormalizedEvent) => {
          if (evt.jobId === jobId) {
            if (isTerminal()) {
              cleanup();
              resolve();
            } else if (afterCursor !== undefined && evt.cursor > afterCursor) {
              cleanup();
              resolve();
            }
          }
        };
        const cleanup = () => {
          clearTimeout(timer);
          this.eventStore.off("event", listener);
        };
        timer = setTimeout(() => {
          cleanup();
          resolve();
        }, boundedWaitMs);
        this.eventStore.on("event", listener);
      });
    }

    const eventsRes = afterCursor !== undefined ? this.eventStore.getEvents({ jobId, afterCursor }) : undefined;
    return {
      job_id: job.jobId,
      worker_id: job.workerId,
      status: job.status,
      terminal: isTerminal(),
      cursor: eventsRes?.latest_cursor ?? this.eventStore.latestCursor,
      events: eventsRes?.events ?? []
    };
  }

  async waitTaskUntilTerminal(jobId: string, options?: { signal?: AbortSignal | undefined }): Promise<TerminalTaskResult> {
    const job = this.jobs.get(jobId);
    if (!job) {
      const persisted = this.eventStore.readDiskJob(jobId);
      if (!persisted) throw new Error(`Job not found: ${jobId}`);
      if (persisted.status === "queued" || persisted.status === "running" || persisted.status === "orphaned") {
        throw new Error(`ORPHANED_JOB: ${jobId} was ${persisted.status} when the bridge stopped and cannot be resumed safely`);
      }
      return { ...this.inspectTask(jobId), terminal: true };
    }

    const isTerminal = () => job.status === "succeeded" || job.status === "failed" || job.status === "canceled";
    const signal = options?.signal;
    if (signal?.aborted) throw this.waitAbortedError(jobId);

    if (!isTerminal()) {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const cleanup = () => {
          this.eventStore.off("event", onEvent);
          signal?.removeEventListener("abort", onAbort);
        };
        const finish = (callback: () => void) => {
          if (settled) return;
          settled = true;
          cleanup();
          callback();
        };
        const onEvent = (evt: NormalizedEvent) => {
          if (evt.jobId === jobId && isTerminal()) finish(resolve);
        };
        const onAbort = () => finish(() => reject(this.waitAbortedError(jobId)));

        this.eventStore.on("event", onEvent);
        signal?.addEventListener("abort", onAbort, { once: true });

        // Close the check/register race if the job completed immediately
        // before the listener was attached.
        if (isTerminal()) finish(resolve);
        else if (signal?.aborted) onAbort();
      });
    }

    return { ...this.inspectTask(jobId), terminal: true };
  }

  private waitAbortedError(jobId: string): Error {
    const error = new Error(`Wait canceled by caller for job ${jobId}; the job was not canceled`);
    error.name = "AbortError";
    return error;
  }

  inspectTask(jobId: string, options: InspectTaskOptions = {}): InspectTaskResult {
    const job = this.jobs.get(jobId);
    if (!job) {
      const persisted = this.eventStore.readDiskJob(jobId, options);
      if (persisted) {
        return this.compactInspection(persisted, options);
      }
      throw new Error(`Job not found: ${jobId}`);
    }

    const offset = Math.max(options?.stepOffset ?? 0, 0);
    const limit = Math.min(Math.max(options?.stepLimit ?? 20, 1), 100);
    const totalSteps = job.stepEvents.length;
    const slicedSteps = job.stepEvents.slice(offset, offset + limit);
    const hasMoreSteps = totalSteps > offset + slicedSteps.length;
    const boundedSteps = slicedSteps.map((evt) => boundStepEvent(evt, 4_096));

    const MAX_DENIED = 20;
    const totalDenied = job.deniedActions.length;
    const slicedDenied = job.deniedActions.slice(0, MAX_DENIED);
    const hasMoreDenied = totalDenied > slicedDenied.length;

    return this.compactInspection({
      ...(job.deadlineAt ? { deadline_at: job.deadlineAt, total_duration_seconds: job.totalDurationSeconds } : {}),
      job_id: job.jobId,
      worker_id: job.workerId,
      role: job.role,
      workspace: job.workspace,
      status: job.status,
      brief: job.brief,
      effective_prompt: job.effectivePrompt,
      created_at: job.createdAt,
      ...(job.startedAt ? { started_at: job.startedAt } : {}),
      ...(job.finishedAt ? { finished_at: job.finishedAt } : {}),
      ...(job.durationSeconds !== undefined ? { duration_seconds: job.durationSeconds } : {}),
      ...(job.cliDurationSeconds !== undefined ? { cli_duration_seconds: job.cliDurationSeconds } : {}),
      ...(job.timeoutMs !== undefined ? { inactivity_timeout_seconds: job.timeoutMs / 1_000 } : {}),
      ...(job.maxDurationMs !== undefined ? { max_duration_seconds: job.maxDurationMs / 1_000 } : {}),
      ...(job.maxSteps !== undefined ? { max_steps: job.maxSteps } : {}),
      ...(job.maxTurnTokens !== undefined ? { max_turn_tokens: job.maxTurnTokens } : {}),
      ...(job.conversationId ? { conversation_id: job.conversationId } : {}),
      ...(job.timeoutKind ? { timeout_kind: job.timeoutKind } : {}),
      ...(job.budgetKind ? { budget_kind: job.budgetKind } : {}),
      ...(job.lastActivityAt ? { last_activity_at: job.lastActivityAt } : {}),
      ...(job.lastProgress ? { last_progress: job.lastProgress } : {}),
      total_steps: totalSteps,
      step_offset: offset,
      step_limit: limit,
      has_more_steps: hasMoreSteps,
      step_events: boundedSteps,
      total_denied_actions: totalDenied,
      denied_actions: slicedDenied,
      has_more_denied_actions: hasMoreDenied,
      ...(job.usage ? { usage: job.usage } : {}),
      ...(job.cumulativeUsage ? { cumulative_usage: job.cumulativeUsage } : {}),
      ...(job.result !== undefined ? { result: job.result } : {}),
      ...(job.error !== undefined ? { error: job.error } : {})
    }, options);
  }

  hasLiveJob(jobId: string): boolean {
    return this.jobs.has(jobId);
  }

  private compactInspection(source: Omit<InspectTaskResult, "caller_payload_chars" | "response_char_budget" | "response_truncated">, options: InspectTaskOptions): InspectTaskResult {
    const includePrompt = options.includePrompt === true;
    const includeSteps = options.includeSteps === true;
    const resultWasTruncated = (source.result?.length ?? 0) > 12_288;
    const errorWasTruncated = (source.error?.length ?? 0) > 4_096;
    const compact: Omit<InspectTaskResult, "caller_payload_chars"> = {
      ...(source.deadline_at ? { deadline_at: source.deadline_at, total_duration_seconds: source.total_duration_seconds } : {}),
      job_id: source.job_id, worker_id: source.worker_id, role: source.role, workspace: source.workspace,
      status: source.status, created_at: source.created_at, total_steps: source.total_steps,
      total_denied_actions: source.total_denied_actions, denied_actions: source.denied_actions.slice(0, 20),
      has_more_denied_actions: source.has_more_denied_actions,
      ...(source.started_at ? { started_at: source.started_at } : {}),
      ...(source.finished_at ? { finished_at: source.finished_at } : {}),
      ...(source.duration_seconds !== undefined ? { duration_seconds: source.duration_seconds } : {}),
      ...(source.cli_duration_seconds !== undefined ? { cli_duration_seconds: source.cli_duration_seconds } : {}),
      ...(source.inactivity_timeout_seconds !== undefined ? { inactivity_timeout_seconds: source.inactivity_timeout_seconds } : {}),
      ...(source.max_duration_seconds !== undefined ? { max_duration_seconds: source.max_duration_seconds } : {}),
      ...(source.max_steps !== undefined ? { max_steps: source.max_steps } : {}),
      ...(source.max_turn_tokens !== undefined ? { max_turn_tokens: source.max_turn_tokens } : {}),
      ...(source.conversation_id ? { conversation_id: source.conversation_id } : {}),
      ...(source.timeout_kind ? { timeout_kind: source.timeout_kind } : {}),
      ...(source.budget_kind ? { budget_kind: source.budget_kind } : {}),
      ...(source.last_activity_at ? { last_activity_at: source.last_activity_at } : {}),
      ...(source.last_progress ? { last_progress: source.last_progress } : {}),
      ...(source.usage ? { usage: source.usage } : {}),
      ...(source.cumulative_usage ? { cumulative_usage: source.cumulative_usage } : {}),
      ...(source.result !== undefined ? { result: boundText(source.result, 12_288) } : {}),
      ...(source.error !== undefined ? { error: boundText(source.error, 4_096) } : {}),
      ...(includePrompt ? { brief: boundText(source.brief, 2_048) ?? "", effective_prompt: boundText(source.effective_prompt, 4_096) ?? "" } : {}),
      ...(includeSteps ? {
        step_offset: source.step_offset ?? 0,
        step_limit: source.step_limit ?? 20,
        has_more_steps: source.has_more_steps ?? false,
        step_events: (source.step_events ?? []).map((event) => boundStepEvent(event, 512))
      } : {}),
      response_char_budget: 32_768,
      response_truncated: resultWasTruncated || errorWasTruncated
    };
    const chars = JSON.stringify(compact).length;
    return { ...compact, caller_payload_chars: chars };
  }

  private elapsedSeconds(startedAt: string | undefined, finishedAt: string | undefined): number {
    if (!startedAt) return 0;
    const endMs = finishedAt ? Date.parse(finishedAt) : Date.now();
    return Math.max(0, (endMs - Date.parse(startedAt)) / 1_000);
  }

  async cancelTask(jobId: string): Promise<{ jobId: string; status: JobStatus; active: boolean }> {
    const job = this.jobs.get(jobId);
    if (!job) {
      const persisted = this.eventStore.readDiskJob(jobId);
      if (persisted) {
        return { jobId, status: persisted.status, active: false };
      }
      throw new Error(`Job not found: ${jobId}`);
    }

    if (job.status === "succeeded" || job.status === "failed" || job.status === "canceled" || job.status === "orphaned") {
      return { jobId, status: job.status, active: false };
    }

    const worker = this.explicitWorkers.get(job.workerId);
    const isActive = worker?.activeJob?.jobId === jobId;

    job.status = "canceled";
    if (job.deadlineTimer) clearTimeout(job.deadlineTimer);
    if (job.gracefulFinishTimer) clearTimeout(job.gracefulFinishTimer);
    job.finishedAt = new Date().toISOString();

    if (isActive && worker) {
      worker.worker.cancelActiveTurn("Active job was canceled by controller");
    } else if (worker) {
      worker.queue = worker.queue.filter((j) => j.jobId !== jobId);
    }

    this.eventStore.recordEvent({
      eventType: "lifecycle",
      workerId: job.workerId,
      jobId,
      data: {
        lifecycle: "canceled",
        finished_at: job.finishedAt,
        active: isActive
      }
    });

    return { jobId, status: "canceled", active: isActive };
  }

  async closeWorker(workerId: string): Promise<{ workerId: string; status: "closed" }> {
    const worker = this.explicitWorkers.get(workerId);
    if (!worker) {
      throw new Error(`Worker not found: ${workerId}`);
    }

    worker.status = "closed";

    for (const qJob of worker.queue) {
      if (qJob.deadlineTimer) clearTimeout(qJob.deadlineTimer);
      if (qJob.gracefulFinishTimer) clearTimeout(qJob.gracefulFinishTimer);
      qJob.status = "canceled";
      qJob.finishedAt = new Date().toISOString();
      this.eventStore.recordEvent({
        eventType: "lifecycle",
        workerId,
        jobId: qJob.jobId,
        data: {
          lifecycle: "canceled",
          finished_at: qJob.finishedAt,
          active: false
        }
      });
    }
    worker.queue = [];

    if (worker.activeJob) {
      const activeJob = worker.activeJob;
      if (activeJob.deadlineTimer) clearTimeout(activeJob.deadlineTimer);
      if (activeJob.gracefulFinishTimer) clearTimeout(activeJob.gracefulFinishTimer);
      activeJob.status = "canceled";
      activeJob.finishedAt = new Date().toISOString();
      worker.worker.cancelActiveTurn("Worker was closed by controller");
      this.eventStore.recordEvent({
        eventType: "lifecycle",
        workerId,
        jobId: activeJob.jobId,
        data: {
          lifecycle: "canceled",
          finished_at: activeJob.finishedAt,
          active: true
        }
      });
      worker.activeJob = undefined;
    }

    await worker.worker.stop();

    this.eventStore.recordEvent({
      eventType: "lifecycle",
      workerId,
      data: {
        lifecycle: "worker_closed"
      }
    });

    return { workerId, status: "closed" };
  }

  getEvents(filter: {
    workerId?: string | undefined;
    jobId?: string | undefined;
    afterCursor?: number | undefined;
    limit?: number | undefined;
  }) {
    return this.eventStore.getEvents(filter);
  }

  async getHistory(filter?: {
    workerId?: string | undefined;
    status?: string | undefined;
    limit?: number | undefined;
  }): Promise<{ jobs: JobHistorySummary[] }> {
    const diskSummaries = await this.eventStore.readDiskHistory(filter);
    const jobsMap = new Map<string, JobHistorySummary>();

    for (const item of diskSummaries) {
      jobsMap.set(item.job_id, item);
    }

    for (const job of this.jobs.values()) {
      if (filter?.workerId && job.workerId !== filter.workerId) continue;
      if (filter?.status && job.status !== filter.status) continue;
      jobsMap.set(job.jobId, {
        job_id: job.jobId,
        worker_id: job.workerId,
        role: job.role,
        workspace: job.workspace,
        status: job.status,
        brief: job.brief,
        created_at: job.createdAt,
        ...(job.startedAt ? { started_at: job.startedAt } : {}),
        ...(job.finishedAt ? { finished_at: job.finishedAt } : {}),
        ...(job.durationSeconds !== undefined ? { duration_seconds: job.durationSeconds } : {}),
        ...(job.cliDurationSeconds !== undefined ? { cli_duration_seconds: job.cliDurationSeconds } : {}),
        ...(job.usage ? { usage: job.usage } : {}),
        ...(job.cumulativeUsage ? { cumulative_usage: job.cumulativeUsage } : {}),
        ...(job.timeoutKind ? { timeout_kind: job.timeoutKind } : {}),
        ...(job.budgetKind ? { budget_kind: job.budgetKind } : {}),
        ...(job.maxSteps !== undefined ? { max_steps: job.maxSteps } : {}),
        ...(job.maxTurnTokens !== undefined ? { max_turn_tokens: job.maxTurnTokens } : {}),
        ...(job.result ? { result: job.result } : {}),
        ...(job.error ? { error: job.error } : {})
      });
    }

    let all = Array.from(jobsMap.values());
    if (filter?.workerId) {
      all = all.filter((j) => j.worker_id === filter.workerId);
    }
    if (filter?.status) {
      all = all.filter((j) => j.status === filter.status);
    }

    all.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

    const limit = filter?.limit ?? 20;
    return { jobs: all.slice(0, limit) };
  }

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
  }> {
    return Array.from(this.explicitWorkers.values()).map((w) => ({
      workerId: w.workerId,
      role: w.role,
      workspace: w.workspace,
      ...(w.model ? { model: w.model } : {}),
      ...(w.effort ? { effort: w.effort } : {}),
      ...(w.constraints ? { constraints: w.constraints } : {}),
      status: w.status,
      createdAt: w.createdAt,
      queueDepth: w.queue.length
    }));
  }

  getJobDetail(jobId: string): Record<string, unknown> | undefined {
    const inMem = this.jobs.get(jobId);
    if (inMem) {
      const inspected = this.inspectTask(jobId, { stepLimit: 500 });
      const diskEvents = this.eventStore.readDiskJobEvents(jobId);
      const liveEvents = this.eventStore.getEvents({ jobId, limit: 500 }).events;
      const eventsMap = new Map<number, NormalizedEvent>();
      for (const ev of diskEvents) eventsMap.set(ev.cursor, ev);
      for (const ev of liveEvents) eventsMap.set(ev.cursor, ev);
      const mergedEvents = Array.from(eventsMap.values()).sort((a, b) => a.cursor - b.cursor);
      return {
        ...inspected,
        events: mergedEvents
      };
    }

    const diskJob = this.eventStore.readDiskJob(jobId, { stepLimit: 500 });
    if (diskJob) {
      const diskEvents = this.eventStore.readDiskJobEvents(jobId);
      return {
        ...diskJob,
        events: diskEvents
      };
    }

    return undefined;
  }

  async getDashboardUrl(options?: { workerId?: string | undefined; jobId?: string | undefined; workspace?: string | undefined }): Promise<string | undefined> {
    if (this.config.dashboardEnabled === false) {
      return undefined;
    }
    if (!this.dashboardServer) {
      this.dashboardServer = new DashboardServer({
        manager: this,
        eventStore: this.eventStore,
        runsDir: this.runsDir,
        port: this.config.dashboardPort,
        enabled: this.config.dashboardEnabled
      });
    }
    return this.dashboardServer.getUrl(options);
  }

  getDashboardServer(): DashboardServer | undefined {
    return this.dashboardServer;
  }

  async deleteJob(jobId: string): Promise<{ success: boolean; jobId: string }> {
    const job = this.jobs.get(jobId);
    if (job && (job.status === "queued" || job.status === "running")) {
      throw new Error(`Cannot delete active job "${jobId}" with status "${job.status}". Cancel it first.`);
    }

    const success = this.eventStore.deleteJob(jobId);
    this.jobs.delete(jobId);
    this.requestHistory = undefined;

    this.eventStore.recordEvent({
      eventType: "lifecycle",
      workerId: job?.workerId || "system",
      data: {
        lifecycle: "job_deleted",
        job_id: jobId
      }
    });

    return { success, jobId };
  }

  async cleanJobs(options: CleanJobsOptions = {}): Promise<CleanJobsResult> {
    const activeJobIds: string[] = [];
    for (const [id, job] of this.jobs.entries()) {
      if (job.status === "queued" || job.status === "running") {
        activeJobIds.push(id);
      }
    }

    const mergedOptions: CleanJobsOptions = {
      ...options,
      excludeJobIds: Array.from(new Set([...(options.excludeJobIds || []), ...activeJobIds]))
    };

    const result = await this.eventStore.cleanJobs(mergedOptions);
    this.requestHistory = undefined;

    for (const id of result.deletedJobIds) {
      this.jobs.delete(id);
    }

    this.eventStore.recordEvent({
      eventType: "lifecycle",
      workerId: "system",
      data: {
        lifecycle: "jobs_cleaned",
        deleted_count: result.deletedCount,
        deleted_jobs: result.deletedJobIds
      }
    });

    return result;
  }

  // --- Compatibility methods ---

  async delegate(
    role: Role,
    task: string,
    cwd: string,
    timeoutSeconds?: number | undefined,
    maxDurationSeconds?: number | undefined
  ): Promise<DelegationResult> {
    const workspace = resolveAllowedWorkspace(cwd, this.config.allowedRoots);
    let worker = this.implicitWorkers.get(role);
    if (worker && worker.status().cwd !== workspace) {
      if (worker.status().state === "busy" || worker.status().queueDepth > 0) {
        throw new Error(`${role} is active in ${worker.status().cwd}; stop or reset it before changing cwd`);
      }
      await worker.stop();
      this.implicitWorkers.delete(role);
      worker = undefined;
    }
    if (!worker) {
      worker = new AgyWorker({
        role,
        cwd: workspace,
        executable: this.config.executable,
        prefixArgs: this.prefixArgs,
        mode: role === "tester" ? "plan" : "accept-edits",
        ...(this.config.model ? { model: this.config.model } : {}),
        ...(this.config.effort ? { effort: this.config.effort } : {}),
        ...(this.config.agent ? { agent: this.config.agent } : {}),
        sandbox: this.config.sandbox,
        dangerouslySkipPermissions: this.config.dangerouslySkipPermissions,
        defaultTimeoutMs: this.config.defaultTimeoutMs,
        ...(this.config.maxTurnTimeoutMs ? { defaultMaxTurnMs: this.config.maxTurnTimeoutMs } : {}),
        ...(this.config.maxSteps ? { defaultMaxSteps: this.config.maxSteps } : {}),
        ...(this.config.maxTurnTokens ? { defaultMaxTokens: this.config.maxTurnTokens } : {}),
        maxStderrBytes: this.config.maxStderrBytes
      });
      this.implicitWorkers.set(role, worker);
    }
    const timeoutMs = timeoutSeconds === undefined ? undefined : timeoutSeconds * 1_000;
    const maxDurationMs = maxDurationSeconds === undefined ? undefined : maxDurationSeconds * 1_000;
    return timeoutMs === undefined && maxDurationMs === undefined
      ? worker.delegate(task)
      : worker.delegate(task, {
          ...(timeoutMs === undefined ? {} : { inactivityTimeoutMs: timeoutMs }),
          ...(maxDurationMs === undefined ? {} : { maxDurationMs })
        });
  }

  status(role?: Role | undefined): WorkerStatus[] {
    const roles: Role[] = role ? [role] : ["implementer", "tester"];
    return roles.map((item) => {
      const worker = this.implicitWorkers.get(item);
      if (worker) return worker.status();
      return {
        role: item,
        state: "stopped",
        cwd: "",
        queueDepth: 0,
        completedTurns: 0,
        recentStderr: ""
      };
    });
  }

  async stop(role?: Role | undefined): Promise<void> {
    const selected = role ? [role] : (["implementer", "tester"] as Role[]);
    await Promise.all(selected.map(async (item) => this.implicitWorkers.get(item)?.stop()));
    if (!role) {
      for (const job of this.jobs.values()) {
        if (job.deadlineTimer) clearTimeout(job.deadlineTimer);
        if (job.gracefulFinishTimer) clearTimeout(job.gracefulFinishTimer);
      }
      await Promise.all(Array.from(this.explicitWorkers.values()).map((w) => w.worker.stop()));
      if (this.dashboardServer) {
        await this.dashboardServer.stop();
      }
    }
  }

  async reset(role?: Role | undefined): Promise<void> {
    const selected = role ? [role] : (["implementer", "tester"] as Role[]);
    await Promise.all(selected.map(async (item) => {
      const worker = this.implicitWorkers.get(item);
      if (worker) await worker.stop();
      this.implicitWorkers.delete(item);
    }));
  }

  private handleRawWorkerEvent(workerId: string, raw: AgyWorkerRawEvent): void {
    const worker = this.explicitWorkers.get(workerId);
    const activeJob = worker?.activeJob;
    const jobId = activeJob?.jobId;
    if (activeJob) activeJob.lastActivityAt = new Date().toISOString();

    if (raw.type === "init") {
      this.eventStore.recordEvent({
        eventType: "init",
        workerId,
        ...(jobId ? { jobId } : {}),
        data: {
          conversation_id: raw.conversationId,
          init: raw.init
        }
      });
      if (activeJob && raw.conversationId) {
        activeJob.conversationId = raw.conversationId;
      }
    } else if (raw.type === "step") {
      const stepUpdate = raw.stepUpdate;
      if (activeJob && stepUpdate) {
        activeJob.stepEvents.push(stepUpdate);
        const stateStr = String(stepUpdate.state || "");
        const stepTypeStr = String(stepUpdate.step_type || "");
        const textDeltaStr = String(stepUpdate.text_delta || "");
        activeJob.lastProgress = [stepTypeStr, stateStr, textDeltaStr].filter(Boolean).join(": ").slice(0, 512);

        if (
          stateStr.toUpperCase() === "DENIED" ||
          stepTypeStr.toLowerCase().includes("permission") ||
          textDeltaStr.toLowerCase().includes("permission denied")
        ) {
          const norm = normalizeDeniedAction(textDeltaStr || stateStr);
          if (norm && !activeJob.deniedActions.includes(norm)) {
            activeJob.deniedActions.push(norm);
          }
        }
      }
      this.eventStore.recordEvent({
        eventType: "step",
        workerId,
        ...(jobId ? { jobId } : {}),
        data: stepUpdate ? { ...stepUpdate } : {}
      });
    } else if (raw.type === "result") {
      if (activeJob) {
        if (raw.result.conversation_id) {
          activeJob.conversationId = raw.result.conversation_id;
        }
        const deniedList = raw.result.denied_actions;
        if (Array.isArray(deniedList)) {
          for (const item of deniedList) {
            const norm = normalizeDeniedAction(item);
            if (norm && !activeJob.deniedActions.includes(norm)) {
              activeJob.deniedActions.push(norm);
            }
          }
        }
      }
      this.eventStore.recordEvent({
        eventType: "result",
        workerId,
        ...(jobId ? { jobId } : {}),
        data: { ...raw.result }
      });
    } else if (raw.type === "stderr") {
      this.eventStore.recordEvent({
        eventType: "stderr",
        workerId,
        ...(jobId ? { jobId } : {}),
        data: { stderr: raw.text }
      });
    }
  }

  private expireQueuedJob(worker: ExplicitWorkerInternal, job: JobRecord): void {
    if (job.deadlineTimer) clearTimeout(job.deadlineTimer);
    if (job.gracefulFinishTimer) clearTimeout(job.gracefulFinishTimer);
    job.status = "failed";
    job.finishedAt = new Date().toISOString();
    job.error = "Total job deadline exceeded in queue; turn was not started";
    worker.queue = worker.queue.filter(item => item !== job);
    this.eventStore.recordEvent({ eventType: "lifecycle", workerId: worker.workerId, jobId: job.jobId, data: { lifecycle: "failed", finished_at: job.finishedAt, error: job.error } });
  }

  private processWorkerQueue(worker: ExplicitWorkerInternal): void {
    if (worker.status === "closed") return;
    if (worker.activeJob) return;
    if (worker.queue.length === 0) {
      worker.status = "idle";
      return;
    }

    const nextJob = worker.queue.shift()!;
    if (nextJob.deadlineAt && Date.parse(nextJob.deadlineAt) <= Date.now() && nextJob.status === "queued") {
      this.expireQueuedJob(worker, nextJob);
      this.processWorkerQueue(worker);
      return;
    }
    if (nextJob.status === "canceled") {
      this.processWorkerQueue(worker);
      return;
    }

    worker.activeJob = nextJob;
    worker.status = "busy";
    nextJob.status = "running";
    nextJob.startedAt = new Date().toISOString();
    nextJob.lastActivityAt = nextJob.startedAt;

    this.eventStore.recordEvent({
      eventType: "lifecycle",
      workerId: worker.workerId,
      jobId: nextJob.jobId,
      data: {
        lifecycle: "started",
        started_at: nextJob.startedAt
      }
    });

    (async () => {
      try {
        const result = nextJob.timeoutMs === undefined && nextJob.maxDurationMs === undefined
          ? await worker.worker.delegate(nextJob.effectivePrompt)
          : await worker.worker.delegate(nextJob.effectivePrompt, {
              ...(nextJob.timeoutMs === undefined ? {} : { inactivityTimeoutMs: nextJob.timeoutMs }),
              ...(nextJob.maxDurationMs === undefined ? {} : { maxDurationMs: nextJob.maxDurationMs })
            });
        if (nextJob.status !== "canceled") {
          nextJob.status = "succeeded";
          nextJob.finishedAt = new Date().toISOString();
          nextJob.durationSeconds = result.durationSeconds;
          nextJob.cliDurationSeconds = result.cliDurationSeconds;
          nextJob.usage = result.usage;
          nextJob.cumulativeUsage = result.cumulativeUsage;
          nextJob.result = result.response;
          nextJob.conversationId = result.conversationId;

          this.eventStore.recordEvent({
            eventType: "lifecycle",
            workerId: worker.workerId,
            jobId: nextJob.jobId,
            data: {
              lifecycle: "succeeded",
              status: "SUCCESS",
              finished_at: nextJob.finishedAt,
              duration_seconds: nextJob.durationSeconds,
              cli_duration_seconds: nextJob.cliDurationSeconds,
              usage: nextJob.usage,
              cumulative_usage: nextJob.cumulativeUsage,
              response: nextJob.result,
              conversation_id: nextJob.conversationId,
              denied_actions: [...nextJob.deniedActions]
            }
          });
        }
      } catch (err) {
        if (nextJob.status !== "canceled") {
          nextJob.status = "failed";
          nextJob.finishedAt = new Date().toISOString();
          nextJob.durationSeconds = this.elapsedSeconds(nextJob.startedAt, nextJob.finishedAt);
          nextJob.error = err instanceof Error ? err.message : String(err);
          if (err instanceof AgyTimeoutError) nextJob.timeoutKind = err.timeoutKind;
          if (err instanceof AgyBudgetError) nextJob.budgetKind = err.budgetKind;

          this.eventStore.recordEvent({
            eventType: "lifecycle",
            workerId: worker.workerId,
            jobId: nextJob.jobId,
            data: {
              lifecycle: "failed",
              status: "ERROR",
              finished_at: nextJob.finishedAt,
              duration_seconds: nextJob.durationSeconds,
              error: nextJob.error,
              ...(nextJob.timeoutKind ? { timeout_kind: nextJob.timeoutKind } : {}),
              ...(nextJob.budgetKind ? { budget_kind: nextJob.budgetKind } : {}),
              denied_actions: [...nextJob.deniedActions]
            }
          });
        }
      } finally {
        if (nextJob.deadlineTimer) clearTimeout(nextJob.deadlineTimer);
        if (nextJob.gracefulFinishTimer) clearTimeout(nextJob.gracefulFinishTimer);
        worker.activeJob = undefined;
        if (worker.status !== "closed") {
          worker.status = worker.queue.length > 0 ? "busy" : "idle";
        }
        this.processWorkerQueue(worker);
      }
    })();
  }
}
