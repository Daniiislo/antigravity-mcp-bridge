import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { loadConfig, type BridgeConfig } from "../src/config.js";
import { hostWarnings, parseCodexConfig } from "../src/host-check.js";
import { createServer } from "../src/server.js";
import { WORKER_RULES, WorkerManager } from "../src/worker-manager.js";

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "fixtures", "fake-agy.mjs");

const tempDirs: string[] = [];
const managers: WorkerManager[] = [];
const closers: Array<() => Promise<void>> = [];
const savedEnv: Record<string, string | undefined> = {};

function setEnv(name: string, value: string | undefined) {
  if (!(name in savedEnv)) savedEnv[name] = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

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
  return mgr;
}

async function connect(mgr: WorkerManager, clientName = "test-client", progressIntervalMs?: number) {
  const server = createServer(mgr, progressIntervalMs === undefined ? {} : { progressIntervalMs });
  const [t1, t2] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: clientName, version: "1.0.0" });
  await server.connect(t1);
  await client.connect(t2);
  closers.push(async () => { await client.close(); await server.close(); });
  return client;
}

const text = (res: unknown) => ((res as { content: Array<{ text: string }> }).content[0]!.text);

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  for (const m of managers.splice(0)) await m.stop();
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("Codex config parsing", () => {
  it("reads an inline direct-only list and ignores comments", () => {
    const summary = parseCodexConfig(`
model = "x"
[features.code_mode]  # code mode
direct_only_tool_namespaces = ["mcp__other", 'mcp__antigravity_bridge'] # trailing
`);
    expect(summary.directOnlyNamespaces).toEqual(["mcp__other", "mcp__antigravity_bridge"]);
  });

  it("reads a multi-line array with comments and brackets inside strings", () => {
    const summary = parseCodexConfig([
      "[features.code_mode]",
      "direct_only_tool_namespaces = [",
      "  \"mcp__a]b\", # bracket in a string",
      "  # a comment line",
      "  \"mcp__antigravity_bridge\",",
      "]",
      "[other]",
      "direct_only_tool_namespaces = [\"ignored\"]"
    ].join("\n"));
    expect(summary.directOnlyNamespaces).toEqual(["mcp__a]b", "mcp__antigravity_bridge"]);
  });

  it("accepts the dotted-key form and reports absence", () => {
    expect(parseCodexConfig('features.code_mode.direct_only_tool_namespaces = ["mcp__x"]').directOnlyNamespaces).toEqual(["mcp__x"]);
    expect(parseCodexConfig("[features]\ncode_mode = true\n").directOnlyNamespaces).toBeUndefined();
    expect(parseCodexConfig("").servers).toEqual([]);
  });

  it("collects server command, args and tool timeout, including quoted table names", () => {
    const summary = parseCodexConfig([
      "[mcp_servers.antigravity-bridge]",
      "command = \"node\"",
      "args = [\"/x/dist/index.js\"]",
      "tool_timeout_sec = 3_600",
      "[mcp_servers.\"my server\"]",
      "command = 'other'"
    ].join("\n"));
    expect(summary.servers).toEqual([
      { name: "antigravity-bridge", command: "node", args: ["/x/dist/index.js"], toolTimeoutSec: 3600 },
      { name: "my server", command: "other", args: [] }
    ]);
  });
});

