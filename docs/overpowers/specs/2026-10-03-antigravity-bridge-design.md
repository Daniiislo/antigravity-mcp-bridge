# Antigravity Bridge Design

## Goal

Expose Antigravity CLI workers to Codex as a local stdio MCP server. Codex remains the controller; Antigravity provides isolated implementer and tester conversations that can be reused across related turns.

## Scope

The controller release provides:

- multiple explicitly-created workers with stable worker IDs;
- asynchronous jobs with stable job IDs, cursor-based events, bounded waits, cancellation, inspection, and history;
- model discovery through `agy models` with a bounded cache;
- follow-ups that reuse the selected worker conversation;
- compatibility wrappers for the original four MVP tools;
- persistent per-run NDJSON event logs under `.antigravity-bridge/runs`;
- workspace allowlisting and conservative permission defaults;
- deterministic unit/integration tests using a fake `agy` process.

Account/quota switching, Cockpit Tools automation, remote HTTP transport, dashboards, and automatic git commits are out of scope.

## Architecture

The MCP server owns a `WorkerManager`. The manager lazily creates one `AgyWorker` per role. Each worker starts:

```text
agy --input-format stream-json --output-format stream-json --mode <role-mode>
```

The implementer uses `accept-edits`; the tester uses `plan`. Model, effort, agent, sandbox, and executable location come from server configuration, not arbitrary prompt text. `--dangerously-skip-permissions` is disabled unless the server operator explicitly enables it with an environment variable.

Each turn writes exactly one NDJSON user event:

```json
{"event":"user","message":{"content":"..."}}
```

The worker parses stdout line-by-line, records `init` and `step_update` metadata, and resolves the current turn only when its `result` event arrives. A malformed output line, process exit, timeout, write failure, or non-`SUCCESS` result produces a structured MCP error. Stderr is bounded and returned only as diagnostic context.

## MCP Interface

### Controller tools

- `list_models(refresh?)`: return parsed model choices and cache metadata.
- `create_worker(role, workspace, model?, effort?, constraints?)`: create an idle worker and return `worker_id`.
- `dispatch_task(worker_id, brief)`: enqueue work and return `job_id` immediately.
- `wait_task(job_id)`: bounded wait (up to 300s) for terminal state. Progress events and timing arguments are not accepted; non-terminal results direct the controller to call `wait_task` again.
- `send_followup(worker_id, finding)`: enqueue related work in the same conversation.
- `inspect_task(job_id)`: return job metadata, tool/step events, errors, denied actions, usage, and handoff/result.
- `cancel_task(job_id)`: cancel queued work; canceling active work terminates its process and invalidates that worker conversation.
- `close_worker(worker_id)`: cancel its outstanding work, stop its process, and close it.
- `agy_events(worker_id?, job_id?, after_cursor?, limit?)`: poll normalized events for human diagnostics only; never for elapsed time during a running job.
- `agy_history(worker_id?, status?, limit?)`: list newest jobs with terminal summaries.

The original `agy_delegate`, `agy_status`, `agy_stop`, and `agy_reset` remain compatibility tools. They use one implicit worker per role.

### Job states

`queued → running → succeeded | failed | canceled`. Each event receives a monotonically increasing cursor within the server. Public `wait_task` never waits longer than 300 seconds and returns immediately when the job is terminal. Internal `waitTask` optionally accepts `after_cursor` and `waitMs` (default 300,000 ms, max 300,000 ms) for deterministic tests.

### `agy_stop`

Gracefully closes stdin, waits briefly, then terminates the selected worker if needed. Conversation metadata remains visible until reset or restart.

### `agy_reset`

Stops the selected worker and removes its in-memory state. The next delegation starts a fresh Antigravity conversation.

## Boundaries and Invariants

- MCP protocol output is written only to stdout; diagnostics go to stderr.
- A worker never has more than one active prompt; each explicit worker owns one process/conversation.
- Controller-created implementer and tester workers never share process state.
- CWD is canonicalized before allowlist comparison; sibling-prefix tricks such as `C:\work-evil` do not pass for `C:\work`.
- Prompts are passed through stdin JSON, never interpolated into a shell command.
- Output and stderr buffers are bounded.
- Server shutdown stops all child processes.
- A timed-out turn invalidates the worker and forces a fresh process on the next call, avoiding result/request misalignment.
- Dispatch is non-blocking. Job inspection and event polling do not mutate worker execution.
- Constraints are prepended to every brief and follow-up for that worker.
- Persistent event logs exclude environment variables and bound individual payload sizes.

## Configuration

- `AGY_BIN`: executable path/name, default `agy`.
- `AGY_ALLOWED_ROOTS`: platform-delimited root list; default server start directory.
- `AGY_MODEL`, `AGY_EFFORT`, `AGY_AGENT`: optional fixed CLI selections.
- `AGY_SANDBOX`: boolean, default false.
- `AGY_DANGEROUSLY_SKIP_PERMISSIONS`: boolean, default false.
- `AGY_DEFAULT_TIMEOUT_SECONDS`: default 900.
- `AGY_MAX_STDERR_BYTES`: default 32768.

## Acceptance

- Codex can list and call the controller tools plus the four compatibility tools over stdio MCP.
- Two turns for one role reuse one fake process/conversation.
- Implementer and tester use separate processes and modes.
- malformed NDJSON, terminal errors, process exit, and timeout return actionable errors and do not poison later sessions;
- paths outside allowed roots are rejected;
- dispatch returns before the fake worker completes, bounded wait/cursor polling works, history survives completed jobs for the server lifetime, and persisted NDJSON is parseable;
- focused tests, typecheck, build, and an MCP client smoke test pass.
