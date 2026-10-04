# Antigravity Bridge Implementation Plan

**Goal:** Let Codex delegate, observe, stop, and reset persistent Antigravity CLI workers through a local MCP server.
**Source:** `docs/overpowers/specs/2026-10-03-antigravity-bridge-design.md`
**Architecture:** TypeScript stdio MCP server over a tested worker manager and NDJSON child-process adapter.
**Constraints:** Windows-compatible; Node 20+; no shell interpolation; bounded diagnostics; separate role sessions; account switching excluded.
**Delivery:** Local repository changes only. No Codex global MCP registration until the implementation passes verification.

### Task 1: Project and configuration boundary

**Purpose:** Establish reproducible TypeScript build/test commands and validated runtime configuration.
**Depends on:** None.
**Files/boundary:** `package.json`, `tsconfig.json`, `src/config.ts`, configuration tests.
**Behavior:** Parse environment defaults, reject invalid numbers/booleans, canonicalize allowed roots, and validate requested workspaces.
**Acceptance:** Workspace escape and sibling-prefix paths fail; valid descendants pass.
**Verification:** `npm test -- config`.
**Out of scope:** Installer and global Codex configuration.

### Task 2: Antigravity stream worker

**Purpose:** Reliably drive one long-lived `agy` stream-JSON process.
**Depends on:** Task 1.
**Files/boundary:** `src/agy-protocol.ts`, `src/agy-worker.ts`, fake CLI fixture and tests.
**Behavior:** Spawn without a shell, send one JSON user event per turn, serialize turns, parse terminal results, bound stderr, and invalidate the process after protocol/timeout/exit failures.
**Critical details:** A result belongs to exactly one queued request. Timeout or malformed stdout terminates the process to prevent response misalignment.
**Acceptance:** Multi-turn reuse, errors, timeout, and termination behavior are executable tests.
**Verification:** `npm test -- agy-worker`.
**Out of scope:** Quota/account recovery.

### Task 3: Role manager and MCP tools

**Purpose:** Expose separate implementer/tester lifecycles through Codex.
**Depends on:** Tasks 1–2.
**Files/boundary:** `src/worker-manager.ts`, `src/server.ts`, `src/index.ts`, tests.
**Interfaces and data:** Four tools exactly as specified in the design; JSON-compatible structured content plus readable text.
**Behavior:** Lazily create role workers, preserve role isolation, report status, and stop/reset safely on request or shutdown.
**Acceptance:** Tool schemas load and a local MCP client can delegate to the fake CLI.
**Verification:** `npm test`, `npm run typecheck`, `npm run build`, `npm run smoke`.
**Out of scope:** UI, HTTP, Cockpit, automatic commits.

### Task 4: Operator documentation

**Purpose:** Make installation, security choices, and Codex registration unambiguous.
**Depends on:** Task 3.
**Files/boundary:** `README.md`, `.env.example`.
**Behavior:** Document build, verification, MCP registration, tool use, role modes, and recovery limitations.
**Acceptance:** Commands match package scripts and generated artifact paths.
**Verification:** Execute documented build and smoke commands.
**Out of scope:** Enabling or switching Cockpit accounts.

## Checkpoint — 2026-10-03

- Tasks 1–4: implemented.
- Snapshot: local uncommitted files in this directory (the directory was not initialized as a Git repository).
- Verification: `npm test` → 13 passed; `npm run typecheck` → pass; `npm run build` → pass; `npm run smoke` → real stdio MCP tool discovery and fake delegation passed; `npm audit --audit-level=high` → 0 vulnerabilities.
- Controller review: fixed an explicit-stop race so queued turns cannot restart a worker after `agy_stop`; timeout recovery still starts a clean process for later queued work.
- Independent tester: not performed because the owner explicitly requested a single-agent workflow. Independent acceptance remains unverified rather than being relabeled as self-review.
- Deferred: Cockpit/account switching, durable checkpoints across MCP server restarts, and global Codex MCP registration with the owner's desired workspace allowlist.

## Controller API expansion

### Task 5: Explicit workers and asynchronous jobs

**Purpose:** Replace blocking role-only delegation as the primary API while retaining compatibility tools.
**Depends on:** Tasks 1–3.
**Files/boundary:** worker/job domain modules, manager, MCP schemas, fake CLI and tests.
**Interfaces and data:** Stable `worker_id`/`job_id`; states `queued|running|succeeded|failed|canceled`; monotonically increasing event cursors; bounded `wait_ms`.
**Behavior:** Create multiple isolated workers, dispatch immediately, serialize each worker queue, continue a worker with follow-up, inspect/cancel/close deterministically.
**Critical details:** Active cancellation kills the process and invalidates its conversation; queued cancellation does not. Constraints are applied to every worker prompt.
**Verification:** Async lifecycle tests plus MCP smoke calls for create/dispatch/wait/inspect/close.

### Task 6: Events, history, and persistent run logs

**Purpose:** Let the owner and controller observe what workers are doing.
**Depends on:** Task 5.
**Files/boundary:** event store/log writer, `agy_events`, `agy_history`, tests and README.
**Behavior:** Normalize init/step/result/stderr/lifecycle events, allocate cursor values, persist NDJSON atomically per append, poll after a cursor, and return bounded newest-first history.
**Critical details:** Do not persist environment variables; truncate oversized stderr/text fields; a logging failure is reported but does not silently change a successful agent result.
**Verification:** Cursor, filter, retention, parseability, and restart-readable history tests.

### Task 7: Model discovery

