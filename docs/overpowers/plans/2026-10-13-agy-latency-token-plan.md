# AGY Latency and Token Reduction — Proposed Plan

Status: owner approved the complete bridge/Overpowers scope and solo-native execution on 2026-10-13. Implementation and native verification completed; live AGY speed and host negotiation claims remain unverified.

## Requirements

Total worker and controller token consumption is a P0 constraint. Preserve the single-wakeup intent of commits `21dd8b8`, `8fc9548`, and `2a965d4`, and the process safety from `b05cbba`. Work solo without AGY MCP or subagents. A shorter failed run is not evidence of faster useful completion.

## Evidence and uncertainty

- Remote/local HEAD is `b05cbba`; the subsequent source changes remain uncommitted.
- Source uses terminal waiting while the configured `dist/server.js` still uses heartbeat waiting. The local host configuration is already changed to 660 seconds and the worker default cap to 600 seconds.
- The one available persisted review run reports 173.6 seconds, 92 step updates, 62 distinct step indices, 30 model responses, 30 completed tools, 85,814 total tokens and 749,044 cache-read tokens. Model durations sum to 127.1 seconds and tool durations to 48.1 seconds; these may overlap and must not be added as wall time.
- The review was routed to an implementer and probed unavailable validation tools serially.
- Queue waiting is outside the worker turn deadline. No dispatch idempotency key protects an uncertain retry.
- CLI help supports project binding and disabling slash-command expansion, but does not advertise native token/step limits. Stream event guards cannot prevent tokens already consumed upstream.
- Current evidence does not establish the cause of every historical 15–30 minute task, real host Tasks negotiation, or the performance benefit of fixed 48-step/60k-token limits and low tester effort.

### EngSpeak session evidence

Read through Codex `read_thread`, without invoking AGY MCP:

- `01a11181-cce2-7281-849e-317af9463485`: three backend turns waited 894.9, 896.6 and 895.4 seconds. Session diagnostics reported 237 step updates at the 900-second worker ceiling, while Codex allowed a 3600-second tool call. Historical source at `2a965d4` confirms a fixed 900-second default worker timer.
- `01a11bcf-264d-7c73-a38d-3f7bcc200d74`: waits of 1197.7 and 1796.0 seconds occurred after explicit 1200/1800-second worker limits. Follow-up reports describe timeout during red integration tests and broad verification. Raising the ceiling did not establish faster useful completion.
- `01a10c82-1323-7680-a1b4-bc2f5925cb24`: the controller found an E2E spec already created after an observation timeout; this demonstrates why an expired waiter must not be treated as permission to restart work.

Wait durations are observations of tool calls, not by themselves proof of worker failure. Historical source and recorded diagnostics support the fixed worker-ceiling conclusion for the cited cases. Some session outputs are truncated and deleted run logs are not presently available as standalone files; do not infer complete token totals for those historical jobs.

Large briefs combined multiple implementation phases, predecessor/successor document discovery, TDD and broad verification. Even narrower follow-ups repeated discovery. The old invalidation path discarded conversation context, undermining instructions to continue in the same conversation. The process/conversation hardening in `b05cbba` must be preserved.

## Batch 1 — Runtime consistency and observation

Inspect and reconcile the uncommitted amendment against tested behavior. Build only the accepted source snapshot. Expose a compact runtime identity/config fingerprint once, without secrets, and verify the configured executable uses it after restart. Retain capability-gated Tasks and single terminal fallback waiting. Verify host timeout and queue assumptions; document that Tasks support in code does not prove host use.

Acceptance: source, build and running process agree; no fixed model heartbeat; waiter interruption does not cancel the job; terminal result contains the compact handoff; process cleanup/recovery regressions remain covered.

## Batch 2 — Queue deadlines and retry identity

Define a total job deadline from dispatch, distinct from active-turn inactivity. When a queued job expires, remove it and produce a compact terminal reason without starting AGY. When an active job expires, use the existing confirmed tree-cleanup path. Keep user-chosen timing explicit in the API and set waiter timeout above the total job deadline plus cleanup margin.

Add an optional caller request key with exact worker/task/options matching. The same key and payload returns the same job; a conflicting payload fails. Persist enough identity to distinguish a completed job from an orphan after restart. Never imply that a persisted running job is still live.

Acceptance: queue plus execution cannot silently exceed the configured total budget; duplicate dispatch does not start a second turn; waiter timeout recovery reuses the original job; cross-worker keys and restart behavior have explicit tests.

## Batch 3 — Fewer AGY model/tool cycles

Validate project-binding arguments against fresh and resumed stream sessions before adoption. Collect only task-relevant environment capabilities using bounded read-only checks, without launching an agent or probing every installed tool. Pass exact native verification commands and workspace in compact briefs. Batch independent deterministic checks where their exit statuses remain individually visible. Make role selection explicit and require missing required tooling to produce a useful blocked handoff.

Do not silently remove mandatory checks or project rules. Do not change model/effort defaults without comparative useful-result evidence. Separate prompt guidance from hard enforcement in documentation.

