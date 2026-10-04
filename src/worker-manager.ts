import path from "node:path";
import { normalizeDeniedAction, type AgyTerminalResult, type AgyUsage, type DelegationResult } from "./agy-protocol.js";
import { AgyWorker, type AgyWorkerRawEvent, type WorkerStatus } from "./agy-worker.js";
import { resolveAllowedWorkspace, type BridgeConfig, type Role } from "./config.js";
import { boundStepEvent, boundText, EventStore, type JobHistorySummary, type NormalizedEvent } from "./event-store.js";
import { ModelCatalog, type ListModelsResult } from "./model-catalog.js";

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "canceled";

export interface CreateWorkerOptions {
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
  constraints?: string | undefined;
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
  status: JobStatus;
  createdAt: string;
  startedAt?: string | undefined;
  finishedAt?: string | undefined;
  durationSeconds?: number | undefined;
  usage?: AgyUsage | undefined;
  result?: string | undefined;
  error?: string | undefined;
  conversationId?: string | undefined;
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
  result?: string | undefined;
  error?: string | undefined;
}

export interface InspectTaskResult {
  job_id: string;
  worker_id: string;
  role: Role;
  workspace: string;
  status: JobStatus;
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
}

export class WorkerManager {
  private readonly implicitWorkers = new Map<Role, AgyWorker>();
  private readonly explicitWorkers = new Map<string, ExplicitWorkerInternal>();
  private readonly jobs = new Map<string, JobRecord>();
  private readonly eventStore: EventStore;
  private readonly modelCatalog: ModelCatalog;
  private workerCounter = 0;
  private jobCounter = 0;

  constructor(
    private readonly config: BridgeConfig,
    private readonly prefixArgs: string[] = config.baseArgs ?? [],
    options?: { runsDir?: string | undefined }
  ) {
    const runsDir = options?.runsDir || config.runsDir || path.join(process.cwd(), ".antigravity-bridge", "runs");
    this.eventStore = new EventStore({ runsDir, maxFieldBytes: config.maxStderrBytes });
    this.modelCatalog = new ModelCatalog({
      executable: config.executable,
      prefixArgs: this.prefixArgs
    });
  }

  async listModels(options?: { refresh?: boolean | undefined }): Promise<ListModelsResult> {
    return this.modelCatalog.listModels(options);
  }

  async createWorker(options: CreateWorkerOptions): Promise<ExplicitWorkerInfo> {
    const workspace = resolveAllowedWorkspace(options.workspace, this.config.allowedRoots);
    this.workerCounter += 1;
    const workerId = `worker-${options.role}-${Date.now()}-${this.workerCounter}`;

    const agyWorker = new AgyWorker({
      role: options.role,
      cwd: workspace,
      executable: this.config.executable,
      prefixArgs: this.prefixArgs,
      mode: options.role === "tester" ? "plan" : "accept-edits",
      model: options.model ?? this.config.model,
      effort: options.effort ?? this.config.effort,
      ...(this.config.agent ? { agent: this.config.agent } : {}),
      sandbox: this.config.sandbox,
      dangerouslySkipPermissions: this.config.dangerouslySkipPermissions,
      defaultTimeoutMs: this.config.defaultTimeoutMs,
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
      effort: options.effort ?? this.config.effort,
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
      constraints: options.constraints,
      status: "idle",
      createdAt: info.createdAt
    };
  }

  async dispatchTask(workerId: string, brief: string): Promise<{ jobId: string; workerId: string; status: JobStatus }> {
    const worker = this.explicitWorkers.get(workerId);
    if (!worker) {
      throw new Error(`Worker not found: ${workerId}`);
    }
    if (worker.status === "closed") {
      throw new Error(`Worker is closed: ${workerId}`);
    }

    this.jobCounter += 1;
    const jobId = `job-${Date.now()}-${this.jobCounter}`;

    const effectivePrompt = worker.constraints
      ? `[Constraints]\n${worker.constraints}\n\n[Task]\n${brief}`
      : brief;

    const job: JobRecord = {
      jobId,
      workerId,
      role: worker.role,
      workspace: worker.workspace,
      brief,
      effectivePrompt,
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
        created_at: job.createdAt
      }
    });

    this.processWorkerQueue(worker);