**Purpose:** Select supported Antigravity models without hard-coded names.
**Depends on:** Configuration boundary.
**Files/boundary:** model catalog command adapter, cache, MCP tool and tests.
**Behavior:** Run `agy models` without a shell, parse useful lines conservatively, cache successful results with timestamp/TTL, and preserve the previous successful cache if refresh fails.
**Verification:** fake command output, cache hit/refresh/failure tests.

## Checkpoint — Tasks 5–7 (2026-10-03)

- Tasks 5–7: implemented against updated design spec.
- Snapshot: local uncommitted files in this directory.
- Features: 10 controller tools (`list_models`, `create_worker`, `dispatch_task`, `wait_task`, `send_followup`, `inspect_task`, `cancel_task`, `close_worker`, `agy_events`, `agy_history`) plus 4 compatibility tools (`agy_delegate`, `agy_status`, `agy_stop`, `agy_reset`).
- Persistent run logs: NDJSON per run under `.antigravity-bridge/runs`, bounded sanitization, no env logging, restart-readable history.
- Model discovery: `agy models` parser, TTL cache, fallback to previous cache on refresh error.
- Verification: `npm test` → 37 passed across 6 test files; `npm run typecheck` → 0 errors; `npm run build` → passed; `npm run smoke` → verified all 14 tools, async lifecycle, and compatibility delegation.

### Task 8: Prefer bridge in personal workflow

**Purpose:** Route Antigravity project-team work through the MCP bridge, retaining one-shot CLI only as fallback.
**Depends on:** Tasks 5–7 passing integration verification.
**Files/boundary:** installed `personal-project-team/SKILL.md` and its Antigravity reference.
**Behavior:** Prefer create/dispatch/wait/inspect/follow-up/close; use `agy -p` only when MCP is unavailable or unhealthy; never claim independent verification without tester evidence.
**Verification:** skill validation and realistic routing scenarios.

## Controller API checkpoint — 2026-10-03

- Tasks 5–7: implemented through the MCP bridge itself; the initial independent test returned FAIL for real `agy models` parsing and three lifecycle edge cases.
- Fix cycle: used `create_worker`, `dispatch_task`, cursor-based `wait_task`, `inspect_task`, and `close_worker`; real-time events were observed through cursor 385.
- Final code verification: `npm test` → 44 passed; `npm run typecheck` → pass; `npm run build` → pass; `npm run smoke` → all 14 tools and async lifecycle passed; `npm audit --audit-level=high` → 0 vulnerabilities.
- Real integration: `list_models(refresh: true)` queried the installed CLI and returned 14 clean model slugs.
- Independent tester: PASS after focused recheck, with no denied actions and a non-empty terminal response.
- Additional controller fix: reject `SUCCESS` with an empty response; regression test included.
- Task 8: installed plugin cache updated to prefer the MCP bridge and retain direct `agy -p` as fallback. Bundled validator could not run because PyYAML is absent; frontmatter and referenced-file existence were checked manually. No canonical Overpowers checkout was present, so a future plugin update may overwrite this cache edit.
- Global registration: enabled with parameterized installer, executable resolution, and configured workspace allowlist roots.

### Task 9: Public portability and bounded observability

**Purpose:** Make the repository safe to publish and usable on other machines without personal paths or host-specific assumptions.
**Depends on:** Tasks 5–8.
**Files/boundary:** configuration/executable discovery, event/inspection API, installer scripts, package metadata, CI, docs, and tests.
**Behavior:** Discover `agy` from explicit config, PATH, and documented per-platform locations; provide actionable failure diagnostics; install/register globally through a parameterized cross-platform script; keep bounded waits below common MCP host request timeouts; bound inspection/event payloads and direct users to cursor pagination; bound `agy models` output/time; remove machine-specific examples and PII from publishable files.
**Critical details:** Never search arbitrary drives, execute through a shell, silently widen allowed roots, log environment secrets, or overwrite an existing MCP registration without explicit installer behavior. Work helpers and run logs must stay ignored.
**Acceptance:** Clean checkout can install/build/test/smoke on Node 20+ without Antigravity quota; installer has dry-run and test coverage; package dry-run contains no logs/work/PII; GitHub CI runs tests/typecheck/build/smoke on Windows and Linux; public docs use placeholders and explain security/data retention.
**Verification:** focused portability tests, `npm test`, `npm run typecheck`, `npm run build`, `npm run smoke`, `npm pack --dry-run`, PII/path scan, and independent tester review.

## Public-hardening checkpoint — 2026-10-04

- Task 9 implemented: platform-aware `agy`/Codex discovery, parameterized global registration, bounded waits and inspection payloads, bounded model discovery, public documentation, MIT license, and Windows/Linux CI.
- Issues discovered by real MCP use were folded back into the bridge: structured `result.denied_actions` are now retained in live and persisted inspection; empty `SUCCESS` results fail truthfully while preserving those diagnostics; inspection denial lists and text fields are bounded.
- Packaging defect fixed: the smoke fixture now lives under packaged `scripts/fixtures`, and an automated package-integrity test verifies every packaged script reference while excluding tests, work files, logs, and runtime state.
- Cross-host defect fixed: simulated Windows/POSIX tests use `path.win32`/`path.posix`; installer input validation runs before executable discovery so failures are deterministic across environments.
- Controller verification: 98 tests across 9 files, typecheck/build/smoke passed, audit reported 0 vulnerabilities, package dry-run contained 36 allowlisted files, and the publishable PII/path scan returned no matches.
- Independent tester: PASS with no denied actions after source review and the full verification command set.
