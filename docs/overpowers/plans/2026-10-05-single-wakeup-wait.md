# Single-Wakeup Wait Implementation Plan

> Status: restored and amended on 2026-10-11 after the owner clarified that controller-token conservation is the highest-priority constraint. MCP Tasks remains preferred; non-Tasks callers use one terminal wait rather than fixed heartbeats.

**Goal:** Minimize Codex controller wake-ups while an Antigravity job is running, without relying on unsupported MCP task/progress behavior.
**Source:** Owner request plus independent plan review on 2026-10-05.
**Architecture:** Keep the existing asynchronous job model. Make public `wait_task` parameterless apart from `job_id`; it holds one abortable request until terminal state and returns the compact result. The host timeout must exceed the configured worker cap.
**Constraints:** A caller without MCP Tasks needs a sufficiently long MCP tool timeout. The default worker hard cap is now 600 seconds and the recommended host timeout is 660 seconds. Fixed heartbeat polling is rejected because every heartbeat can create a new controller reasoning turn.
**Delivery:** Implement on `main`, independently test, benchmark, commit, and push after acceptance.

### Task 1: Enforce maximum bounded wait at the public boundary

**Purpose:** Prevent an LLM controller from choosing short polling intervals.
**Files/boundary:** `src/server.ts`, `src/worker-manager.ts`, controller/dashboard tests.
**Interfaces and data:** Public `wait_task` accepts only `job_id`. Internal `waitTask` remains available for deterministic unit tests, but its default wait becomes 300,000 ms and its maximum remains 300,000 ms.
**Behavior:**
1. A public call waits until the job is terminal or the caller aborts the waiter.
2. The terminal response includes the compact inspection, removing a normal follow-up call.
3. Legacy `wait_ms`/`after_cursor` fields are stripped and cannot shorten or event-wake the public call.
**Acceptance:** A public call containing legacy short-poll fields still waits for a delayed job to finish and returns one terminal compact result.
**Verification:** `npm test`, `npm run typecheck`, `npm run smoke`.

### Task 2: Make the no-diagnostics policy self-enforcing in guidance

**Purpose:** Stop controllers from calling `agy_events`, status, or dashboard merely because time elapsed.
**Files/boundary:** Tool descriptions, `README.md`, design document, and the installed personal Antigravity worker protocol.
**Behavior:** Normal flow is dispatch and one terminal wait containing the compact result. Diagnostics require failure, explicit human request, or evidence the job handle is no longer live.
**Acceptance:** No normal-flow documentation recommends 60-second waits or event snapshots after a running result.

### Task 3: Verify and benchmark

**Purpose:** Prove correctness and quantify wake-up reduction.
**Behavior:** Run full tests, typecheck, smoke, independent Antigravity tester, and a live job longer than 60 seconds when practical. Compare model wake count and response characters with the previous workflow.
**Acceptance:** No regression; normal running job creates no event/status/dashboard/heartbeat calls; expected controller wake count is one terminal result for non-Tasks callers and zero model-driven waits for Tasks-aware callers.
**Evidence boundary:** MCP Tasks exists in the bridge, but actual Codex negotiation/progress keepalive must be directly verified before claiming host support.