Require a compact recovery checkpoint at a meaningful handoff: snapshot, changed files, completed checks, current command and remaining finding. Reuse the existing plan/checkpoint rather than introducing another verbose ledger. Provide exact file and command references so a resumed turn need not rediscover predecessor designs. Instrument test/tool duration separately; an individual test command needs a bounded runner policy where supported, with a truthful incomplete-check handoff rather than consuming the entire AGY turn.

Acceptance: a representative missing-tool scenario avoids the historical serial fallback chain; checks stay within scope; conversation resume and role isolation work; fewer model/tool cycles preserve the required verdict quality.

## Batch 4 — Budget correctness and measurement

Before shipping the pending budget code, handle repeated DONE events, absent step indices, final-result boundaries, unknown usage baselines and cache-read accounting. Describe enforcement as observed usage with possible overshoot. Investigate native cancellation/checkpoint support before promising a graceful partial final response. Calibrate thresholds by task class instead of treating arbitrary limits as performance proof.

Use existing logs and deterministic replay first. A later paid live comparison requires owner agreement on task, model and spend; it must respect the no-AGY-MCP constraint. Record task snapshot, wall time from dispatch, queue time, active time, useful-result quality, worker total/cache-read tokens, tool failures, controller results/wake-ups and retries. Repeat only enough to distinguish noise; use the same model/configuration and comparable context conditions.

Acceptance: no hardening regressions; controller polling is eliminated under the verified transport conditions; useful-task speed and token claims are supported by matched measurements. If only ceilings or safety improved, report that narrower result.

## Overpowers companion change

Canonical repository: `C:\Users\Daniiislo\overpowers-kit`, remote `https://github.com/Daniiislo/overpowers-kit.git`, observed clean HEAD `1f7bb17` on main. Its canonical worker protocol still recommends repeated 60-second waits plus inspection, while the installed 1.1.3 cache recommends one terminal wait. The canonical team profile also recommends `agy_events` and unconditional inspection. This is a confirmed source/deployment inconsistency, distinct from controller mistakes in individual sessions.

Update canonical `plugins/overpowers/skills/personal-project-team/SKILL.md`, its worker protocol, and relevant planning guidance. Preserve mandatory project verification while adding observable task-sizing decisions: one coherent deliverable, explicit read/verification scope, budget-aware checkpoint, and recovery from the actual job/diff rather than automatic rerun. Do not impose a universal file-count limit or fragment every task; repeated context startup also costs tokens.

Align waiting instructions with the accepted bridge contract and host capability. Require history/spec continuity before successor changes. Distinguish transport interruption, worker timeout, missing tooling and test-runner delay. Add pressure scenarios for oversized implementation briefs, missing tools, observation timeout after partial work, expensive verification, and unrelated work in a retained conversation. Respect the owner's solo instruction: report self-verification honestly and do not spawn a tester for this task.

Validate plugin structure and links using repository tooling, update version/history, commit canonical source under the owner's Overpowers commit authorization, then reinstall through the supported installer and verify installed content matches the source version. Do not patch cache copies as the durable fix. Any live latency/token claims still require measured evidence.

## Delivery

Owner agrees to scope before implementation. Implement and verify each coherent batch locally; solo verification is reported accurately as self-verification. Reuse valid checks, run broad regression gates at integration, and preserve unrelated changes. Commit/push only within the agreed delivery scope. Local Codex configuration is not part of the repository commit.

## Execution checkpoint — 2026-10-13

- Bridge: restored single terminal wait; new runtime build identity; total queue/execution deadline with queue-start race protection; identical request-key retry recovery and conflict/orphan guards; task-specific executable preflight; explicit fresh workspace binding and saved-conversation recovery; corrected observed-budget counting. Budgets are opt-in and CLI effort defaults are retained until benchmarks justify changes.
- Native gates: `npm test` 13 files / 192 tests PASS; typecheck PASS; stdio smoke PASS for 18 tools including runtime identity. No AGY MCP or subagent was used. CLI flags were verified by installed `--help` and argument/recovery fixture tests; real model behavior was not exercised.
- Scaled fake-CLI replay: bounded wait plus inspection produced 10 result calls / 2338 payload characters / 468 ms; terminal wait produced 1 call / 994 characters / 491 ms. Both produced useful fixture success and 2 fixture worker tokens. This establishes reduced transport results/payload only, not real controller tokens, AGY acceleration or cost savings.
- Offline analyzer reads the available historical run without exposing prompts/commands. Timestamp wall duration is 177.306 seconds; its older CLI duration report is 173.6 seconds. Preserve this distinction when comparing runs.
- Overpowers: canonical 1.1.4, source/cached team profile and worker protocol hashes match; installer confirms enabled. Validator checks 16 skill frontmatters, canonical marketplace, changed-skill links and assets. Five pressure scenarios were assessed by the solo controller, not an independent model.
- Runtime activation: build now matches source, local limits are inactivity 300 / total-default 600 seconds and host timeout 660. Restart/reconnect Codex is still needed for the existing long-lived MCP process and a new task to load Overpowers 1.1.4.
- Remaining evidence boundary: real host Tasks negotiation and matched real AGY latency/token improvement have not been demonstrated. No speed percentage is claimed; no arbitrary automatic effort/step/token defaults are shipped.