describe("host self-check", () => {
  function codexHome(config: string | undefined) {
    const home = mkdtempSync(path.join(tmpdir(), "agy-codex-home-"));
    tempDirs.push(home);
    if (config !== undefined) writeFileSync(path.join(home, "config.toml"), config);
    return { CODEX_HOME: home } as NodeJS.ProcessEnv;
  }

  it("warns Codex clients whose config lacks the direct-only namespace", () => {
    const warnings = hostWarnings({ clientName: "codex-mcp-client", env: codexHome("[features]\n") });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('direct_only_tool_namespaces = ["mcp__antigravity_bridge"]');
    expect(warnings[0]).toContain("Host configuration");
  });

  it("stays silent when the namespace is listed under the default or a renamed server", () => {
    expect(hostWarnings({ clientName: "Codex", env: codexHome('[features.code_mode]\ndirect_only_tool_namespaces = ["mcp__antigravity_bridge"]') })).toEqual([]);
    expect(hostWarnings({ clientName: "Codex", env: codexHome('[features.code_mode]\ndirect_only_tool_namespaces = ["mcp__my_antigravity"]') })).toEqual([]);
  });

  it("never warns or throws for other clients, a missing file, or an unreadable file", () => {
    expect(hostWarnings({ clientName: "some-other-host", env: codexHome("") })).toEqual([]);
    expect(hostWarnings({ clientName: undefined, env: codexHome("") })).toEqual([]);
    expect(hostWarnings({ clientName: "codex", env: codexHome(undefined) })).toEqual([]);
    expect(hostWarnings({ clientName: "codex", env: {}, reader: () => { throw new Error("denied"); } })).toEqual([]);
  });

  it("warns about a registered bridge server with a short or unset tool timeout", () => {
    const direct = '[features.code_mode]\ndirect_only_tool_namespaces = ["mcp__antigravity_bridge"]\n';
    const unset = hostWarnings({ clientName: "codex", env: codexHome(`${direct}[mcp_servers.antigravity-bridge]\ncommand = "node"\nargs = ["/p/antigravity-mcp-bridge/dist/index.js"]\n`) });
    expect(unset).toHaveLength(1);
    expect(unset[0]).toContain("tool_timeout_sec");
    expect(hostWarnings({ clientName: "codex", env: codexHome(`${direct}[mcp_servers.antigravity-bridge]\ncommand = "node"\nargs = ["/p/antigravity-mcp-bridge/dist/index.js"]\ntool_timeout_sec = 3600\n`) })).toEqual([]);
    expect(hostWarnings({ clientName: "codex", env: codexHome(`${direct}[mcp_servers.unrelated]\ncommand = "node"\nargs = ["server.js"]\n`) })).toEqual([]);
  });

  it("warns Claude Code clients only when a timeout variable is set below the job budget", () => {
    expect(hostWarnings({ clientName: "claude-code", env: {}, budgetSeconds: 1_800 })).toEqual([]);
    expect(hostWarnings({ clientName: "claude-code", env: { MCP_TOOL_TIMEOUT: "86400000", CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT: "3600000" }, budgetSeconds: 1_800 })).toEqual([]);
    const low = hostWarnings({ clientName: "claude-code", env: { MCP_TOOL_TIMEOUT: "300000", CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT: "60000" }, budgetSeconds: 1_800 });
    expect(low).toHaveLength(2);
    expect(low[0]).toContain("MCP_TOOL_TIMEOUT=300000");
    expect(low[1]).toContain("CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT");
  });

  it("surfaces host warnings once in the first dispatch-like response and always in runtime_info", async () => {
    setEnv("CODEX_HOME", codexHome("[features]\n").CODEX_HOME);
    const mgr = makeManager();
    const client = await connect(mgr, "codex-client");

    const info = await client.callTool({ name: "runtime_info", arguments: {} });
    expect((info.structuredContent as { host_warnings: string[] }).host_warnings).toHaveLength(1);

    const created = await client.callTool({ name: "create_worker", arguments: { role: "implementer", workspace: process.cwd() } });
    expect(text(created)).toContain("HOST WARNING");
    const workerId = (created.structuredContent as { workerId: string }).workerId;
    const dispatched = await client.callTool({ name: "dispatch_task", arguments: { worker_id: workerId, brief: "CLEAN" } });
    expect(text(dispatched)).not.toContain("HOST WARNING");

    const again = await client.callTool({ name: "runtime_info", arguments: {} });
    expect((again.structuredContent as { host_warnings: string[] }).host_warnings).toHaveLength(1);
  });

  it("reports no host warnings for unknown clients", async () => {
    const client = await connect(makeManager(), "plain-client");
    const info = await client.callTool({ name: "runtime_info", arguments: {} });
    expect((info.structuredContent as { host_warnings: string[] }).host_warnings).toEqual([]);
  });
});

