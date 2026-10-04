import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = path.join(root, "scripts", "fixtures", "fake-agy.mjs");
const env = Object.fromEntries(Object.entries(process.env).filter((entry) => entry[1] !== undefined));
Object.assign(env, {
  AGY_BIN: process.execPath,
  AGY_BASE_ARGS_JSON: JSON.stringify([fixture]),
  AGY_ALLOWED_ROOTS: root,
  AGY_DEFAULT_TIMEOUT_SECONDS: "5"
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

  // 1. Verify all 14 tools are registered
  const listed = await client.listTools();
  const names = listed.tools.map((tool) => tool.name).sort();
  const expected = [
    "agy_delegate",
    "agy_events",
    "agy_history",
    "agy_reset",
    "agy_status",
    "agy_stop",
    "cancel_task",
    "close_worker",
    "create_worker",
    "dispatch_task",
    "inspect_task",
    "list_models",
    "send_followup",
    "wait_task"
  ].sort();
  if (JSON.stringify(names) !== JSON.stringify(expected)) {
    throw new Error(`unexpected tools: ${JSON.stringify(names)} vs expected: ${JSON.stringify(expected)}`);
  }

  // 2. Call list_models
  const modelsRes = await client.callTool({
    name: "list_models",
    arguments: {}
  });
  if (modelsRes.isError || !modelsRes.structuredContent?.models) {
    throw new Error(`list_models failed: ${JSON.stringify(modelsRes)}`);
  }

  // 3. Controller lifecycle: create_worker -> dispatch_task -> wait_task -> inspect_task -> close_worker
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
  if (waitRes.isError || !waitRes.structuredContent?.terminal) {
    throw new Error(`wait_task failed: ${JSON.stringify(waitRes)}`);
  }

  const inspectRes = await client.callTool({
    name: "inspect_task",
    arguments: { job_id: jobId }
  });
  if (inspectRes.isError || inspectRes.structuredContent?.status !== "succeeded") {
    throw new Error(`inspect_task failed: ${JSON.stringify(inspectRes)}`);
  }

  const closeRes = await client.callTool({
    name: "close_worker",
    arguments: { worker_id: workerId }
  });
  if (closeRes.isError || closeRes.structuredContent?.status !== "closed") {
    throw new Error(`close_worker failed: ${JSON.stringify(closeRes)}`);
  }

  // 4. Compatibility tool: agy_delegate
  const delegateRes = await client.callTool({
    name: "agy_delegate",
    arguments: { role: "implementer", task: "smoke", cwd: root, timeoutSeconds: 5 }
  });
  if (delegateRes.isError || delegateRes.structuredContent?.response !== "reply:smoke:accept-edits") {
    throw new Error(`unexpected delegation result: ${JSON.stringify(delegateRes)}`);
  }

  process.stdout.write("MCP smoke test passed: all 14 tools verified, async worker lifecycle (create/dispatch/wait/inspect/close) and compatibility delegation completed.\n");
} finally {
  await client.close();
}
