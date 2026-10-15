import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { AgyWorker, type AgyWorkerOptions } from "../src/agy-worker.js";
import { terminateProcessTree } from "../src/process-tree.js";

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "fixtures", "fake-agy.mjs");
const workers: AgyWorker[] = [];
const temporaryDirectories: string[] = [];

function createWorker(
  mode: "accept-edits" | "plan" = "accept-edits",
  overrides: Partial<AgyWorkerOptions> = {}
) {
  const worker = new AgyWorker({
    role: mode === "plan" ? "tester" : "implementer",
    cwd: process.cwd(), executable: process.execPath, prefixArgs: [fixture], mode,
    defaultTimeoutMs: 1_000, maxStderrBytes: 1_024, sandbox: false,
    dangerouslySkipPermissions: false,
    ...overrides
  });
  workers.push(worker);
  return worker;
}

afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.stop()));
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition was not met before timeout");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("AgyWorker", () => {
  it("binds fresh sessions explicitly and disables slash expansion", async () => {
    const result = await createWorker().delegate("ARGUMENTS");
    const args = JSON.parse(result.response) as string[];
    expect(args).toContain("--new-project");
    expect(args).toContain("--disable-slash-commands");
    expect(args[args.indexOf("--add-dir") + 1]).toBe(process.cwd());
  });

  it("passes each configured add-dir as an extra --add-dir after the workspace", async () => {
    const extra = mkdtempSync(path.join(tmpdir(), "agy-extra-"));
    temporaryDirectories.push(extra);
    const result = await createWorker("accept-edits", { addDirs: [extra, process.cwd()] }).delegate("ARGUMENTS");
    const args = JSON.parse(result.response) as string[];
    const dirs = args.flatMap((arg, index) => arg === "--add-dir" ? [args[index + 1]] : []);
    expect(dirs).toEqual([process.cwd(), extra]);
  });

  it("does not charge duplicate DONE usage twice", async () => {
    const worker = createWorker();
    const result = await worker.delegate("DUPLICATE_USAGE", { maxTokens: 5, maxSteps: 3 });
    expect(result.response).toBe("duplicate handled");
  });

  it("counts unindexed completed steps conservatively instead of bypassing the budget", async () => {
    await expect(createWorker().delegate("ANONYMOUS_STEPS", { maxSteps: 3 }))
      .rejects.toMatchObject({ budgetKind: "steps" });
  });
  it("reuses one process and conversation for ordered turns", async () => {
    const worker = createWorker();
    const first = await worker.delegate("one");
    const second = await worker.delegate("two");
    expect(first.response).toBe("reply:one:accept-edits");
    expect(second.response).toBe("reply:two:accept-edits");
    expect(second.conversationId).toBe(first.conversationId);
    expect(second.numTurns).toBe(2);
    expect(worker.status().pid).toBeTypeOf("number");
  });

  it("serializes concurrent calls without crossing their results", async () => {
    const worker = createWorker("plan");
    const [first, second] = await Promise.all([worker.delegate("alpha"), worker.delegate("beta")]);
    expect(first.response).toBe("reply:alpha:plan");
    expect(second.response).toBe("reply:beta:plan");
    expect(second.numTurns).toBe(2);
  });

  it.each([
    ["ERROR", /fake failure/],
    ["EMPTY_SUCCESS", /empty response/i],
    ["MALFORMED", /invalid NDJSON/i]
  ])("invalidates the process after %s", async (prompt, expected) => {
    const worker = createWorker();
    await expect(worker.delegate(prompt)).rejects.toThrow(expected);
    expect(worker.status().state).toBe("stopped");
    const recovered = await worker.delegate("recovered");
    expect(recovered.response).toBe("reply:recovered:accept-edits");
  });

  it("does not restart unsafely when the process exits before Windows tree cleanup can be confirmed", async () => {
    const worker = createWorker();
    if (process.platform === "win32") {
      await expect(worker.delegate("EXIT")).rejects.toThrow(/could not confirm termination.*process tree/i);
      await expect(worker.delegate("recovered")).rejects.toThrow(/unsafe to restart/i);
      return;
    }

    await expect(worker.delegate("EXIT")).rejects.toThrow(/exited/i);
    const recovered = await worker.delegate("recovered");
    expect(recovered.response).toBe("reply:recovered:accept-edits");
  });

  it("terminates a timed-out process and resumes the same conversation on the next call", async () => {
    const worker = createWorker();
    const first = await worker.delegate("first");
    await expect(worker.delegate("HANG", 30)).rejects.toThrow(/timed out/i);
    expect(worker.status().state).toBe("stopped");
    const resumed = await worker.delegate("resumed");
    expect(resumed.conversationId).toBe(first.conversationId);
    expect(resumed.usage).toBeUndefined();
    expect(resumed.cumulativeUsage.total_tokens).toBe(2);

    const measurable = await worker.delegate("measurable-again");
    expect(measurable.usage?.total_tokens).toBe(2);
    const resumedArgs = JSON.parse((await worker.delegate("ARGUMENTS")).response) as string[];
    expect(resumedArgs).not.toContain("--new-project");
    expect(resumedArgs[resumedArgs.indexOf("--conversation") + 1]).toBe(first.conversationId);
  });

  it("resets the inactivity timeout when meaningful progress arrives", async () => {
    const worker = createWorker();
    const result = await worker.delegate("PROGRESS_DELAY:4:100:kept-alive", {
      inactivityTimeoutMs: 200,
      maxDurationMs: 1_000
    });
    expect(result.response).toBe("reply:kept-alive:accept-edits");
    expect(result.durationSeconds).toBeGreaterThanOrEqual(0.35);
  });

  it("enforces the absolute duration cap even while progress continues", async () => {
    const worker = createWorker();
    await expect(worker.delegate("PROGRESS_DELAY:20:80:too-long", {
      inactivityTimeoutMs: 200,
      maxDurationMs: 350
    })).rejects.toMatchObject({ timeoutKind: "max_duration" });
    expect(worker.status().state).toBe("stopped");
  });

  it("requests a graceful finish by writing a FINISH_NOW user event to the CLI stdin", async () => {
    const worker = createWorker();
    await worker.delegate("warm-up");
    let finishRequested = false;
    const inFlight = worker.delegate("GRACEFUL:HANG", 5_000).then((result) => {
      expect(finishRequested).toBe(true);
      expect(result.response).toContain("reply:graceful-done");
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    finishRequested = worker.requestGracefulFinish();
    expect(finishRequested).toBe(true);
    await inFlight;
  });

  it("refuses a graceful finish when no turn is active", () => {
    const worker = createWorker();
    expect(worker.requestGracefulFinish()).toBe(false);
  });

  it("stops before starting a step beyond the configured step budget", async () => {
    const worker = createWorker();
    await expect(worker.delegate("BUDGET_LOOP:10:15:1", {
      inactivityTimeoutMs: 500,
      maxDurationMs: 2_000,
      maxSteps: 3,
      maxTokens: 100
    })).rejects.toMatchObject({ budgetKind: "steps" });
    expect(worker.status().state).toBe("stopped");
  });

  it("stops before another step after streamed token usage reaches the budget", async () => {
    const worker = createWorker();
    await expect(worker.delegate("BUDGET_LOOP:10:15:3", {
      inactivityTimeoutMs: 500,
      maxDurationMs: 2_000,
      maxSteps: 100,
      maxTokens: 5
    })).rejects.toMatchObject({ budgetKind: "tokens" });
    expect(worker.status().state).toBe("stopped");
  });

  it("kills descendant processes and waits for their exit before allowing a follow-up", async () => {
    const worker = createWorker();
    const directory = mkdtempSync(path.join(tmpdir(), "agy-tree-"));
    temporaryDirectories.push(directory);
    const pidFile = path.join(directory, "descendant.pid");

    const timedOut = worker.delegate(`SPAWN_CHILD_HANG:${pidFile}`, {
      inactivityTimeoutMs: 120,
      maxDurationMs: 1_000
    });
    await waitUntil(() => existsSync(pidFile));
    const descendantPid = Number(readFileSync(pidFile, "utf8"));
    expect(processExists(descendantPid)).toBe(true);

    await expect(timedOut).rejects.toMatchObject({ timeoutKind: "inactivity" });
    await waitUntil(() => !processExists(descendantPid));
    const followup = await worker.delegate("after-tree-cleanup");
    expect(followup.response).toBe("reply:after-tree-cleanup:accept-edits");
  });

  it("reports per-turn wall duration and usage deltas separately from CLI cumulative metrics", async () => {
    const worker = createWorker();
    const first = await worker.delegate("one");
    const second = await worker.delegate("DELAY:40:two");

    expect(second.durationSeconds).toBeGreaterThanOrEqual(0.03);
    expect(second.cliDurationSeconds).toBe(0.02);
    expect(first.usage?.total_tokens).toBe(2);
    expect(second.usage?.total_tokens).toBe(2);
    expect(second.cumulativeUsage.total_tokens).toBe(4);
  });

  it("cancels queued turns when the controller explicitly stops the worker", async () => {
    const worker = createWorker();
    const active = worker.delegate("HANG", 1_000);
    const queued = worker.delegate("must-not-run", 1_000);
    const activeCheck = expect(active).rejects.toThrow(/stopped/i);
    const queuedCheck = expect(queued).rejects.toThrow(/stopped/i);
    await new Promise((resolve) => setTimeout(resolve, 25));
    await worker.stop();
    await activeCheck;
    await queuedCheck;
    expect(worker.status().state).toBe("stopped");
  });

  it("starts a fresh conversation after an explicit cancellation", async () => {
    const worker = createWorker();
    const first = await worker.delegate("first");
    const active = worker.delegate("HANG", 1_000);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(worker.cancelActiveTurn()).toBe(true);
    await expect(active).rejects.toThrow(/canceled/i);
    const fresh = await worker.delegate("fresh-after-cancel");
    expect(fresh.conversationId).not.toBe(first.conversationId);
  });

  it("explicit cancellation discards context while timeout cleanup is already in progress", async () => {
    let releaseTermination!: () => void;
    let reportTerminationStarted!: () => void;
    const terminationStarted = new Promise<void>((resolve) => { reportTerminationStarted = resolve; });
    const terminationReleased = new Promise<void>((resolve) => { releaseTermination = resolve; });
    const worker = createWorker("accept-edits", {
      terminateTree: async (child) => {
        reportTerminationStarted();
        await terminationReleased;
        await terminateProcessTree(child);
      }
    });
    const first = await worker.delegate("first");
    const timedOut = worker.delegate("HANG", 50);
    await terminationStarted;

    expect(worker.cancelActiveTurn("explicit cancel during timeout cleanup")).toBe(true);
    releaseTermination();
    await expect(timedOut).rejects.toThrow(/timed out/i);

    const fresh = await worker.delegate("fresh-after-race");
    expect(fresh.conversationId).not.toBe(first.conversationId);
  });

  it("poisons the worker instead of advancing the queue when tree termination cannot be confirmed", async () => {
    const worker = createWorker("accept-edits", {
      terminateTree: async (child) => {
        await terminateProcessTree(child);
        throw new Error("simulated unconfirmed process tree");
      }
    });
    const active = worker.delegate("HANG", 50);
    const queued = worker.delegate("must-not-run");

    await expect(active).rejects.toThrow(/termination could not be confirmed/i);
    await expect(queued).rejects.toThrow(/unsafe to restart/i);
    await expect(worker.delegate("also-must-not-run")).rejects.toThrow(/unsafe to restart/i);
    expect(worker.status().state).toBe("stopped");
  });

  it("ignores blank stdout lines without invalidating the worker", async () => {
    const worker = createWorker();
    const result = await worker.delegate("BLANK_LINES");
    expect(result.response).toBe("blank lines handled");
    expect(worker.status().state).toBe("idle");

    const subsequent = await worker.delegate("following");
    expect(subsequent.response).toBe("reply:following:accept-edits");
    expect(subsequent.numTurns).toBe(2);
    expect(subsequent.conversationId).toBe(result.conversationId);
  });
});