describe("dispatch and follow-up with wait: true", () => {
  it("returns the wait_task result in one call", async () => {
    const mgr = makeManager();
    const client = await connect(mgr);
    const worker = await mgr.createWorker({ role: "implementer", workspace: process.cwd() });

    const dispatched = await client.callTool({ name: "dispatch_task", arguments: { worker_id: worker.workerId, brief: "RESPONSE_CHARS:200", wait: true } });
    const structured = dispatched.structuredContent as Record<string, unknown>;
    expect(structured.terminal).toBe(true);
    expect(structured.status).toBe("succeeded");
    expect(structured.tool_activity).toMatchObject({ files_changed: ["src/example.ts"] });
    expect(text(dispatched)).toContain("finished with status succeeded");

    const followup = await client.callTool({ name: "send_followup", arguments: { worker_id: worker.workerId, finding: "RESPONSE_CHARS:50", wait: true } });
    expect((followup.structuredContent as { terminal: boolean }).terminal).toBe(true);

    const plain = await client.callTool({ name: "dispatch_task", arguments: { worker_id: worker.workerId, brief: "RESPONSE_CHARS:10" } });
    expect(plain.structuredContent).toHaveProperty("jobId");
    expect(plain.structuredContent).not.toHaveProperty("terminal");
  });

  it("keeps the job running when the host aborts the call, and flags the repeated wait", async () => {
    const mgr = makeManager();
    const client = await connect(mgr);
    const worker = await mgr.createWorker({ role: "implementer", workspace: process.cwd() });

    const controller = new AbortController();
    const first = client.callTool({ name: "dispatch_task", arguments: { worker_id: worker.workerId, brief: "DELAY:600:slow", wait: true } }, { signal: controller.signal });
    setTimeout(() => controller.abort(), 150);
    await expect(first).rejects.toBeDefined();

    const jobId = (await mgr.getHistory({ limit: 1 })).jobs[0]!.job_id;
    expect(jobId).toMatch(/^job-/);
    expect(mgr.isRepeatedWait(jobId)).toBe(true);
    const second = await client.callTool({ name: "wait_task", arguments: { job_id: jobId } });
    expect((second.structuredContent as { status: string }).status).toBe("succeeded");
    expect(text(second)).toContain("Host configuration");
  });
});

describe("progress keepalive", () => {
  it("sends increasing progress notifications while waiting when the caller gave a token", async () => {
    const mgr = makeManager();
    const client = await connect(mgr, "test-client", 40);
    const worker = await mgr.createWorker({ role: "implementer", workspace: process.cwd() });
    const job = await mgr.dispatchTask(worker.workerId, "DELAY:500:slow");

    const seen: Array<{ progress: number; total?: number | undefined; message?: string | undefined }> = [];
    const res = await client.callTool({ name: "wait_task", arguments: { job_id: job.jobId } }, { onprogress: (p) => { seen.push(p); } });
    expect(seen.length).toBeGreaterThanOrEqual(3);
    expect(seen.map((p) => p.progress)).toEqual([...seen.map((p) => p.progress)].sort((a, b) => a - b));
    expect(new Set(seen.map((p) => p.progress)).size).toBe(seen.length);
    expect(seen.every((p) => p.total === undefined && (p.message ?? "").length <= 160)).toBe(true);
    expect(JSON.stringify(res.structuredContent)).not.toContain("progressToken");

    const settled = seen.length;
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(seen.length).toBe(settled);
  });

  it("sends nothing without a progress token", async () => {
    const mgr = makeManager();
    const server = createServer(mgr, { progressIntervalMs: 40 });
    const notifications: string[] = [];
    const [t1, t2] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "1.0.0" });
    client.fallbackNotificationHandler = async (notification) => { notifications.push(notification.method); };
    await server.connect(t1);
    await client.connect(t2);
    closers.push(async () => { await client.close(); await server.close(); });

    const worker = await mgr.createWorker({ role: "implementer", workspace: process.cwd() });
    const job = await mgr.dispatchTask(worker.workerId, "DELAY:300:slow");
    await client.callTool({ name: "wait_task", arguments: { job_id: job.jobId } });
    expect(notifications.filter((m) => m === "notifications/progress")).toEqual([]);
  });
});

