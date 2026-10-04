import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { AgyWorker } from "../src/agy-worker.js";

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "fixtures", "fake-agy.mjs");
const workers: AgyWorker[] = [];

function createWorker(mode: "accept-edits" | "plan" = "accept-edits") {
  const worker = new AgyWorker({
    role: mode === "plan" ? "tester" : "implementer",
    cwd: process.cwd(), executable: process.execPath, prefixArgs: [fixture], mode,
    defaultTimeoutMs: 1_000, maxStderrBytes: 1_024, sandbox: false,
    dangerouslySkipPermissions: false
  });
  workers.push(worker);
  return worker;
}

afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.stop()));
});

describe("AgyWorker", () => {
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
    ["MALFORMED", /invalid NDJSON/i],
    ["EXIT", /exited/i]
  ])("invalidates the process after %s", async (prompt, expected) => {
    const worker = createWorker();
    await expect(worker.delegate(prompt)).rejects.toThrow(expected);
    expect(worker.status().state).toBe("stopped");
    const recovered = await worker.delegate("recovered");
    expect(recovered.response).toBe("reply:recovered:accept-edits");
  });

  it("terminates a timed-out process so a late result cannot match the next call", async () => {
    const worker = createWorker();
    await expect(worker.delegate("HANG", 30)).rejects.toThrow(/timed out/i);
    expect(worker.status().state).toBe("stopped");
    expect((await worker.delegate("fresh")).numTurns).toBe(1);
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
