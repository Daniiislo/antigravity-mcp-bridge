import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = path.join(root, "scripts", "fixtures", "fake-agy.mjs");
const runsDir = mkdtempSync(path.join(tmpdir(), "agy-smoke-"));
const env = Object.fromEntries(Object.entries(process.env).filter((entry) => entry[1] !== undefined));
Object.assign(env, {
  AGY_TOOLSET: "core",
  AGY_BIN: process.execPath,
  AGY_BASE_ARGS_JSON: JSON.stringify([fixture]),
  AGY_ALLOWED_ROOTS: root,
  AGY_DEFAULT_INACTIVITY_TIMEOUT_SECONDS: "5",
  AGY_RUNS_DIR: runsDir
});

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(root, "dist", "index.js")],
  cwd: root,
  env,
  stderr: "pipe"
});
const client = new Client({ name: "antigravity-bridge-smoke", version: "0.1.0" });

try {
  await client.connect(transport);

  // 1. Verify the core toolset is registered (legacy tools are hidden by default)
  const listed = await client.listTools();
  const names = listed.tools.map((tool) => tool.name).sort();
  const expected = [
    "agy_events",
    "agy_history",
    "cancel_task",
    "close_worker",
    "create_worker",
    "dispatch_task",
    "inspect_task",
    "list_models",
    "open_dashboard",
    "runtime_info",
    "send_followup",
    "wait_task"
  ].sort();
  if (JSON.stringify(names) !== JSON.stringify(expected)) {
    throw new Error(`unexpected tools: ${JSON.stringify(names)} vs expected: ${JSON.stringify(expected)}`);
  }

  const runtime = await client.callTool({ name: "runtime_info", arguments: {} });
  if (runtime.isError || runtime.structuredContent?.wait_mode !== "terminal" || !runtime.structuredContent?.build_id) {
    throw new Error("Runtime identity does not match terminal-wait build");
  }

  // 2. Call list_models
  const modelsRes = await client.callTool({
    name: "list_models",
    arguments: {}
  });
  if (modelsRes.isError || !modelsRes.structuredContent?.models) {
    throw new Error(`list_models failed: ${JSON.stringify(modelsRes)}`);
  }

  // 3. Controller lifecycle: create_worker -> dispatch_task -> one terminal wait -> close_worker
  const workerRes = await client.callTool({
    name: "create_worker",
    arguments: {
      role: "implementer",
      workspace: root,
      constraints: "Smoke test constraint"
    }
  });
  if (workerRes.isError || !workerRes.structuredContent?.workerId) {
    throw new Error(`create_worker failed: ${JSON.stringify(workerRes)}`);
  }
  const workerId = workerRes.structuredContent.workerId;

  const dispatchRes = await client.callTool({
    name: "dispatch_task",
    arguments: {
      worker_id: workerId,
      brief: "smoke test async task"
    }
  });
  if (dispatchRes.isError || !dispatchRes.structuredContent?.jobId) {
    throw new Error(`dispatch_task failed: ${JSON.stringify(dispatchRes)}`);
  }
  const jobId = dispatchRes.structuredContent.jobId;

  const waitRes = await client.callTool({
    name: "wait_task",
    arguments: {
      job_id: jobId,
      wait_ms: 5000
    }
  });
  if (
    waitRes.isError ||
    !waitRes.structuredContent?.terminal ||
    waitRes.structuredContent?.status !== "succeeded" ||
    !String(waitRes.structuredContent?.result ?? "").includes("smoke test async task")
  ) {
    throw new Error(`wait_task failed: ${JSON.stringify(waitRes)}`);
  }

  const closeRes = await client.callTool({
    name: "close_worker",
    arguments: { worker_id: workerId }
  });
  if (closeRes.isError || closeRes.structuredContent?.status !== "closed") {
    throw new Error(`close_worker failed: ${JSON.stringify(closeRes)}`);
  }

  // 5. Dashboard tool: open_dashboard
  const dashRes = await client.callTool({
    name: "open_dashboard",
    arguments: {}
  });
  if (dashRes.isError || !dashRes.structuredContent?.dashboard_url || dashRes.structuredContent?.read_only !== true) {
    throw new Error(`open_dashboard failed: ${JSON.stringify(dashRes)}`);
  }

  if (runtime.structuredContent?.toolset !== "core") {
    throw new Error(`expected core toolset, got ${runtime.structuredContent?.toolset}`);
  }

  // 6. Full toolset (opt-in): legacy tools agy_delegate and delete_task
  const fullClient = new Client({ name: "antigravity-bridge-smoke-full", version: "0.1.0" });
  const fullTransport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, "dist", "index.js")],
    cwd: root,
    env: { ...env, AGY_TOOLSET: "full" },
    stderr: "pipe"
  });
  try {
    await fullClient.connect(fullTransport);
    const fullNames = (await fullClient.listTools()).tools.map((tool) => tool.name);
    if (fullNames.length !== 18) throw new Error(`expected 18 tools in full toolset, got ${fullNames.length}`);
    const delegateRes = await fullClient.callTool({
      name: "agy_delegate",
      arguments: { role: "implementer", task: "smoke", cwd: root, timeoutSeconds: 5 }
    });
    if (delegateRes.isError || delegateRes.structuredContent?.response !== "reply:smoke:accept-edits") {
      throw new Error(`unexpected delegation result: ${JSON.stringify(delegateRes)}`);
    }
    const delRes = await fullClient.callTool({ name: "delete_task", arguments: { job_id: jobId } });
    if (delRes.isError || !delRes.structuredContent?.success) {
      throw new Error(`delete_task failed: ${JSON.stringify(delRes)}`);
    }
  } finally {
    await fullClient.close();
  }

  process.stdout.write("MCP smoke test passed: 12 core tools verified, runtime identity, async worker lifecycle (create/dispatch/single-wait/close), open_dashboard, and the full toolset (agy_delegate, delete_task) completed.\n");
} finally {
  await client.close();
  rmSync(runsDir, { recursive: true, force: true });
}