describe("lean worker contract", () => {
  it("appends the rules before [Task] and keeps the brief verbatim", async () => {
    const mgr = makeManager();
    const worker = await mgr.createWorker({ role: "implementer", workspace: process.cwd(), constraints: "No git commits" });
    const job = await mgr.dispatchTask(worker.workerId, "CLEAN");
    await mgr.waitTask(job.jobId, { waitMs: 3_000 });
    const prompt = mgr.inspectTask(job.jobId, { includePrompt: true }).effective_prompt!;
    expect(prompt).toBe(`[Constraints]\nNo git commits\n\n${WORKER_RULES}\n\n[Task]\nCLEAN`);
    expect(WORKER_RULES.length).toBeLessThan(450);
    expect(mgr.inspectTask(job.jobId, { includePrompt: true }).brief).toBe("CLEAN");
  });

  it("can be disabled, restoring the raw brief", async () => {
    const mgr = makeManager({ workerRules: false });
    const worker = await mgr.createWorker({ role: "implementer", workspace: process.cwd() });
    const job = await mgr.dispatchTask(worker.workerId, "CLEAN");
    await mgr.waitTask(job.jobId, { waitMs: 3_000 });
    expect(mgr.inspectTask(job.jobId, { includePrompt: true }).effective_prompt).toBe("CLEAN");
  });

  it("reads AGY_WORKER_RULES from the environment", () => {
    const base = { AGY_ALLOWED_ROOTS: process.cwd() };
    const options = { resolveExecutable: false, homeDirectory: process.cwd() };
    expect(loadConfig(base, process.cwd(), options).workerRules).toBe(true);
    expect(loadConfig({ ...base, AGY_WORKER_RULES: "off" }, process.cwd(), options).workerRules).toBe(false);
    expect(loadConfig({ ...base, AGY_WORKER_RULES: "on" }, process.cwd(), options).workerRules).toBe(true);
    expect(() => loadConfig({ ...base, AGY_WORKER_RULES: "maybe" }, process.cwd(), options)).toThrow(/AGY_WORKER_RULES/);
  });
});

describe("controller context budget", () => {
  // Budgets are the measured size after the token-efficiency work plus ~10%.
  const TOOL_CHARS_BUDGET = 13_200;
  const INSTRUCTIONS_BUDGET = 3_300;
  const PAYLOAD_BUDGET = 4_000;

  it("keeps tools/list and server instructions within budget", async () => {
    const client = await connect(makeManager());
    const { tools } = await client.listTools();
    const toolChars = tools.reduce((sum, tool) => sum + (tool.description ?? "").length + JSON.stringify(tool.inputSchema ?? {}).length, 0);
    const instructions = client.getInstructions() ?? "";
    expect(toolChars, `tools/list description+schema chars=${toolChars} (budget ${TOOL_CHARS_BUDGET}); instructions chars=${instructions.length} (budget ${INSTRUCTIONS_BUDGET})`).toBeLessThanOrEqual(TOOL_CHARS_BUDGET);
    expect(instructions.length, `instructions chars=${instructions.length} (budget ${INSTRUCTIONS_BUDGET})`).toBeLessThanOrEqual(INSTRUCTIONS_BUDGET);
  });

  it("keeps a typical succeeded wait_task payload small", async () => {
    const mgr = makeManager();
    const client = await connect(mgr);
    const worker = await mgr.createWorker({ role: "implementer", workspace: process.cwd() });
    const res = await client.callTool({ name: "dispatch_task", arguments: { worker_id: worker.workerId, brief: "RESPONSE_CHARS:1000", wait: true } });
    const structured = res.structuredContent as { caller_payload_chars: number; result: string };
    expect(structured.result).toHaveLength(1000);
    expect(structured.caller_payload_chars, `terminal payload chars=${structured.caller_payload_chars} (budget ${PAYLOAD_BUDGET})`).toBeLessThanOrEqual(PAYLOAD_BUDGET);
  });
});
