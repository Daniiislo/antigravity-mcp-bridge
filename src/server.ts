import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { Role } from "./config.js";
import { WorkerManager } from "./worker-manager.js";

const roleSchema = z.enum(["implementer", "tester"]);
const optionalRoleSchema = roleSchema.optional().describe("Omit to target both roles");
const jobStatusSchema = z.enum(["queued", "running", "succeeded", "failed", "canceled"]);

function success(data: unknown, summary: string) {
  const structuredContent = JSON.parse(JSON.stringify(data)) as Record<string, unknown>;
  return { content: [{ type: "text" as const, text: summary }], structuredContent };
}

function failure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: "text" as const, text: message }],
    structuredContent: { error: message },
    isError: true
  };
}

export function createServer(manager: WorkerManager): McpServer {
  const server = new McpServer({ name: "antigravity-mcp-bridge", version: "0.1.0" });

  // --- Controller Tools ---

  server.registerTool("list_models", {
    title: "List Antigravity Models",
    description: "List supported Antigravity models with cache metadata.",
    inputSchema: z.object({
      refresh: z.boolean().optional().describe("Bypass cache and query agy CLI directly")
    })
  }, async ({ refresh }) => {
    try {
      const result = await manager.listModels({ refresh });
      return success(result, `Found ${result.models.length} models (cached=${result.cached}).`);
    } catch (error) {
      return failure(error);
    }
  });

  server.registerTool("create_worker", {
    title: "Create Antigravity Worker",
    description: "Create an isolated Antigravity worker process with role, workspace, and optional constraints.",
    inputSchema: z.object({
      role: roleSchema.describe("Implementer starts in accept-edits mode; tester starts in plan mode"),
      workspace: z.string().min(1).describe("Workspace directory inside AGY_ALLOWED_ROOTS"),
      model: z.string().optional().describe("Optional model override"),
      effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional().describe("Optional effort override"),
      constraints: z.string().optional().describe("Optional constraints prepended to all tasks for this worker")
    })
  }, async ({ role, workspace, model, effort, constraints }) => {
    try {
      const result = await manager.createWorker({ role, workspace, model, effort, constraints });
      const dashboardUrl = await manager.getDashboardUrl({ workerId: result.workerId });
      const enriched = {
        ...result,
        ...(dashboardUrl ? { dashboard_url: dashboardUrl } : {})
      };
      return success(enriched, `Created worker ${result.workerId} (${result.role}) in ${result.workspace}.`);
    } catch (error) {
      return failure(error);
    }
  });

  server.registerTool("dispatch_task", {
    title: "Dispatch Task",
    description: "Enqueue a task on a worker and return immediately with a job ID.",
    inputSchema: z.object({
      worker_id: z.string().min(1).describe("Target worker ID"),
      brief: z.string().min(1).describe("Task brief to enqueue")
    })
  }, async ({ worker_id, brief }) => {
    try {
      const result = await manager.dispatchTask(worker_id, brief);
      const dashboardUrl = await manager.getDashboardUrl({ workerId: result.workerId, jobId: result.jobId });
      const enriched = {
        ...result,
        ...(dashboardUrl ? { dashboard_url: dashboardUrl } : {})
      };
      return success(enriched, `Dispatched task ${result.jobId} to worker ${result.workerId} (status: ${result.status}).`);
    } catch (error) {
      return failure(error);
    }
  });

  server.registerTool("wait_task", {
    title: "Wait on Task",
    description: "Bounded wait for a task to reach terminal state (completion, failure, or cancellation). OMIT after_cursor so the call blocks until the job finishes or reaches wait_ms without burning LLM turns on intermediate events. Calling wait_task without after_cursor is token-efficient and returns terminal=true when completed.",
    inputSchema: z.object({
      job_id: z.string().min(1).describe("Job ID to wait for"),
      wait_ms: z.number().int().min(0).max(300_000).optional().describe("Bounded wait time in milliseconds (default 30000, max 300000). Set to 60000-120000 for long tasks."),
      after_cursor: z.number().int().min(0).optional().describe("Deprecated for LLMs: Optional event cursor. DO NOT poll with this in agent loops as it causes rapid token exhaustion; omit this and wait for terminal state.")
    })
  }, async ({ job_id, wait_ms, after_cursor }) => {
    try {
      const result = await manager.waitTask(job_id, { waitMs: wait_ms, afterCursor: after_cursor });
      return success(result, `Job ${result.job_id} status: ${result.status} (terminal: ${result.terminal}).`);
    } catch (error) {
      return failure(error);
    }
  });

  server.registerTool("send_followup", {
    title: "Send Followup",
    description: "Enqueue related work in the same worker conversation and return immediately.",
    inputSchema: z.object({
      worker_id: z.string().min(1).describe("Target worker ID"),
      finding: z.string().min(1).describe("Follow-up finding or task in the existing conversation")
    })
  }, async ({ worker_id, finding }) => {
    try {
      const result = await manager.sendFollowup(worker_id, finding);
      return success(result, `Enqueued follow-up ${result.jobId} on worker ${result.workerId}.`);
    } catch (error) {
      return failure(error);
    }
  });

  server.registerTool("inspect_task", {
    title: "Inspect Task",
    description: "Inspect task metadata, step events, denied actions, usage, and result/error with bounded step pagination.",
    inputSchema: z.object({
      job_id: z.string().min(1).describe("Job ID to inspect"),
      step_offset: z.number().int().min(0).optional().describe("0-based offset into step events (default 0)"),
      step_limit: z.number().int().min(1).max(100).optional().describe("Maximum step events to return (default 20, max 100)")
    })
  }, async ({ job_id, step_offset, step_limit }) => {
    try {
      const result = manager.inspectTask(job_id, { stepOffset: step_offset, stepLimit: step_limit });
      const dashboardUrl = await manager.getDashboardUrl({ workerId: result.worker_id, jobId: result.job_id });
      const enriched = {
        ...result,
        ...(dashboardUrl ? { dashboard_url: dashboardUrl } : {})
      };
      const stepsNote = result.has_more_steps
        ? ` (${result.step_events.length}/${result.total_steps} steps shown; use step_offset or agy_events for more)`
        : ` (${result.step_events.length} steps)`;
      return success(enriched, `Inspected job ${result.job_id}: status ${result.status}${stepsNote}.`);
    } catch (error) {
      return failure(error);
    }
  });

  server.registerTool("cancel_task", {
    title: "Cancel Task",
    description: "Cancel a task. Canceling an active task terminates the worker and resets its conversation. If the task is already terminal, returns its current status without mutating.",
    inputSchema: z.object({
      job_id: z.string().min(1).describe("Job ID to cancel")
    })
  }, async ({ job_id }) => {
    try {
      const result = await manager.cancelTask(job_id);
      const summary = result.status === "canceled"
        ? `Job ${result.jobId} canceled (active=${result.active}).`
        : `Job ${result.jobId} was already terminal with status ${result.status} (active=false).`;
      return success(result, summary);
    } catch (error) {
      return failure(error);
    }
  });

  server.registerTool("close_worker", {
    title: "Close Worker",
    description: "Cancel all outstanding work, stop the process, and close the worker.",
    inputSchema: z.object({
      worker_id: z.string().min(1).describe("Worker ID to close")
    })
  }, async ({ worker_id }) => {
    try {
      const result = await manager.closeWorker(worker_id);
      return success(result, `Closed worker ${result.workerId}.`);
    } catch (error) {
      return failure(error);
    }
  });

  server.registerTool("agy_events", {
    title: "Poll Antigravity Events",
    description: "Poll normalized events with cursor, worker, and job filtering.",
    inputSchema: z.object({
      worker_id: z.string().optional().describe("Filter events by worker ID"),
      job_id: z.string().optional().describe("Filter events by job ID"),
      after_cursor: z.number().int().min(0).optional().describe("Filter events with cursor > after_cursor"),
      limit: z.number().int().min(1).max(500).optional().describe("Maximum events to return (default 50)")
    })
  }, ({ worker_id, job_id, after_cursor, limit }) => {
    try {
      const result = manager.getEvents({ workerId: worker_id, jobId: job_id, afterCursor: after_cursor, limit });
      return success(result, `Retrieved ${result.events.length} events (latest cursor: ${result.latest_cursor}).`);
    } catch (error) {
      return failure(error);
    }
  });

  server.registerTool("agy_history", {
    title: "Antigravity Task History",
    description: "List newest jobs with terminal summaries across the server lifetime and restarts.",
    inputSchema: z.object({
      worker_id: z.string().optional().describe("Filter history by worker ID"),
      status: jobStatusSchema.optional().describe("Filter history by job status"),
      limit: z.number().int().min(1).max(100).optional().describe("Maximum jobs to return (default 20)")
    })
  }, async ({ worker_id, status, limit }) => {
    try {
      const result = await manager.getHistory({ workerId: worker_id, status, limit });
      return success(result, `Retrieved ${result.jobs.length} jobs in history.`);
    } catch (error) {
      return failure(error);
    }
  });

  server.registerTool("delete_task", {
    title: "Delete Task History",
    description: "Delete a completed task run and its event history from disk. Fails if the task is currently active (queued or running).",
    inputSchema: z.object({
      job_id: z.string().min(1).describe("Job ID of the finished task to delete")
    })
  }, async ({ job_id }) => {
    try {
      const result = await manager.deleteJob(job_id);
      return success(result, `Deleted task ${result.jobId} from history.`);
    } catch (error) {
      return failure(error);
    }
  });

  server.registerTool("clean_history", {
    title: "Clean Task History",
    description: "Prune or clean historical task runs by workspace/project, status, age, or keeping the newest N runs. Active tasks are automatically protected.",
    inputSchema: z.object({
      job_id: z.string().optional().describe("Clean a specific job ID"),
      workspace: z.string().optional().describe("Filter cleanup to a specific workspace directory or project name"),
      terminal_only: z.boolean().optional().describe("If true, only deletes completed jobs (succeeded, failed, canceled). Defaults to true if neither status nor all are specified."),
      status: z.union([jobStatusSchema, z.array(jobStatusSchema)]).optional().describe("Filter cleanup to specific statuses (e.g. failed, canceled)"),
      older_than_days: z.number().min(0).optional().describe("Only clean tasks older than this many days"),
      keep: z.number().int().min(0).optional().describe("Preserve the newest N tasks matching the criteria"),
      all: z.boolean().optional().describe("If true, deletes all historical tasks matching filters without requiring terminal_only")
    })
  }, async ({ job_id, workspace, terminal_only, status, older_than_days, keep, all }) => {
    try {
      const isTerminalOnly = terminal_only !== undefined ? terminal_only : (all ? false : true);
      const result = await manager.cleanJobs({
        jobId: job_id,
        workspace,
        terminalOnly: isTerminalOnly,
        status: status as string | string[] | undefined,
        olderThanDays: older_than_days,
        keep
      });
      return success(result, `Cleaned ${result.deletedCount} tasks from history.`);
    } catch (error) {
      return failure(error);
    }
  });

  server.registerTool("open_dashboard", {
    title: "Open Antigravity Dashboard",
    description: "Get the local dashboard URL to inspect workers, jobs, conversations, and events.",
    inputSchema: z.object({
      worker_id: z.string().optional().describe("Optional worker ID to filter the dashboard"),
      job_id: z.string().optional().describe("Optional job ID to focus on in the dashboard"),
      workspace: z.string().optional().describe("Optional workspace path or project name to filter the dashboard")
    })
  }, async ({ worker_id, job_id, workspace }) => {
    try {
      const dashboardUrl = await manager.getDashboardUrl({ workerId: worker_id, jobId: job_id, workspace });
      if (!dashboardUrl) {
        throw new Error("Dashboard is disabled via configuration (AGY_DASHBOARD_ENABLED=false)");
      }
      const structuredContent: Record<string, unknown> = {
        dashboard_url: dashboardUrl,
        read_only: true,
        ...(worker_id ? { worker_id } : {}),
        ...(job_id ? { job_id } : {}),
        ...(workspace ? { workspace } : {})
      };
      return {
        content: [
          {
            type: "text" as const,
            text: `Antigravity dashboard available at ${dashboardUrl} (read-only).`
          },
          {
            type: "resource_link" as const,
            uri: dashboardUrl,
            name: "antigravity-dashboard",
            title: "Antigravity Dashboard"
          }
        ],
        structuredContent
      };
    } catch (error) {
      return failure(error);
    }
  });

  // --- Compatibility Tools ---

  server.registerTool("agy_delegate", {
    title: "Delegate to Antigravity",
    description: "Send one bounded task to a persistent Antigravity implementer or tester conversation.",
    inputSchema: z.object({
      role: roleSchema.describe("Implementer may edit; tester is started in plan mode"),
      task: z.string().min(1).describe("Decision-complete task or review brief"),
      cwd: z.string().min(1).describe("Existing workspace directory inside AGY_ALLOWED_ROOTS"),
      timeoutSeconds: z.number().int().positive().max(86_400).optional()
    })
  }, async ({ role, task, cwd, timeoutSeconds }) => {
    try {
      const result = await manager.delegate(role, task, cwd, timeoutSeconds);
      return success(result, result.response);
    } catch (error) {
      return failure(error);
    }
  });

  server.registerTool("agy_status", {
    title: "Antigravity worker status",
    description: "Inspect worker state, conversation IDs, queued work, usage, and bounded stderr diagnostics.",
    inputSchema: z.object({ role: optionalRoleSchema })
  }, ({ role }) => {
    const statuses = manager.status(role as Role | undefined);
    return success({ workers: statuses }, JSON.stringify(statuses, null, 2));
  });

  server.registerTool("agy_stop", {
    title: "Stop Antigravity workers",
    description: "Stop one role or both while retaining in-memory status metadata.",
    inputSchema: z.object({ role: optionalRoleSchema })
  }, async ({ role }) => {
    try {
      await manager.stop(role as Role | undefined);
      return success({ stopped: role ?? "all" }, `Stopped ${role ?? "all Antigravity workers"}.`);
    } catch (error) {
      return failure(error);
    }
  });

  server.registerTool("agy_reset", {
    title: "Reset Antigravity conversations",
    description: "Stop and forget one role or both. The next delegation starts a fresh conversation.",
    inputSchema: z.object({ role: optionalRoleSchema })
  }, async ({ role }) => {
    try {
      await manager.reset(role as Role | undefined);
      return success({ reset: role ?? "all" }, `Reset ${role ?? "all Antigravity workers"}.`);
    } catch (error) {
      return failure(error);
    }
  });

  return server;
}
