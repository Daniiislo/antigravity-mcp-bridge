# Single-Wakeup Wait Implementation Plan

**Goal:** Minimize Codex controller wake-ups while an Antigravity job is running, without relying on unsupported MCP task/progress behavior.
**Source:** Owner request plus independent plan review on 2026-10-05.
**Architecture:** Keep the existing asynchronous job model. Make public `wait_task` parameterless apart from `job_id`, use the verified 300-second bounded wait internally, and make every non-terminal response direct the controller back to the same wait tool without diagnostics.
**Constraints:** MCP SDK defaults requests to 60 seconds unless the host overrides it. This Codex integration has sustained waits over 120 seconds, but MCP Tasks and progress-timeout reset are not proven. Do not claim guaranteed single-wakeup behavior beyond the verified transport bound.
**Delivery:** Implement on `main`, independently test, benchmark, commit, and push after acceptance.

### Task 1: Enforce maximum bounded wait at the public boundary

**Purpose:** Prevent an LLM controller from choosing short polling intervals.
**Files/boundary:** `src/server.ts`, `src/worker-manager.ts`, controller/dashboard tests.
**Interfaces and data:** Public `wait_task` accepts only `job_id`. Internal `waitTask` remains available for deterministic unit tests, but its default wait becomes 300,000 ms and its maximum remains 300,000 ms.
**Behavior:**
1. A public call waits up to 300 seconds or returns immediately when terminal.
2. A non-terminal response remains compact and tells the controller to call only `wait_task` again.
3. Legacy `wait_ms`/`after_cursor` fields are stripped and cannot shorten or event-wake the public call.
**Acceptance:** A public call containing `wait_ms: 0` still waits for a delayed job to finish; no events are returned.
**Verification:** `npm test`, `npm run typecheck`, `npm run smoke`.

### Task 2: Make the no-diagnostics policy self-enforcing in guidance

**Purpose:** Stop controllers from calling `agy_events`, status, or dashboard merely because time elapsed.
**Files/boundary:** Tool descriptions, `README.md`, design document, and the installed personal Antigravity worker protocol.
**Behavior:** Normal flow is dispatch, one maximum wait, repeat the same wait only after a bounded non-terminal result, then one compact inspect. Diagnostics require failure, explicit human request, or evidence the job handle is no longer live.
**Acceptance:** No normal-flow documentation recommends 60-second waits or event snapshots after a running result.

### Task 3: Verify and benchmark

**Purpose:** Prove correctness and quantify wake-up reduction.
**Behavior:** Run full tests, typecheck, smoke, independent Antigravity tester, and a live job longer than 60 seconds when practical. Compare model wake count and response characters with the previous workflow.
**Acceptance:** No regression; normal running job creates no event/status/dashboard calls; expected wake interval is 300 seconds rather than 60 seconds.
**Out of scope:** MCP Tasks or progress keepalive until Codex host capability negotiation and timeout-reset behavior are directly proven.
