import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { AgyWorker, type AgyWorkerRawEvent } from "../src/agy-worker.js";
import type { BridgeConfig } from "../src/config.js";
import {
  addDeniedAction,
  aliasRealPath,
  buildJobWarnings,
  extractStderrHint,
  stepDenial,
  summarizeToolActivity,
  withCommandTarget
} from "../src/job-activity.js";
import { createServer } from "../src/server.js";
import { WorkerManager } from "../src/worker-manager.js";

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "fixtures", "fake-agy.mjs");

const tempDirs: string[] = [];
const managers: WorkerManager[] = [];
const workers: AgyWorker[] = [];

function makeManager(overrides: Partial<BridgeConfig> = {}, runsDirOverride?: string) {
  const runsDir = runsDirOverride ?? mkdtempSync(path.join(tmpdir(), "agy-runs-"));
  if (!runsDirOverride) tempDirs.push(runsDir);
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
  await Promise.all(workers.splice(0).map((w) => w.stop()));
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function run(mgr: WorkerManager, workerId: string, brief: string) {
  const job = await mgr.dispatchTask(workerId, brief);
  const waited = await mgr.waitTask(job.jobId, { waitMs: 5_000 });
  expect(waited.terminal).toBe(true);
  return job.jobId;
}

const REAL_READ_DENIAL = {
  step_index: 7,
  state: "ERROR",
  step_type: "tool",
  tool_name: "view_file",
  tool_info: {
    name: "view_file",
    parameters: { AbsolutePath: "/skills/x/craft-floor.md" },
    error: {
      type: "TOOL_ERROR",
      message: 'permission check failed for read_file "/skills/x/craft-floor.md": user denied permission for read_file(/skills/x/craft-floor.md)\nDo not attempt to circumvent this denial.'
    }
  }
};

describe("job activity helpers", () => {
  it("normalizes a real denied-read step with its target and ignores ordinary tool errors", () => {
    expect(stepDenial(REAL_READ_DENIAL)).toBe("ViewFile (read_file): /skills/x/craft-floor.md");
    expect(stepDenial({ step_type: "tool", tool_name: "view_file", tool_info: { error: { message: "file not found" } } })).toBeUndefined();
    expect(stepDenial({ step_type: "agent_response", state: "DONE" })).toBeUndefined();
  });

  it("deduplicates denials and prefers the entry that names a target", () => {
    const list: string[] = [];
    addDeniedAction(list, "ViewFile (read_file)");
    addDeniedAction(list, "ViewFile (read_file): /a");
    addDeniedAction(list, "ViewFile (read_file)");
    addDeniedAction(list, "ViewFile (read_file): /a");
    expect(list).toEqual(["ViewFile (read_file): /a"]);
  });

  it("attaches the latest command line to a bare command denial, bounded to 120 chars", () => {
    const long = `node -e "${"x".repeat(300)}"`;
    const steps = [
      { step_type: "tool", tool_name: "run_command", tool_info: { parameters: { CommandLine: "echo first" } } },
      { step_type: "tool", tool_name: "run_command", tool_info: { parameters: { CommandLine: long } } }
    ];
    const entry = withCommandTarget("RunCommand (command)", steps);
    expect(entry.startsWith("RunCommand (command): node -e ")).toBe(true);
    expect(entry.length).toBeLessThanOrEqual("RunCommand (command): ".length + 123);
    expect(withCommandTarget("ViewFile (read_file)", steps)).toBe("ViewFile (read_file)");
    expect(withCommandTarget("RunCommand (command)", [])).toBe("RunCommand (command)");
  });

  it("counts each tool step once and lists unique changed files", () => {
    const steps = [
      { step_index: 1, state: "DONE", step_type: "agent_response" },
      { step_index: 2, state: "ACTIVE", step_type: "tool", tool_name: "write_to_file", tool_info: { parameters: { TargetFile: "/w/a.ts" } } },
      { step_index: 2, state: "DONE", step_type: "tool", tool_name: "write_to_file", tool_info: { parameters: { TargetFile: "/w/a.ts" } } },
      { step_index: 3, state: "DONE", step_type: "tool", tool_name: "replace_file_content", tool_info: { parameters: { TargetFile: "/w/b.ts" } } },
      { step_index: 4, state: "DONE", step_type: "tool", tool_name: "multi_replace_file_content", tool_info: { parameters: { TargetFile: "/w/a.ts" } } },
      { step_index: 5, state: "DONE", step_type: "tool", tool_name: "run_command", tool_info: { parameters: { CommandLine: "npm test" } } },
      { step_index: 6, state: "DONE", step_type: "tool", tool_name: "view_file", tool_info: { parameters: { AbsolutePath: "/w/c.ts" } } },
      REAL_READ_DENIAL
    ];
    expect(summarizeToolActivity(steps)).toEqual({
      tool_calls: 6,
      files_changed: ["/w/a.ts", "/w/b.ts"],
      commands_run: 1,
      tool_errors: 1
    });
    expect(summarizeToolActivity([])).toEqual({ tool_calls: 0, files_changed: [], commands_run: 0, tool_errors: 0 });
  });

  it("caps files_changed at 20 and does not credit a failed write", () => {
    const steps = Array.from({ length: 30 }, (_, i) => ({
      step_index: i, state: "DONE", step_type: "tool", tool_name: "write_to_file", tool_info: { parameters: { TargetFile: `/w/f${i}.ts` } }
    }));
    steps.push({ step_index: 99, state: "ERROR", step_type: "tool", tool_name: "write_to_file", tool_info: { parameters: { TargetFile: "/w/failed.ts" }, error: { message: "boom" } } } as never);
    const activity = summarizeToolActivity(steps);
    expect(activity.files_changed).toHaveLength(20);
    expect(activity.files_changed).not.toContain("/w/failed.ts");
    expect(activity.tool_errors).toBe(1);
  });

  it("extracts the headless auto-deny stderr hint", () => {
    const hint = 'jetski: no output produced - a tool required the "command" permission that headless mode cannot prompt for, so it was auto-denied.';
    expect(extractStderrHint(`warning: something\n${hint}\n`)).toBe(hint);
    expect(extractStderrHint("warning: --mode plan has no effect")).toBeUndefined();
  });

  it("builds denial, no-op implementer and tester-write warnings", () => {
    const idle = { tool_calls: 0, files_changed: [], commands_run: 0, tool_errors: 0 };
    const denied = buildJobWarnings({ role: "implementer", status: "succeeded", deniedActions: ["ViewFile (read_file): /x"], toolActivity: { ...idle, files_changed: ["/w/a"] }, stderrHint: "auto-denied hint" });
    expect(denied).toHaveLength(1);
    expect(denied[0]).toContain("ViewFile (read_file): /x");
    expect(denied[0]).toContain("add_dirs");
    expect(denied[0]).toContain("permissions.allow");
    expect(denied[0]).toContain("auto-denied hint");

    const noop = buildJobWarnings({ role: "implementer", status: "succeeded", deniedActions: [], toolActivity: idle });
    expect(noop).toEqual(["Implementer finished without changing any file; verify the response before accepting it."]);
    expect(buildJobWarnings({ role: "implementer", status: "failed", deniedActions: [], toolActivity: idle })).toEqual([]);
    expect(buildJobWarnings({ role: "tester", status: "succeeded", deniedActions: [], toolActivity: idle })).toEqual([]);
    expect(buildJobWarnings({ role: "tester", status: "succeeded", deniedActions: [], toolActivity: { ...idle, files_changed: ["/w/a"] } })[0]).toContain("Tester modified 1 file");
    expect(buildJobWarnings({ role: "tester", status: "succeeded", deniedActions: [], untrustedDeniedBaseline: true })[0]).toContain("could not be attributed");
  });

  it("names the real path when a denied path is an alias of an allowed directory, and never throws", () => {
    // Canonical base so only the junction (not an 8.3 or /private temp alias) differs from the real path.
    const base = realpathSync.native(mkdtempSync(path.join(tmpdir(), "agy-alias-")));
    tempDirs.push(base);
    const real = path.join(base, "real");
    mkdirSync(real);
    writeFileSync(path.join(real, "skill.md"), "x");
    const alias = path.join(base, "alias");
    try {
      symlinkSync(real, alias, "junction");
    } catch {
      return; // symlink creation not permitted on this machine
    }
    const resolved = aliasRealPath(path.join(alias, "skill.md"), [real]);
    expect(resolved).toBeDefined();
    expect(resolved!.toLowerCase()).toContain(path.join("real", "skill.md").toLowerCase());
    expect(aliasRealPath(path.join(real, "skill.md"), [real])).toBeUndefined();
    expect(aliasRealPath("relative/path", [real])).toBeUndefined();
    expect(aliasRealPath(path.join(base, "missing", "x"), [real])).toBeUndefined();
  });
});

describe("AgyWorker denied-action baseline", () => {
  function createWorker(events: AgyWorkerRawEvent[]) {
    const worker = new AgyWorker({
      role: "implementer", cwd: process.cwd(), executable: process.execPath, prefixArgs: [fixture], mode: "accept-edits",
      defaultTimeoutMs: 1_000, maxStderrBytes: 1_024, sandbox: false, dangerouslySkipPermissions: false,
      onRawEvent: (event) => events.push(event)
    });
    workers.push(worker);
    return worker;
  }
  const results = (events: AgyWorkerRawEvent[]) => events.filter((e): e is Extract<AgyWorkerRawEvent, { type: "result" }> => e.type === "result");

  it("reports only the entries added by each turn", async () => {
    const events: AgyWorkerRawEvent[] = [];
    const worker = createWorker(events);
    await worker.delegate("DENY_READ:/x/one.md");
    await worker.delegate("CLEAN");
    await worker.delegate("DENY_CMD");
    await worker.delegate("CLEAN");
    expect(results(events).map((r) => (r.deniedDelta ?? []).length)).toEqual([1, 0, 1, 0]);
    expect(results(events).every((r) => r.deniedBaselineTrusted === true)).toBe(true);
  });

  it("does not attribute the cumulative list after an interrupted turn", async () => {
    const events: AgyWorkerRawEvent[] = [];
    const worker = createWorker(events);
    await worker.delegate("CLEAN");
    await expect(worker.delegate("HANG", 30)).rejects.toThrow(/timed out/i);
    await worker.delegate("DENY_CMD");
    const last = results(events).at(-1)!;
    expect(last.deniedBaselineTrusted).toBe(false);
    expect(last.deniedDelta).toEqual([]);
    expect(last.result.denied_actions).toHaveLength(1);
    await worker.delegate("DENY_CMD");
    expect(results(events).at(-1)!.deniedBaselineTrusted).toBe(true);
  });

  it("resets the baseline when the worker starts a new conversation", async () => {
    const events: AgyWorkerRawEvent[] = [];
    const worker = createWorker(events);
    await worker.delegate("DENY_CMD");
    await worker.stop();
    await worker.delegate("DENY_CMD");
    expect(results(events).map((r) => (r.deniedDelta ?? []).length)).toEqual([1, 1]);
  });
});

describe("per-job denied actions, tool activity and warnings", () => {
  it("attributes cumulative agy denials to the job that caused them", async () => {
    const { mgr } = makeManager();
    const worker = await mgr.createWorker({ role: "implementer", workspace: process.cwd() });
    const target = path.join(process.cwd(), "outside", "craft-floor.md");

    const jobA = await run(mgr, worker.workerId, `DENY_READ:${target}`);
    const jobB = await run(mgr, worker.workerId, "CLEAN");
    const jobC = await run(mgr, worker.workerId, "DENY_CMD");
    const jobD = await run(mgr, worker.workerId, "CLEAN");

    const a = mgr.inspectTask(jobA);
    expect(a.denied_actions).toEqual([`ViewFile (read_file): ${target}`]);
    expect(a.total_denied_actions).toBe(1);
    expect(a.warnings?.[0]).toContain("auto-denies permissions");

    const b = mgr.inspectTask(jobB);
    expect(b.denied_actions).toEqual([]);
    expect(b.total_denied_actions).toBe(0);
    expect((b.warnings ?? []).join(" ")).not.toContain("denied");

    const c = mgr.inspectTask(jobC);
    expect(c.denied_actions).toEqual(['RunCommand (command): node -e "process.exit(0)"']);
    expect(c.total_denied_actions).toBe(1);
    expect(c.warnings?.[0]).toContain("jetski: no output produced");

    expect(mgr.inspectTask(jobD).denied_actions).toEqual([]);
  });

  it("uses the stderr auto-deny line when a repeated denial does not grow agy's list", async () => {
    const { mgr } = makeManager();
    const worker = await mgr.createWorker({ role: "implementer", workspace: process.cwd() });

    await run(mgr, worker.workerId, "DENY_CMD");
    const repeat = await run(mgr, worker.workerId, "DENY_CMD_REPEAT");

    const detail = mgr.inspectTask(repeat);
    expect(detail.denied_actions).toEqual(['RunCommand (command): node -e "process.exit(0)"']);
    expect(detail.total_denied_actions).toBe(1);
  });

  it("reproduces the same per-job lists, tool activity and warnings after a restart", async () => {
    const { mgr, runsDir } = makeManager();
    const worker = await mgr.createWorker({ role: "implementer", workspace: process.cwd() });
    const jobA = await run(mgr, worker.workerId, "DENY_READ:/skills/x/craft-floor.md");
    const jobB = await run(mgr, worker.workerId, "CLEAN");
    const jobC = await run(mgr, worker.workerId, "DENY_CMD");
    const liveSnapshots = [jobA, jobB, jobC].map((id) => mgr.inspectTask(id));

    const { mgr: restarted } = makeManager({}, runsDir);
    const persisted = [jobA, jobB, jobC].map((id) => restarted.inspectTask(id));
    for (const [index, live] of liveSnapshots.entries()) {
      const disk = persisted[index]!;
      expect(disk.denied_actions).toEqual(live.denied_actions);
      expect(disk.total_denied_actions).toBe(live.total_denied_actions);
      expect(disk.tool_activity).toEqual(live.tool_activity);
      expect(disk.warnings).toEqual(live.warnings);
    }
    expect(persisted[1]!.denied_actions).toEqual([]);

    const detail = restarted.getJobDetail(jobA) as { warnings?: string[]; stderr_tail?: unknown };
    expect(detail.warnings?.[0]).toContain("auto-denies permissions");
    expect(detail).not.toHaveProperty("stderr_tail");
  });

  it("falls back to the cumulative list for legacy history without a per-job record", async () => {
    const { mgr, runsDir } = makeManager();
    const legacyId = "job-legacy-1";
    const lines = [
      { eventType: "lifecycle", workerId: "w", jobId: legacyId, timestamp: "2026-01-01T00:00:00.000Z", data: { lifecycle: "queued", role: "implementer", workspace: process.cwd(), brief: "old" } },
      { eventType: "result", workerId: "w", jobId: legacyId, timestamp: "2026-01-01T00:00:01.000Z", data: { status: "SUCCESS", response: "done", denied_actions: [{ action: "read_file", display_name: "ViewFile" }], usage: { input_tokens: 1, output_tokens: 1, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 2 } } }
    ];
    writeFileSync(path.join(runsDir, `${legacyId}.ndjson`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    void mgr;
    const { mgr: reader } = makeManager({}, runsDir);
    const inspected = reader.inspectTask(legacyId);
    expect(inspected.denied_actions).toEqual(["ViewFile (read_file)"]);
  });

  it("reports tool activity and warns when an implementer changed no file", async () => {
    const { mgr } = makeManager();
    const worker = await mgr.createWorker({ role: "implementer", workspace: process.cwd() });
    const target = path.join(process.cwd(), "src", "example.ts");

    const wrote = mgr.inspectTask(await run(mgr, worker.workerId, `WRITE_FILE:${target}`));
    expect(wrote.tool_activity).toEqual({ tool_calls: 3, files_changed: [target], commands_run: 1, tool_errors: 0 });
    expect(wrote.warnings).toBeUndefined();

    const noop = mgr.inspectTask(await run(mgr, worker.workerId, "describe the plan"));
    expect(noop.status).toBe("succeeded");
    expect(noop.tool_activity).toEqual({ tool_calls: 0, files_changed: [], commands_run: 0, tool_errors: 0 });
    expect(noop.warnings).toEqual(["Implementer finished without changing any file; verify the response before accepting it."]);
  });

  it("warns when a tester modifies files because plan mode is not enforced", async () => {
    const { mgr } = makeManager();
    const tester = await mgr.createWorker({ role: "tester", workspace: process.cwd() });
    const inspected = mgr.inspectTask(await run(mgr, tester.workerId, `WRITE_FILE:${path.join(process.cwd(), "x.txt")}`));
    expect(inspected.warnings?.[0]).toContain("Tester modified 1 file");
  });

  it("explains an alias path using a configured add-dir", async () => {
    const base = realpathSync.native(mkdtempSync(path.join(tmpdir(), "agy-alias-job-")));
    tempDirs.push(base);
    const real = path.join(base, "skills");
    mkdirSync(real);
    writeFileSync(path.join(real, "a.md"), "x");
    const alias = path.join(base, "alias");
    try {
      symlinkSync(real, alias, "junction");
    } catch {
      return;
    }
    const { mgr } = makeManager({ addDirs: [real] });
    const worker = await mgr.createWorker({ role: "implementer", workspace: process.cwd() });
    const inspected = mgr.inspectTask(await run(mgr, worker.workerId, `DENY_READ:${path.join(alias, "a.md")}`));
    expect(inspected.warnings!.join(" ")).toMatch(/is an alias; use the real path/);
  });
});

describe("wait_task attention text and repeated-wait hint", () => {
  it("lists warnings in the terminal summary and hints after an aborted wait", async () => {
    const { mgr } = makeManager();
    const server = createServer(mgr);
    const [t1, t2] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "reliability-client", version: "1.0.0" });
    await server.connect(t1);
    await client.connect(t2);
    try {
      const worker = await mgr.createWorker({ role: "implementer", workspace: process.cwd() });
      const job = await mgr.dispatchTask(worker.workerId, "DELAY:600:slow");

      const controller = new AbortController();
      const first = client.callTool({ name: "wait_task", arguments: { job_id: job.jobId } }, { signal: controller.signal });
      setTimeout(() => controller.abort(), 100);
      await expect(first).rejects.toBeDefined();
      expect(mgr.isRepeatedWait(job.jobId)).toBe(true);

      const second = await client.callTool({ name: "wait_task", arguments: { job_id: job.jobId } });
      const text = (second.content as Array<{ text: string }>)[0]!.text;
      expect(text).toContain("1 warning(s): Implementer finished without changing any file");
      expect(text).toContain("Host configuration");
      expect(mgr.isRepeatedWait(job.jobId)).toBe(false);

      const clean = await mgr.dispatchTask(worker.workerId, "DELAY:20:quick");
      const third = await client.callTool({ name: "wait_task", arguments: { job_id: clean.jobId } });
      expect((third.content as Array<{ text: string }>)[0]!.text).not.toContain("Host configuration");
    } finally {
      await client.close();
      await server.close();
    }
  });
});
