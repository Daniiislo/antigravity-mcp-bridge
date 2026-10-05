import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { createMcpHandler, InMemoryTransport } from "@modelcontextprotocol/server";
import {
  CreateTaskResultV2Schema,
  GetTaskResultV2Schema,
  withTaskCapabilityV2
} from "@modelcontextprotocol/ext-tasks/core/v2";
import { createServer } from "../src/server.js";
import type { BridgeConfig } from "../src/config.js";
import { WorkerManager } from "../src/worker-manager.js";

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "fixtures", "fake-agy.mjs");

const tempDirs: string[] = [];
const managers: WorkerManager[] = [];

function makeManager(overrides: Partial<BridgeConfig> = {}) {
  const runsDir = mkdtempSync(path.join(tmpdir(), "agy-runs-"));
  tempDirs.push(runsDir);
  const config: BridgeConfig = {
    executable: process.execPath,
    allowedRoots: [process.cwd(), runsDir],
    sandbox: false,
    dangerouslySkipPermissions: false,
    defaultTimeoutMs: 5_000,
    maxStderrBytes: 4_096,
    ...overrides
  };
  const mgr = new WorkerManager(config, [fixture], { runsDir });
  managers.push(mgr);
  return { mgr, runsDir };
}

afterEach(async () => {
  for (const m of managers.splice(0)) await m.stop();
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("Controller API (Tasks 5-7)", () => {
  describe("create_worker", () => {
    it("creates an idle worker with role, workspace, and optional constraints", async () => {
      const { mgr } = makeManager();
      const worker = await mgr.createWorker({
        role: "implementer",
        workspace: process.cwd(),
        constraints: "Never run git commit"
      });

      expect(worker.workerId).toMatch(/^worker-implementer-/);
      expect(worker.role).toBe("implementer");
      expect(worker.workspace).toBe(process.cwd());
      expect(worker.hasConstraints).toBe(true);
      expect(worker).not.toHaveProperty("constraints");
      expect(worker.status).toBe("idle");
    });

    it("rejects workspace outside allowed roots", async () => {
      const { mgr } = makeManager();
      const outside = path.dirname(tmpdir());
      await expect(mgr.createWorker({
        role: "tester",
        workspace: outside
      })).rejects.toThrow(/outside allowed roots/i);
    });
  });

  describe("dispatch_task and wait_task", () => {
    it("dispatches immediately and returns job_id before completion, then wait_task resolves", async () => {
      const { mgr } = makeManager();
      const worker = await mgr.createWorker({
        role: "implementer",
        workspace: process.cwd(),
        constraints: "Rule: Be concise"
      });

      // DELAY:100:async-test makes fake-agy take 100ms
      const job = await mgr.dispatchTask(worker.workerId, "DELAY:100:async-test");
      expect(job.jobId).toMatch(/^job-/);
      expect(["queued", "running"]).toContain(job.status);

      const waited = await mgr.waitTask(job.jobId, { waitMs: 2_000 });
      expect(waited.terminal).toBe(true);
      expect(waited.status).toBe("succeeded");
      expect(waited).not.toHaveProperty("result");
      expect(waited).not.toHaveProperty("error");
      expect(mgr.inspectTask(job.jobId).result).toContain("reply:async-test:accept-edits");
    });

    it("prepends worker constraints to dispatched task prompt", async () => {
      const { mgr } = makeManager();
      const worker = await mgr.createWorker({
        role: "implementer",
        workspace: process.cwd(),
        constraints: "MUST NOT USE ANY"
      });

      const job = await mgr.dispatchTask(worker.workerId, "test prompt");
      const waited = await mgr.waitTask(job.jobId, { waitMs: 2_000 });
      expect(waited.terminal).toBe(true);

      const inspected = mgr.inspectTask(job.jobId, { includePrompt: true });
      expect(inspected.effective_prompt).toContain("MUST NOT USE ANY");
      expect(inspected.effective_prompt).toContain("test prompt");
    });

    it("wait_task returns immediately if job is already terminal", async () => {
      const { mgr } = makeManager();
      const worker = await mgr.createWorker({ role: "tester", workspace: process.cwd() });
      const job = await mgr.dispatchTask(worker.workerId, "quick");
      await mgr.waitTask(job.jobId, { waitMs: 2_000 });

      const start = Date.now();
      const immediate = await mgr.waitTask(job.jobId, { waitMs: 5_000 });
      expect(Date.now() - start).toBeLessThan(100);
      expect(immediate.terminal).toBe(true);
    });

    it("wait_task returns immediately if events newer than after_cursor exist", async () => {
      const { mgr } = makeManager();
      const worker = await mgr.createWorker({ role: "tester", workspace: process.cwd() });
      const job = await mgr.dispatchTask(worker.workerId, "test-cursor");
      const initial = await mgr.waitTask(job.jobId, { waitMs: 2_000 });
      expect(initial.cursor).toBeGreaterThan(0);

      const start = Date.now();
      const check = await mgr.waitTask(job.jobId, { waitMs: 5_000, afterCursor: 0 });
      expect(Date.now() - start).toBeLessThan(100);
      expect(check.events.length).toBeGreaterThan(0);
    });

    it("wait_task omits events by default when afterCursor is omitted to prevent context bloat and token exhaustion", async () => {
      const { mgr } = makeManager();
      const worker = await mgr.createWorker({ role: "tester", workspace: process.cwd() });
      const job = await mgr.dispatchTask(worker.workerId, "test-token-savings");
      const waited = await mgr.waitTask(job.jobId, { waitMs: 2_000 });

      expect(waited.terminal).toBe(true);
      expect(waited.cursor).toBeGreaterThan(0);
      expect(waited.events).toEqual([]);
    });

    it("wait_task falls back to persisted disk job if in-memory job is not found", async () => {
      const runsDir = mkdtempSync(path.join(tmpdir(), "wait-disk-"));
      tempDirs.push(runsDir);
      const config: BridgeConfig = {
        executable: process.execPath,
        allowedRoots: [process.cwd(), runsDir],
        sandbox: false,
        dangerouslySkipPermissions: false,
        defaultTimeoutMs: 5_000,
        maxStderrBytes: 4_096
      };
      const mgr1 = new WorkerManager(config, [fixture], { runsDir });
      managers.push(mgr1);

      const worker = await mgr1.createWorker({ role: "tester", workspace: process.cwd() });
      const job = await mgr1.dispatchTask(worker.workerId, "persisted-task");
      await mgr1.waitTask(job.jobId, { waitMs: 2_000 });

      // Create a fresh manager simulating restart (in-memory jobs empty)
      const mgr2 = new WorkerManager(config, [fixture], { runsDir });
      managers.push(mgr2);

      const waited = await mgr2.waitTask(job.jobId);
      expect(waited.terminal).toBe(true);
      expect(waited.job_id).toBe(job.jobId);
      expect(waited.status).toBe("succeeded");
      expect(waited.events).toEqual([]);
      expect(waited).not.toHaveProperty("result");
      expect(waited).not.toHaveProperty("error");
    });
  });

  describe("send_followup", () => {
    it("reuses the worker process and conversation for follow-up turns", async () => {
      const { mgr } = makeManager();
      const worker = await mgr.createWorker({ role: "implementer", workspace: process.cwd() });

      const firstJob = await mgr.dispatchTask(worker.workerId, "turn one");
      await mgr.waitTask(firstJob.jobId, { waitMs: 2_000 });

      const secondJob = await mgr.sendFollowup(worker.workerId, "turn two");
      const secondWaited = await mgr.waitTask(secondJob.jobId, { waitMs: 2_000 });

      const inspectFirst = mgr.inspectTask(firstJob.jobId);
      const inspectSecond = mgr.inspectTask(secondJob.jobId);

      expect(inspectSecond.conversation_id).toBeDefined();
      expect(inspectSecond.conversation_id).toBe(inspectFirst.conversation_id);
      expect(secondWaited).not.toHaveProperty("result");
      expect(inspectSecond.result).toContain("reply:turn two:accept-edits");
    });
  });

  describe("inspect_task", () => {
    it("returns metadata, step events, denied actions, usage, and result", async () => {
      const { mgr } = makeManager();
      const worker = await mgr.createWorker({ role: "implementer", workspace: process.cwd() });

      const job = await mgr.dispatchTask(worker.workerId, "DENIED");
      await mgr.waitTask(job.jobId, { waitMs: 2_000 });

      const inspected = mgr.inspectTask(job.jobId);
      expect(inspected.job_id).toBe(job.jobId);
      expect(inspected.worker_id).toBe(worker.workerId);
      expect(inspected.role).toBe("implementer");
      expect(inspected.workspace).toBe(process.cwd());
      expect(inspected.status).toBe("succeeded");
      expect(inspected).not.toHaveProperty("step_events");
      expect(inspected).not.toHaveProperty("brief");
      expect(inspected).not.toHaveProperty("effective_prompt");
      expect(inspected.caller_payload_chars).toBeGreaterThan(0);
      expect(inspected.response_char_budget).toBe(32_768);
      expect(inspected.denied_actions.length).toBeGreaterThan(0);
      expect(inspected.usage).toBeDefined();
      expect(inspected.result).toBe("handled denial");
    });

    it("reconstructs full useful inspection from disk NDJSON after server restart", async () => {
      const { mgr: mgr1, runsDir } = makeManager();
      const worker = await mgr1.createWorker({
        role: "implementer",
        workspace: process.cwd(),
        constraints: "Must test restart"
      });

      const job = await mgr1.dispatchTask(worker.workerId, "DENIED");
      await mgr1.waitTask(job.jobId, { waitMs: 2_000 });

      const beforeRestart = mgr1.inspectTask(job.jobId, { includePrompt: true, includeSteps: true });
      expect(beforeRestart.status).toBe("succeeded");
      expect(beforeRestart.step_events!.length).toBeGreaterThan(0);
      expect(beforeRestart.denied_actions.length).toBeGreaterThan(0);

      // Simulate server restart with a new WorkerManager instance on the same runsDir
      const config: BridgeConfig = {
        executable: process.execPath,
        allowedRoots: [process.cwd(), runsDir],
        sandbox: false,
        dangerouslySkipPermissions: false,
        defaultTimeoutMs: 5_000,
        maxStderrBytes: 4_096
      };
      const mgr2 = new WorkerManager(config, [fixture], { runsDir });
      managers.push(mgr2);

      const afterRestart = mgr2.inspectTask(job.jobId, { includePrompt: true, includeSteps: true });
      expect(afterRestart.job_id).toBe(job.jobId);
      expect(afterRestart.worker_id).toBe(worker.workerId);
      expect(afterRestart.role).toBe("implementer");
      expect(afterRestart.workspace).toBe(process.cwd());
      expect(afterRestart.status).toBe("succeeded");
      expect(afterRestart.brief).toBe("DENIED");
      expect(afterRestart.effective_prompt).toContain("Must test restart");
      expect(afterRestart.created_at).toBe(beforeRestart.created_at);
      expect(afterRestart.started_at).toBeDefined();
      expect(afterRestart.finished_at).toBeDefined();
      expect(afterRestart.duration_seconds).toBeDefined();
      expect(afterRestart.conversation_id).toBe(beforeRestart.conversation_id);
      expect(afterRestart.step_events!.length).toBe(beforeRestart.step_events!.length);
      expect(afterRestart.denied_actions).toEqual(beforeRestart.denied_actions);
      expect(afterRestart.usage).toBeDefined();
      expect(afterRestart.result).toBe("handled denial");
    });

    it("bounds inspect_task step_events by default to 20 and supports pagination", async () => {
      const { mgr } = makeManager();
      const worker = await mgr.createWorker({ role: "implementer", workspace: process.cwd() });

      const job = await mgr.dispatchTask(worker.workerId, "MANY_STEPS:25");
      await mgr.waitTask(job.jobId, { waitMs: 2_000 });

      // Default inspection should return max 20 steps
      const defaultInspect = mgr.inspectTask(job.jobId, { includeSteps: true });
      expect(defaultInspect.total_steps).toBe(25);
      expect(defaultInspect.step_offset).toBe(0);
      expect(defaultInspect.step_limit).toBe(20);
      expect(defaultInspect.has_more_steps).toBe(true);
      expect(defaultInspect.step_events!.length).toBe(20);
      expect(defaultInspect.step_events![0]?.text_delta).toBe("step 1");
      expect(defaultInspect.step_events![19]?.text_delta).toBe("step 20");

      // Paginate next page: offset 20, limit 10
      const page2 = mgr.inspectTask(job.jobId, { includeSteps: true, stepOffset: 20, stepLimit: 10 });
      expect(page2.total_steps).toBe(25);
      expect(page2.step_offset).toBe(20);
      expect(page2.step_limit).toBe(10);
      expect(page2.has_more_steps).toBe(false);
      expect(page2.step_events!.length).toBe(5);
      expect(page2.step_events![0]?.text_delta).toBe("step 21");
      expect(page2.step_events![4]?.text_delta).toBe("step 25");
    });

    it("preserves bounded inspection and pagination after server restart", async () => {
      const { mgr: mgr1, runsDir } = makeManager();
      const worker = await mgr1.createWorker({ role: "implementer", workspace: process.cwd() });

      const job = await mgr1.dispatchTask(worker.workerId, "MANY_STEPS:25");
      await mgr1.waitTask(job.jobId, { waitMs: 2_000 });

      // Create new manager on same runsDir (simulating restart)
      const config: BridgeConfig = {
        executable: process.execPath,
        allowedRoots: [process.cwd(), runsDir],
        sandbox: false,
        dangerouslySkipPermissions: false,
        defaultTimeoutMs: 5_000,
        maxStderrBytes: 4_096
      };
      const mgr2 = new WorkerManager(config, [fixture], { runsDir });
      managers.push(mgr2);

      const inspect1 = mgr2.inspectTask(job.jobId, { includeSteps: true });
      expect(inspect1.total_steps).toBe(25);
      expect(inspect1.step_offset).toBe(0);
      expect(inspect1.step_limit).toBe(20);
      expect(inspect1.has_more_steps).toBe(true);
      expect(inspect1.step_events!.length).toBe(20);

      const inspect2 = mgr2.inspectTask(job.jobId, { includeSteps: true, stepOffset: 20, stepLimit: 10 });
      expect(inspect2.total_steps).toBe(25);
      expect(inspect2.step_offset).toBe(20);
      expect(inspect2.has_more_steps).toBe(false);
      expect(inspect2.step_events!.length).toBe(5);
    });

    it("parses normalized denied actions from result records and persisted logs", async () => {
      const { mgr: mgr1, runsDir } = makeManager();
      const worker = await mgr1.createWorker({ role: "implementer", workspace: process.cwd() });

      const job = await mgr1.dispatchTask(worker.workerId, "RESULT_DENIED");
      const waited = await mgr1.waitTask(job.jobId, { waitMs: 2_000 });
      expect(waited.terminal).toBe(true);
      expect(waited.status).toBe("succeeded");

      const live = mgr1.inspectTask(job.jobId, { includePrompt: true, includeSteps: true });
      expect(live.status).toBe("succeeded");
      expect(live.total_denied_actions).toBe(1);
      expect(live.denied_actions).toEqual(["RunCommand (command)"]);
      expect(live.has_more_denied_actions).toBe(false);

      // Verify persisted inspection after server restart
      const config: BridgeConfig = {
        executable: process.execPath,
        allowedRoots: [process.cwd(), runsDir],
        sandbox: false,
        dangerouslySkipPermissions: false,
        defaultTimeoutMs: 5_000,
        maxStderrBytes: 4_096
      };
      const mgr2 = new WorkerManager(config, [fixture], { runsDir });
      managers.push(mgr2);

      const persisted = mgr2.inspectTask(job.jobId);
      expect(persisted.status).toBe("succeeded");
      expect(persisted.total_denied_actions).toBe(1);
      expect(persisted.denied_actions).toEqual(["RunCommand (command)"]);
      expect(persisted.has_more_denied_actions).toBe(false);
    });

    it("regression: SUCCESS result with empty response plus denied_actions fails truthfully and retains diagnostics in inspection", async () => {
      const { mgr: mgr1, runsDir } = makeManager();
      const worker = await mgr1.createWorker({ role: "implementer", workspace: process.cwd() });

      const job = await mgr1.dispatchTask(worker.workerId, "EMPTY_SUCCESS_WITH_DENIED");
      const waited = await mgr1.waitTask(job.jobId, { waitMs: 2_000 });
      expect(waited.terminal).toBe(true);
      expect(waited.status).toBe("failed");

      // Live inspection
      const live = mgr1.inspectTask(job.jobId);
      expect(live.status).toBe("failed");
      expect(live.error).toMatch(/empty response/i);
      expect(live.total_denied_actions).toBe(1);
      expect(live.denied_actions).toEqual(["RunCommand (command)"]);
      expect(live.has_more_denied_actions).toBe(false);

      // Verify persisted inspection after restart
      const config: BridgeConfig = {
        executable: process.execPath,
        allowedRoots: [process.cwd(), runsDir],
        sandbox: false,
        dangerouslySkipPermissions: false,
        defaultTimeoutMs: 5_000,
        maxStderrBytes: 4_096
      };
      const mgr2 = new WorkerManager(config, [fixture], { runsDir });
      managers.push(mgr2);

      const persisted = mgr2.inspectTask(job.jobId);
      expect(persisted.status).toBe("failed");
      expect(persisted.error).toBeDefined();
      expect(persisted.total_denied_actions).toBe(1);
      expect(persisted.denied_actions).toEqual(["RunCommand (command)"]);
      expect(persisted.has_more_denied_actions).toBe(false);
    });

    it("bounds many denied actions to 20 while exposing totals and has_more_denied_actions", async () => {
      const { mgr: mgr1, runsDir } = makeManager();
      const worker = await mgr1.createWorker({ role: "implementer", workspace: process.cwd() });

      const job = await mgr1.dispatchTask(worker.workerId, "MANY_DENIED");
      await mgr1.waitTask(job.jobId, { waitMs: 2_000 });

      const live = mgr1.inspectTask(job.jobId);
      expect(live.total_denied_actions).toBe(35);
      expect(live.denied_actions.length).toBe(20);
      expect(live.has_more_denied_actions).toBe(true);
      expect(live.denied_actions[0]).toBe("DeniedAction1 (command)");

      // Restart check
      const config: BridgeConfig = {
        executable: process.execPath,
        allowedRoots: [process.cwd(), runsDir],
        sandbox: false,
        dangerouslySkipPermissions: false,
        defaultTimeoutMs: 5_000,
        maxStderrBytes: 4_096
      };
      const mgr2 = new WorkerManager(config, [fixture], { runsDir });
      managers.push(mgr2);

      const persisted = mgr2.inspectTask(job.jobId);
      expect(persisted.total_denied_actions).toBe(35);
      expect(persisted.denied_actions.length).toBe(20);
      expect(persisted.has_more_denied_actions).toBe(true);
    });

    it("bounds oversized values and event fields to avoid multi-hundred-KB inspect responses", async () => {
      const { mgr: mgr1, runsDir } = makeManager();
      const worker = await mgr1.createWorker({
        role: "implementer",
        workspace: process.cwd(),
        constraints: "c".repeat(50_000)
      });

      const job = await mgr1.dispatchTask(worker.workerId, "OVERSIZED");
      await mgr1.waitTask(job.jobId, { waitMs: 2_000 });

      const live = mgr1.inspectTask(job.jobId, { includePrompt: true, includeSteps: true });
      // Result was 150_000 chars; must be bounded
      expect(live.result).toBeDefined();
      expect(live.result!.length).toBeLessThan(35_000);
      expect(live.result).toContain("[truncated]");

      // Effective prompt was > 50_000 chars; must be bounded
      expect(live.effective_prompt!.length).toBeLessThan(20_000);
      expect(live.effective_prompt).toContain("[truncated]");

      // Step event text_delta was 100_000 chars; must be bounded
      expect(live.step_events![0]?.text_delta).toBeDefined();
      expect(String(live.step_events![0]!.text_delta).length).toBeLessThan(6_000);
      expect(String(live.step_events![0]!.text_delta)).toContain("[truncated]");

      // Entire inspect response serialized size must be well under 100 KB
      const serialized = JSON.stringify(live);
      expect(serialized.length).toBeLessThan(32_768);

      // Verify underlying event remains accessible via cursor pagination
      const eventsRes = mgr1.getEvents({ jobId: job.jobId });
      expect(eventsRes.events.length).toBeGreaterThan(0);

      // Restart check
      const config: BridgeConfig = {
        executable: process.execPath,
        allowedRoots: [process.cwd(), runsDir],
        sandbox: false,
        dangerouslySkipPermissions: false,
        defaultTimeoutMs: 5_000,
        maxStderrBytes: 4_096
      };
      const mgr2 = new WorkerManager(config, [fixture], { runsDir });
      managers.push(mgr2);

      const persisted = mgr2.inspectTask(job.jobId);
      expect(persisted.result!.length).toBeLessThan(35_000);
      expect(persisted.result).toContain("[truncated]");
      expect(JSON.stringify(persisted).length).toBeLessThan(32_768);
    });

    it("caps wait_task timeout to 300,000ms max", async () => {
      const { mgr } = makeManager();
      const worker = await mgr.createWorker({ role: "implementer", workspace: process.cwd() });
      const job = await mgr.dispatchTask(worker.workerId, "DELAY:50:fast");

      // Pass excessive waitMs (e.g. 500_000)
      const waited = await mgr.waitTask(job.jobId, { waitMs: 500_000 });
      expect(waited.terminal).toBe(true);
      expect(waited.status).toBe("succeeded");
    });
  });

  describe("cancel_task", () => {
    it("queued cancellation does not kill worker process or invalidate conversation", async () => {
      const { mgr } = makeManager();
      const worker = await mgr.createWorker({ role: "implementer", workspace: process.cwd() });

      // First run a normal turn to establish conversation
      const j1 = await mgr.dispatchTask(worker.workerId, "first");
      await mgr.waitTask(j1.jobId, { waitMs: 2_000 });
      const firstConv = mgr.inspectTask(j1.jobId).conversation_id;

      // Start an active slow task, then queue a second task
      const jActive = await mgr.dispatchTask(worker.workerId, "DELAY:150:slow");
      const jQueued = await mgr.dispatchTask(worker.workerId, "will-cancel");

      // Cancel the queued one
      const cancelResult = await mgr.cancelTask(jQueued.jobId);
      expect(cancelResult.status).toBe("canceled");
      expect(cancelResult.active).toBe(false);

      await mgr.waitTask(jActive.jobId, { waitMs: 2_000 });
      const inspectQueued = mgr.inspectTask(jQueued.jobId);
      expect(inspectQueued.status).toBe("canceled");

      // Now run another task; conversation ID should still be the same!
      const jFollow = await mgr.sendFollowup(worker.workerId, "third");
      await mgr.waitTask(jFollow.jobId, { waitMs: 2_000 });
      const thirdConv = mgr.inspectTask(jFollow.jobId).conversation_id;
      expect(thirdConv).toBe(firstConv);
    });

    it("active cancellation terminates worker process and invalidates conversation", async () => {
      const { mgr } = makeManager();
      const worker = await mgr.createWorker({ role: "implementer", workspace: process.cwd() });

      const j1 = await mgr.dispatchTask(worker.workerId, "turn-1");
      await mgr.waitTask(j1.jobId, { waitMs: 2_000 });
      const firstConv = mgr.inspectTask(j1.jobId).conversation_id;

      // Start a slow task and cancel it while active
      const jSlow = await mgr.dispatchTask(worker.workerId, "DELAY:500:slow-active");
      await new Promise((resolve) => setTimeout(resolve, 30));

      const cancelResult = await mgr.cancelTask(jSlow.jobId);
      expect(cancelResult.status).toBe("canceled");
      expect(cancelResult.active).toBe(true);

      const inspectSlow = mgr.inspectTask(jSlow.jobId);
      expect(inspectSlow.status).toBe("canceled");

      // Next task on this worker must start a fresh process & new conversation ID
      const jFresh = await mgr.dispatchTask(worker.workerId, "fresh-start");
      await mgr.waitTask(jFresh.jobId, { waitMs: 2_000 });
      const freshConv = mgr.inspectTask(jFresh.jobId).conversation_id;
      expect(freshConv).not.toBe(firstConv);
    });

    it("returns actual terminal status truthfully without claiming cancellation on already-succeeded jobs", async () => {
      const { mgr } = makeManager();
      const worker = await mgr.createWorker({ role: "implementer", workspace: process.cwd() });

      const job = await mgr.dispatchTask(worker.workerId, "task-succeed");
      const waited = await mgr.waitTask(job.jobId, { waitMs: 2_000 });
      expect(waited.status).toBe("succeeded");

      const cancelResult = await mgr.cancelTask(job.jobId);
      expect(cancelResult.status).toBe("succeeded");
      expect(cancelResult.active).toBe(false);

      // Verify job was not mutated
      const inspected = mgr.inspectTask(job.jobId);
      expect(inspected.status).toBe("succeeded");
      expect(inspected.result).toBeDefined();
    });

    it("returns actual terminal status truthfully on already-failed jobs", async () => {
      const { mgr } = makeManager();
      const worker = await mgr.createWorker({ role: "implementer", workspace: process.cwd() });

      const job = await mgr.dispatchTask(worker.workerId, "ERROR");
      const waited = await mgr.waitTask(job.jobId, { waitMs: 2_000 });
      expect(waited.status).toBe("failed");

      const cancelResult = await mgr.cancelTask(job.jobId);
      expect(cancelResult.status).toBe("failed");
      expect(cancelResult.active).toBe(false);

      const inspected = mgr.inspectTask(job.jobId);
      expect(inspected.status).toBe("failed");
    });

    it("returns actual terminal status on persisted terminal jobs after server restart", async () => {
      const { mgr: mgr1, runsDir } = makeManager();
      const worker = await mgr1.createWorker({ role: "implementer", workspace: process.cwd() });

      const job = await mgr1.dispatchTask(worker.workerId, "task-persist");
      await mgr1.waitTask(job.jobId, { waitMs: 2_000 });

      // Restart server
      const config: BridgeConfig = {
        executable: process.execPath,
        allowedRoots: [process.cwd(), runsDir],
        sandbox: false,
        dangerouslySkipPermissions: false,
        defaultTimeoutMs: 5_000,
        maxStderrBytes: 4_096
      };
      const mgr2 = new WorkerManager(config, [fixture], { runsDir });
      managers.push(mgr2);

      const cancelResult = await mgr2.cancelTask(job.jobId);
      expect(cancelResult.status).toBe("succeeded");
      expect(cancelResult.active).toBe(false);
    });
  });

  describe("close_worker", () => {
    it("cancels outstanding work, stops process, and closes worker", async () => {
      const { mgr } = makeManager();
      const worker = await mgr.createWorker({ role: "implementer", workspace: process.cwd() });

      const jSlow = await mgr.dispatchTask(worker.workerId, "DELAY:200:close-me");
      const jQueued = await mgr.dispatchTask(worker.workerId, "queued-turn");

      const closeRes = await mgr.closeWorker(worker.workerId);
      expect(closeRes.status).toBe("closed");

      const slowInspect = mgr.inspectTask(jSlow.jobId);
      const queuedInspect = mgr.inspectTask(jQueued.jobId);
      expect(slowInspect.status).toBe("canceled");
      expect(queuedInspect.status).toBe("canceled");

      // Cannot dispatch to closed worker
      await expect(mgr.dispatchTask(worker.workerId, "fail")).rejects.toThrow(/closed/i);
    });
  });

  describe("agy_events and agy_history", () => {
    it("polls normalized events with cursor filtering", async () => {
      const { mgr } = makeManager();
      const worker = await mgr.createWorker({ role: "tester", workspace: process.cwd() });
      const j = await mgr.dispatchTask(worker.workerId, "event-test");
      await mgr.waitTask(j.jobId, { waitMs: 2_000 });

      const allEvents = mgr.getEvents({ workerId: worker.workerId });
      expect(allEvents.events.length).toBeGreaterThan(0);
      const firstCursor = allEvents.events[0]!.cursor;

      const filtered = mgr.getEvents({ workerId: worker.workerId, afterCursor: firstCursor });
      expect(filtered.events.length).toBe(allEvents.events.length - 1);
    });

    it("lists history newest-first and recovers history across server restarts", async () => {
      const { mgr: mgr1, runsDir } = makeManager();
      const w1 = await mgr1.createWorker({ role: "implementer", workspace: process.cwd() });

      const j1 = await mgr1.dispatchTask(w1.workerId, "task-1");
      await mgr1.waitTask(j1.jobId, { waitMs: 2_000 });

      const j2 = await mgr1.dispatchTask(w1.workerId, "task-2");
      await mgr1.waitTask(j2.jobId, { waitMs: 2_000 });

      const hist1 = await mgr1.getHistory();
      expect(hist1.jobs.length).toBe(2);
      expect(hist1.jobs[0]!.job_id).toBe(j2.jobId); // newest first
      expect(hist1.jobs[1]!.job_id).toBe(j1.jobId);

      // Simulate server restart with new WorkerManager pointing to same runsDir
      const config: BridgeConfig = {
        executable: process.execPath,
        allowedRoots: [process.cwd(), runsDir],
        sandbox: false,
        dangerouslySkipPermissions: false,
        defaultTimeoutMs: 5_000,
        maxStderrBytes: 4_096
      };
      const mgr2 = new WorkerManager(config, [fixture], { runsDir });
      managers.push(mgr2);

      const hist2 = await mgr2.getHistory();
      expect(hist2.jobs.length).toBe(2);
      expect(hist2.jobs[0]!.job_id).toBe(j2.jobId);
      expect(hist2.jobs[1]!.job_id).toBe(j1.jobId);
      expect(hist2.jobs[0]!.status).toBe("succeeded");
    });
  });

  describe("compatibility tools retain original behavior", () => {
    it("agy_delegate, agy_status, agy_stop, agy_reset still work identically", async () => {
      const { mgr } = makeManager();
      const del = await mgr.delegate("implementer", "compat-task", process.cwd());
      expect(del.response).toContain("reply:compat-task:accept-edits");

      const statuses = mgr.status("implementer");
      expect(statuses[0]!.role).toBe("implementer");

      await mgr.stop("implementer");
      const stoppedStatus = mgr.status("implementer");
      expect(stoppedStatus[0]!.state).toBe("stopped");

      await mgr.reset("implementer");
      const resetStatus = mgr.status("implementer");
      expect(resetStatus[0]!.state).toBe("stopped");
    });
  });

  describe("public MCP wait_task interface", () => {
    it("strips legacy wait_ms and after_cursor, does not short-poll, and returns terminal true with empty events", async () => {
      const { mgr } = makeManager();
      const server = createServer(mgr);
      const [t1, t2] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "test-client", version: "1.0.0" });

      await server.connect(t1);
      await client.connect(t2);

      try {
        const worker = await mgr.createWorker({ role: "implementer", workspace: process.cwd() });
        // Dispatch delayed task (250ms)
        const job = await mgr.dispatchTask(worker.workerId, "DELAY:250:mcp-wait");

        const start = Date.now();
        // Pass legacy wait_ms: 0 and after_cursor: 0
        const res = await client.callTool({
          name: "wait_task",
          arguments: {
            job_id: job.jobId,
            wait_ms: 0,
            after_cursor: 0
          }
        });
        const elapsed = Date.now() - start;

        expect(res.isError).toBeFalsy();
        // Must not return immediately (proves wait_ms: 0 was stripped and didn't short-poll)
        expect(elapsed).toBeGreaterThanOrEqual(200);

        const structured = res.structuredContent as any;
        expect(structured.terminal).toBe(true);
        expect(structured.status).toBe("succeeded");
        expect(structured.events).toEqual([]);

        // Non-terminal summary format check vs terminal summary format check
        const textContent = (res.content as Array<any>)[0].text;
        expect(textContent).toBe(`Job ${job.jobId} status: succeeded (terminal: true).`);
      } finally {
        await client.close();
        await server.close();
      }
    });
  });

  describe("MCP Tasks extension", () => {
    it("advertises Tasks and returns a durable task for negotiated dispatch_task calls", async () => {
      const { mgr, runsDir } = makeManager();
      const handler = createMcpHandler(() => createServer(mgr).server);

      let requestId = 0;
      const rawRequest = async (
        target: ReturnType<typeof createMcpHandler>,
        method: string,
        params: Record<string, unknown>
      ) => {
        const id = ++requestId;
        const response = await target.fetch(new Request("http://localhost/mcp", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "mcp-protocol-version": "2026-07-28",
            "mcp-method": method,
            ...((typeof params.name === "string" || typeof params.taskId === "string")
              ? { "mcp-name": String(params.name ?? params.taskId) }
              : {})
          },
          body: JSON.stringify({ jsonrpc: "2.0", id, method, params })
        }));
        const message = await response.json() as any;
        if (message.error) throw new Error(message.error.message);
        return message.result;
      };

      try {
        const envelope = {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": { name: "tasks-test-client", version: "1.0.0" },
          "io.modelcontextprotocol/clientCapabilities": {
            extensions: { "io.modelcontextprotocol/tasks": {} }
          }
        };
        const discovery = await rawRequest(handler, "server/discover", { _meta: envelope });
        expect(discovery.capabilities.extensions).toEqual({ "io.modelcontextprotocol/tasks": {} });
        const worker = await mgr.createWorker({ role: "implementer", workspace: process.cwd() });
        const params = withTaskCapabilityV2({
          name: "dispatch_task",
          arguments: { worker_id: worker.workerId, brief: "DELAY:100:mcp-task" }
        });
        const created = CreateTaskResultV2Schema.parse(await rawRequest(handler, "tools/call", {
          ...params,
          _meta: envelope
        }));

        expect(created.resultType).toBe("task");
        expect(created.status).toBe("working");
        expect(created.taskId).toMatch(/^job-/);
        expect(created.pollIntervalMs).toBe(60_000);

        await mgr.waitTask(created.taskId, { waitMs: 2_000 });
        const completed = GetTaskResultV2Schema.parse(await rawRequest(handler, "tasks/get", {
          taskId: created.taskId,
          _meta: envelope
        }));

        expect(completed.status).toBe("completed");
        if (completed.status !== "completed") throw new Error("Expected completed task");
        expect(completed.result.structuredContent).toMatchObject({
          job_id: created.taskId,
          status: "succeeded",
          result: "reply:mcp-task:accept-edits"
        });

        await expect(rawRequest(handler, "tasks/get", {
          taskId: "../outside",
          _meta: envelope
        })).rejects.toThrow(/invalid/i);

        const noTasksEnvelope = {
          ...envelope,
          "io.modelcontextprotocol/clientCapabilities": { extensions: {} }
        };
        await expect(rawRequest(handler, "tasks/get", {
          taskId: created.taskId,
          _meta: noTasksEnvelope
        })).rejects.toThrow(/extension is required/i);

        const cancelParams = withTaskCapabilityV2({
          name: "dispatch_task",
          arguments: { worker_id: worker.workerId, brief: "DELAY:1000:cancelled-task" }
        });
        const cancelCreated = CreateTaskResultV2Schema.parse(await rawRequest(handler, "tools/call", {
          ...cancelParams,
          _meta: envelope
        }));
        await rawRequest(handler, "tasks/cancel", { taskId: cancelCreated.taskId, _meta: envelope });
        const cancelled = GetTaskResultV2Schema.parse(await rawRequest(handler, "tasks/get", {
          taskId: cancelCreated.taskId,
          _meta: envelope
        }));
        expect(cancelled.status).toBe("cancelled");

        const orphanParams = withTaskCapabilityV2({
          name: "dispatch_task",
          arguments: { worker_id: worker.workerId, brief: "DELAY:1000:orphaned" }
        });
        const orphanCreated = CreateTaskResultV2Schema.parse(await rawRequest(handler, "tools/call", {
          ...orphanParams,
          _meta: envelope
        }));
        await new Promise((resolve) => setTimeout(resolve, 30));

        const restarted = new WorkerManager({
          executable: process.execPath,
          allowedRoots: [process.cwd(), runsDir],
          sandbox: false,
          dangerouslySkipPermissions: false,
          defaultTimeoutMs: 5_000,
          maxStderrBytes: 4_096
        }, [fixture], { runsDir });
        managers.push(restarted);
        const restartedHandler = createMcpHandler(() => createServer(restarted).server);
        try {
          const orphaned = GetTaskResultV2Schema.parse(await rawRequest(restartedHandler, "tasks/get", {
            taskId: orphanCreated.taskId,
            _meta: envelope
          }));
          expect(orphaned.status).toBe("failed");
          if (orphaned.status !== "failed") throw new Error("Expected orphaned task failure");
          expect(orphaned.error.message).toMatch(/ORPHANED_JOB/);
        } finally {
          await restartedHandler.close();
        }
      } finally {
        await handler.close();
      }
    });

    it("keeps the immediate enqueue response when the caller did not negotiate Tasks", async () => {
      const { mgr } = makeManager();
      const server = createServer(mgr);
      const [t1, t2] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "legacy-test-client", version: "1.0.0" });

      await server.connect(t1);
      await client.connect(t2);

      try {
        const worker = await mgr.createWorker({ role: "tester", workspace: process.cwd() });
        const response = await client.callTool({
          name: "dispatch_task",
          arguments: { worker_id: worker.workerId, brief: "legacy-dispatch" }
        });
        expect(response).not.toHaveProperty("resultType", "task");
        expect(response.structuredContent).toMatchObject({ workerId: worker.workerId });
      } finally {
        await client.close();
        await server.close();
      }
    });
  });
});