    return {
      jobId,
      workerId,
      status: job.status
    };
  }

  async sendFollowup(workerId: string, finding: string): Promise<{ jobId: string; workerId: string; status: JobStatus }> {
    return this.dispatchTask(workerId, finding);
  }

  async waitTask(jobId: string, options?: { waitMs?: number | undefined; afterCursor?: number | undefined }): Promise<WaitTaskResult> {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new Error(`Job not found: ${jobId}`);
    }

    const isTerminal = () => job.status === "succeeded" || job.status === "failed" || job.status === "canceled";
    const afterCursor = options?.afterCursor;
    const MAX_WAIT_MS = 30_000;
    const boundedWaitMs = Math.min(Math.max(options?.waitMs ?? 5_000, 0), MAX_WAIT_MS);

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

    const eventsRes = this.eventStore.getEvents({ jobId, afterCursor });
    return {
      job_id: job.jobId,
      worker_id: job.workerId,
      status: job.status,
      terminal: isTerminal(),
      cursor: eventsRes.latest_cursor,
      events: eventsRes.events,
      ...(job.result !== undefined ? { result: job.result } : {}),
      ...(job.error !== undefined ? { error: job.error } : {})
    };
  }

  inspectTask(jobId: string, options?: { stepOffset?: number | undefined; stepLimit?: number | undefined }): InspectTaskResult {
    const job = this.jobs.get(jobId);
    if (!job) {
      const persisted = this.eventStore.readDiskJob(jobId, options);
      if (persisted) {
        return persisted;
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

    return {
      job_id: job.jobId,
      worker_id: job.workerId,
      role: job.role,
      workspace: job.workspace,
      status: job.status,
      brief: boundText(job.brief, 8_192) ?? "",
      effective_prompt: boundText(job.effectivePrompt, 16_384) ?? "",
      created_at: job.createdAt,
      ...(job.startedAt ? { started_at: job.startedAt } : {}),
      ...(job.finishedAt ? { finished_at: job.finishedAt } : {}),
      ...(job.durationSeconds !== undefined ? { duration_seconds: job.durationSeconds } : {}),
      ...(job.conversationId ? { conversation_id: job.conversationId } : {}),
      total_steps: totalSteps,
      step_offset: offset,
      step_limit: limit,
      has_more_steps: hasMoreSteps,
      step_events: boundedSteps,
      total_denied_actions: totalDenied,
      denied_actions: slicedDenied,
      has_more_denied_actions: hasMoreDenied,
      ...(job.usage ? { usage: job.usage } : {}),
      ...(job.result !== undefined ? { result: boundText(job.result, 32_768) } : {}),
      ...(job.error !== undefined ? { error: boundText(job.error, 16_384) } : {})
    };
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

    if (job.status === "succeeded" || job.status === "failed" || job.status === "canceled") {
      return { jobId, status: job.status, active: false };
    }

    const worker = this.explicitWorkers.get(job.workerId);
    const isActive = worker?.activeJob?.jobId === jobId;

    job.status = "canceled";
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
        ...(job.usage ? { usage: job.usage } : {}),
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

  // --- Compatibility methods ---

  async delegate(role: Role, task: string, cwd: string, timeoutSeconds?: number | undefined): Promise<DelegationResult> {
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
        maxStderrBytes: this.config.maxStderrBytes
      });
      this.implicitWorkers.set(role, worker);
    }
    const timeoutMs = timeoutSeconds === undefined ? undefined : timeoutSeconds * 1_000;
    return timeoutMs === undefined ? worker.delegate(task) : worker.delegate(task, timeoutMs);
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
      await Promise.all(Array.from(this.explicitWorkers.values()).map((w) => w.worker.stop()));
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

  private processWorkerQueue(worker: ExplicitWorkerInternal): void {
    if (worker.status === "closed") return;
    if (worker.activeJob) return;
    if (worker.queue.length === 0) {
      worker.status = "idle";
      return;
    }

    const nextJob = worker.queue.shift()!;
    if (nextJob.status === "canceled") {
      this.processWorkerQueue(worker);
      return;
    }

    worker.activeJob = nextJob;
    worker.status = "busy";
    nextJob.status = "running";
    nextJob.startedAt = new Date().toISOString();

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
        const result = await worker.worker.delegate(nextJob.effectivePrompt);
        if (nextJob.status !== "canceled") {
          nextJob.status = "succeeded";
          nextJob.finishedAt = new Date().toISOString();
          nextJob.durationSeconds = result.durationSeconds;
          nextJob.usage = result.usage;
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
              usage: nextJob.usage,
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
          nextJob.error = err instanceof Error ? err.message : String(err);

          this.eventStore.recordEvent({
            eventType: "lifecycle",
            workerId: worker.workerId,
            jobId: nextJob.jobId,
            data: {
              lifecycle: "failed",
              status: "ERROR",
              finished_at: nextJob.finishedAt,
              error: nextJob.error,
              denied_actions: [...nextJob.deniedActions]
            }
          });
        }
      } finally {
        worker.activeJob = undefined;
        if (worker.status !== "closed") {
          worker.status = worker.queue.length > 0 ? "busy" : "idle";
        }
        this.processWorkerQueue(worker);
      }
    })();
  }
}
