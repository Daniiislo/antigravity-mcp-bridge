#!/usr/bin/env node
// Scaled transport replay using the local fake CLI; no paid model or AGY executable.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WorkerManager } from "../dist/worker-manager.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = path.join(root, "scripts", "fixtures", "fake-agy.mjs");
async function replay(polling) {
  const runsDir = mkdtempSync(path.join(tmpdir(), "agy-wait-benchmark-"));
  const manager = new WorkerManager({ executable: process.execPath, allowedRoots: [root], sandbox: false, dangerouslySkipPermissions: false, defaultTimeoutMs: 2000, maxStderrBytes: 1024 }, [fixture], { runsDir });
  try {
    const worker = await manager.createWorker({ role: "tester", workspace: root });
    const job = await manager.dispatchTask(worker.workerId, "DELAY:400:benchmark");
    const start = performance.now();
    let results = 0, characters = 0;
    let terminal;
    if (polling) {
      do {
        terminal = await manager.waitTask(job.jobId, { waitMs: 50 });
        results++;
        characters += JSON.stringify(terminal).length;
      } while (!terminal.terminal);
      terminal = manager.inspectTask(job.jobId);
      results++;
      characters += JSON.stringify(terminal).length;
    } else {
      terminal = await manager.waitTaskUntilTerminal(job.jobId);
      results = 1;
      characters = JSON.stringify(terminal).length;
    }
    return { result_calls: results, payload_characters: characters, wall_ms: Math.round(performance.now() - start), status: terminal.status, worker_tokens: terminal.usage?.total_tokens ?? null };
  } finally { await manager.stop(); rmSync(runsDir, { recursive: true, force: true }); }
}
console.log(JSON.stringify({ boundary: "Scaled fake-CLI transport comparison only; result calls are potential controller wake-ups. Does not measure real model tokens or AGY speed.", bounded_wait_plus_inspection: await replay(true), single_terminal_wait: await replay(false) }, null, 2));
