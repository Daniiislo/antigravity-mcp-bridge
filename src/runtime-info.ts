import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { BridgeConfig } from "./config.js";

export function runtimeInfo(config: BridgeConfig) {
  const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
  const hash = createHash("sha256");
  for (const name of ["server", "worker-manager", "agy-worker", "config", "task-aware-server", "event-store", "job-activity", "process-tree", "preflight"]) {
    hash.update(readFileSync(new URL(`./${name}.${extension}`, import.meta.url)));
  }
  return {
    build_id: hash.digest("hex").slice(0, 16),
    wait_mode: "terminal",
    inactivity_seconds: config.defaultTimeoutMs / 1_000,
    maximum_turn_seconds: (config.maxTurnTimeoutMs ?? 1_800_000) / 1_000,
    steps_budget: config.maxSteps ?? null,
    observed_token_budget: config.maxTurnTokens ?? null,
    allowed_roots: config.allowedRoots,
    add_dirs: config.addDirs ?? [],
    toolset: config.toolset ?? "core",
    tasks_capability_gated: true
  };
}
