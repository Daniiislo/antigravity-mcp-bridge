import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EventStore } from "../src/event-store.js";

const created: string[] = [];
afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("EventStore", () => {
  it("allocates monotonically increasing cursors across events", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "event-store-"));
    created.push(dir);
    const store = new EventStore({ runsDir: dir });

    const e1 = store.recordEvent({
      eventType: "lifecycle",
      workerId: "w1",
      jobId: "j1",
      data: { state: "queued" }
    });
    const e2 = store.recordEvent({
      eventType: "step",
      workerId: "w1",
      jobId: "j1",
      data: { step_type: "agent_response" }
    });
    const e3 = store.recordEvent({
      eventType: "result",
      workerId: "w1",
      jobId: "j1",
      data: { status: "SUCCESS" }
    });

    expect(e1.cursor).toBe(1);
    expect(e2.cursor).toBe(2);
    expect(e3.cursor).toBe(3);
  });

  it("persists NDJSON to disk atomically per event and excludes environment variables", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "event-store-"));
    created.push(dir);
    const store = new EventStore({ runsDir: dir });

    store.recordEvent({
      eventType: "lifecycle",
      workerId: "w-test",
      jobId: "job-100",
      data: {
        state: "started",
        env: { SECRET_KEY: "secret", PATH: "/usr/bin" },
        processEnv: process.env,
        safeField: "safe-value"
      }
    });

    const runFile = path.join(dir, "job-100.ndjson");
    const content = readFileSync(runFile, "utf8");
    const parsed = JSON.parse(content.trim());

    expect(parsed.cursor).toBe(1);
    expect(parsed.workerId).toBe("w-test");
    expect(parsed.jobId).toBe("job-100");
    expect(parsed.data.safeField).toBe("safe-value");
    // Invariants: environment variables must NEVER be logged to run files
    expect(parsed.data.env).toBeUndefined();
    expect(parsed.data.processEnv).toBeUndefined();
    expect(content).not.toContain("SECRET_KEY");
  });

  it("truncates oversized text and stderr fields in stored events and disk logs", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "event-store-"));
    created.push(dir);
    const store = new EventStore({ runsDir: dir, maxFieldBytes: 100 });

    const hugeText = "x".repeat(500);
    const evt = store.recordEvent({
      eventType: "stderr",
      workerId: "w-test",
      jobId: "job-huge",
      data: { stderr: hugeText }
    });

    expect((evt.data.stderr as string).length).toBeLessThan(150);
    expect(evt.data.stderr).toContain("[truncated]");

    const runFile = path.join(dir, "job-huge.ndjson");
    const content = readFileSync(runFile, "utf8");
    const parsed = JSON.parse(content.trim());
    expect(parsed.data.stderr).toContain("[truncated]");
  });

  it("tolerates disk logging failures without throwing or interrupting callers", () => {
    // Non-writable directory / invalid path
    const invalidDir = path.join(tmpdir(), "nonexistent-dir-for-test", "nested");
    const store = new EventStore({ runsDir: invalidDir });

    expect(() => {
      store.recordEvent({
        eventType: "lifecycle",
        workerId: "w-safe",
        jobId: "job-fail-disk",
        data: { test: "should not throw" }
      });
    }).not.toThrow();
  });

  it("filters events by workerId, jobId, and afterCursor", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "event-store-"));
    created.push(dir);
    const store = new EventStore({ runsDir: dir });

    store.recordEvent({ eventType: "lifecycle", workerId: "w1", jobId: "j1", data: { v: 1 } });
    store.recordEvent({ eventType: "lifecycle", workerId: "w2", jobId: "j2", data: { v: 2 } });
    store.recordEvent({ eventType: "step", workerId: "w1", jobId: "j1", data: { v: 3 } });
    store.recordEvent({ eventType: "result", workerId: "w1", jobId: "j1", data: { v: 4 } });

    const forW1 = store.getEvents({ workerId: "w1" });
    expect(forW1.events.map((e) => e.cursor)).toEqual([1, 3, 4]);

    const forJ2 = store.getEvents({ jobId: "j2" });
    expect(forJ2.events.map((e) => e.cursor)).toEqual([2]);

    const afterC2 = store.getEvents({ workerId: "w1", afterCursor: 1 });
    expect(afterC2.events.map((e) => e.cursor)).toEqual([3, 4]);
  });

  it("reads past job runs from disk NDJSON files across restarts", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "event-store-"));
    created.push(dir);

    // First session: store records events
    const store1 = new EventStore({ runsDir: dir });
    store1.recordEvent({
      eventType: "lifecycle",
      workerId: "w1",
      jobId: "j-restarted",
      data: {
        lifecycle: "queued",
        role: "implementer",
        workspace: dir,
        brief: "build feature",
        created_at: new Date().toISOString()
      }
    });
    store1.recordEvent({
      eventType: "result",
      workerId: "w1",
      jobId: "j-restarted",
      data: {
        lifecycle: "succeeded",
        status: "SUCCESS",
        response: "feature built",
        duration_seconds: 1.2
      }
    });

    // Second session: new instance simulates server restart
    const store2 = new EventStore({ runsDir: dir });
    const history = await store2.readDiskHistory();
    expect(history.length).toBe(1);
    expect(history[0]!.job_id).toBe("j-restarted");
    expect(history[0]!.worker_id).toBe("w1");
    expect(history[0]!.status).toBe("succeeded");
    expect(history[0]!.result).toBe("feature built");

    const diskJob = store2.readDiskJob("j-restarted");
    expect(diskJob).toBeDefined();
    expect(diskJob!.job_id).toBe("j-restarted");
    expect(diskJob!.worker_id).toBe("w1");
    expect(diskJob!.role).toBe("implementer");
    expect(diskJob!.status).toBe("succeeded");
    expect(diskJob!.brief).toBe("build feature");
    expect(diskJob!.result).toBe("feature built");
    expect(diskJob!.duration_seconds).toBe(1.2);

    expect(store2.readDiskJob("nonexistent-job")).toBeUndefined();
  });

  it("deleteJob deletes run file from disk, purges memory events, and rejects traversal", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "event-store-"));
    created.push(dir);
    const store = new EventStore({ runsDir: dir });

    const j1 = "job-del-1";
    store.recordEvent({ eventType: "lifecycle", workerId: "w1", jobId: j1, data: { status: "queued" } });
    store.recordEvent({ eventType: "lifecycle", workerId: "w1", jobId: "other-job", data: { status: "queued" } });

    const filePath = path.join(dir, `${j1}.ndjson`);
    expect(existsSync(filePath)).toBe(true);

    const deleted = store.deleteJob(j1);
    expect(deleted).toBe(true);
    expect(existsSync(filePath)).toBe(false);

    // In-memory events purged for j1
    const remaining = store.getEvents({ jobId: j1 });
    expect(remaining.events.length).toBe(0);

    // Other jobs intact
    const other = store.getEvents({ jobId: "other-job" });
    expect(other.events.length).toBe(1);

    // Path traversal rejection
    expect(() => store.deleteJob("../outside")).toThrow(/Invalid job ID/);
    expect(() => store.deleteJob("job/nested")).toThrow(/Invalid job ID/);
  });

  it("cleanJobs filters by workspace, status, olderThanDays, and respects keep retention", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "event-store-"));
    created.push(dir);
    const store = new EventStore({ runsDir: dir });

    const makeRun = (id: string, ws: string, status: string, ageMs: number) => {
      const f = path.join(dir, `${id}.ndjson`);
      const iso = new Date(Date.now() - ageMs).toISOString();
      const content = [
        JSON.stringify({ cursor: 1, timestamp: iso, eventType: "lifecycle", workerId: "w1", jobId: id, data: { lifecycle: "queued", workspace: ws, brief: id } }),
        JSON.stringify({ cursor: 2, timestamp: iso, eventType: "lifecycle", workerId: "w1", jobId: id, data: { lifecycle: status, workspace: ws } })
      ].join("\n");
      writeFileSync(f, content, "utf8");
    };

    // 4 jobs in Project Alpha: 2 old succeeded, 1 new succeeded, 1 failed
    makeRun("alpha-old-1", "D:/code/Alpha", "succeeded", 5 * 86_400_000); // 5 days old
    makeRun("alpha-old-2", "D:/code/Alpha", "succeeded", 3 * 86_400_000); // 3 days old
    makeRun("alpha-new-3", "D:/code/Alpha", "succeeded", 10_000);         // 10s old
    makeRun("alpha-fail-4", "D:/code/Alpha", "failed", 20_000);           // 20s old
    // 1 job in Project Beta
    makeRun("beta-1", "D:/code/Beta", "succeeded", 10_000);

    // Test 1: Clean failed only in Alpha
    const res1 = await store.cleanJobs({
      workspace: "Alpha",
      status: "failed"
    });
    expect(res1.deletedCount).toBe(1);
    expect(res1.deletedJobIds).toEqual(["alpha-fail-4"]);
    expect(existsSync(path.join(dir, "alpha-fail-4.ndjson"))).toBe(false);

    // Test 2: Clean olderThanDays: 2 in Alpha
    const res2 = await store.cleanJobs({
      workspace: "Alpha",
      olderThanDays: 2
    });
    expect(res2.deletedCount).toBe(2);
    expect(res2.deletedJobIds).toContain("alpha-old-1");
    expect(res2.deletedJobIds).toContain("alpha-old-2");

    // Test 3: Keep 1 newest in Beta
    const res3 = await store.cleanJobs({
      workspace: "Beta",
      keep: 1
    });
    expect(res3.deletedCount).toBe(0); // Only 1 existed, so keep preserved it
    expect(existsSync(path.join(dir, "beta-1.ndjson"))).toBe(true);

    // Clean Beta completely
    const res4 = await store.cleanJobs({
      workspace: "Beta",
      terminalOnly: true
    });
    expect(res4.deletedCount).toBe(1);
    expect(res4.deletedJobIds).toEqual(["beta-1"]);
    expect(existsSync(path.join(dir, "beta-1.ndjson"))).toBe(false);
  });
});
