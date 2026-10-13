#!/usr/bin/env node
// Offline aggregate only: no prompts, commands, response text, credentials or agent calls.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { loadConfig } from "../dist/config.js";

const directory = process.argv[2] ?? loadConfig(process.env).runsDir;
const rows = [];
for (const name of readdirSync(directory).filter(name => name.endsWith(".ndjson"))) {
  const file = path.join(directory, name);
  if (statSync(file).size > 32 * 1024 * 1024) continue;
  const steps = new Map();
  let queued, started, finished, status = "unknown", terminalUsage;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    const data = event.data ?? {};
    if (event.eventType === "lifecycle") {
      if (data.lifecycle === "queued") queued = data.created_at ?? event.timestamp;
      if (data.lifecycle === "started") started = data.started_at ?? event.timestamp;
      if (["succeeded", "failed", "canceled"].includes(data.lifecycle)) {
        finished = data.finished_at ?? event.timestamp;
        status = data.lifecycle;
        terminalUsage = data.usage;
      }
    }
    if (event.eventType === "step" && data.state === "DONE" && Number.isInteger(data.step_index)) steps.set(data.step_index, data);
  }
  const model = [...steps.values()].filter(step => step.step_type === "agent_response");
  const tools = [...steps.values()].filter(step => step.step_type === "tool" || step.step_type === "tool_use");
  const sum = (items, value) => items.reduce((total, item) => total + (Number.isFinite(value(item)) ? value(item) : 0), 0);
  const seconds = (a, b) => a && b ? Math.max(0, (Date.parse(b) - Date.parse(a)) / 1000) : null;
  rows.push({ job_id: name.replace(/\.ndjson$/, ""), status, queue_seconds: seconds(queued, started), active_seconds: seconds(started, finished), total_seconds: seconds(queued, finished), model_steps: model.length, tool_steps: tools.length, model_seconds_sum: sum(model, step => step.duration_seconds), tool_seconds_sum: sum(tools, step => step.duration_seconds), observed_model_tokens: model.some(step => Number.isFinite(step.usage?.total_tokens)) ? sum(model, step => step.usage?.total_tokens) : null, observed_cache_read_tokens: model.some(step => Number.isFinite(step.usage?.cache_read_tokens)) ? sum(model, step => step.usage?.cache_read_tokens) : null, terminal_turn_tokens: terminalUsage?.total_tokens ?? null });
}
console.log(JSON.stringify({ note: "Duration sums may overlap. Streamed usage is observed, not a cost invoice. Missing counters remain unknown.", jobs: rows }, null, 2));
