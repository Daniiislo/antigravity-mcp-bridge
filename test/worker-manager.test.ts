import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { WorkerManager } from "../src/worker-manager.js";
import type { BridgeConfig } from "../src/config.js";

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "fixtures", "fake-agy.mjs");
const config: BridgeConfig = {
  executable: process.execPath,
  allowedRoots: [process.cwd()],
  sandbox: false,
  dangerouslySkipPermissions: false,
  defaultTimeoutMs: 1_000,
  maxStderrBytes: 1_024
};
const managers: WorkerManager[] = [];

function manager() {
  const value = new WorkerManager(config, [fixture]);
  managers.push(value);
  return value;
}

afterEach(async () => {
  await Promise.all(managers.splice(0).map((value) => value.stop()));
});

describe("WorkerManager", () => {
  it("isolates implementer and tester conversations and permission modes", async () => {
    const subject = manager();
    const implementer = await subject.delegate("implementer", "build", process.cwd());
    const tester = await subject.delegate("tester", "verify", process.cwd());
    expect(implementer.response).toBe("reply:build:accept-edits");
    expect(tester.response).toBe("reply:verify:plan");
    expect(tester.conversationId).not.toBe(implementer.conversationId);
  });

  it("resets one role without discarding the other role", async () => {
    const subject = manager();
    const firstImplementer = await subject.delegate("implementer", "one", process.cwd());
    const firstTester = await subject.delegate("tester", "one", process.cwd());
    await subject.reset("implementer");
    const secondImplementer = await subject.delegate("implementer", "two", process.cwd());
    const secondTester = await subject.delegate("tester", "two", process.cwd());
    expect(secondImplementer.conversationId).not.toBe(firstImplementer.conversationId);
    expect(secondTester.conversationId).toBe(firstTester.conversationId);
  });

  it("rejects a workspace outside the configured roots", async () => {
    const subject = manager();
    await expect(subject.delegate("implementer", "no", path.dirname(process.cwd()))).rejects.toThrow(/outside allowed roots/i);
  });
});
