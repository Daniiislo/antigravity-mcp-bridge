# Advanced reference

Deep-dive material for the Antigravity MCP Bridge — everything trimmed from the [README](../README.md) for daily use. Contents: [deadline and retry contracts](#deadline-retry-and-preflight-contracts), [safety properties](#safety-properties), [token conservation](#token-conservation-for-controllers), [dashboard and history CLI](#dashboard-and-history-cli), [configuration reference](#configuration-reference).

## Deadline, retry, and preflight contracts

`dispatch_task` and `send_followup` accept `total_duration_seconds`, measured from dispatch including queue time. It defaults to the effective maximum duration (1800 seconds with default configuration). Queued expiry does not start AGY; active expiry waits for confirmed process-tree cleanup before queue advancement. Set the host tool timeout above this total budget plus cleanup margin. The compatibility `agy_delegate` remains a direct turn and has no manager queue deadline.

Near the deadline (45 seconds before the hard cap by default) the bridge sends a FINISH_NOW event asking the worker to wrap up. A result returned inside that grace window is a normal terminal handoff, not a failure — partial work is preserved instead of killed mid-write.

Use optional `request_key` for uncertain retries with exactly the same worker, brief, and explicit options. Identical retries return the original job, including after restart for completed jobs; conflicting reuse fails. A persisted nonterminal retry returns `ORPHANED_JOB` instead of starting duplicate work. Keys are scoped to a bridge history store; this is not a distributed cross-process locking guarantee. Recover the original job after waiter interruption rather than inventing a new key.

`create_worker(required_tools: ["dotnet", "node"])` checks task-specific executable presence without spawning AGY. It does not check modules, permissions, or command correctness. Supply exact native verification commands and relevant capability evidence in the brief. Fresh sessions use explicit project/workspace binding and disable slash-command expansion; related process recovery uses the saved conversation.

## Safety properties

- Commands use argument arrays with `shell: false`.
- Workspace paths are canonicalized and checked against the allowed roots (`AGY_ALLOWED_ROOTS` env > `~/.antigravity-bridge/config.json` `allowed_roots` > user home default). A rejected workspace error names the fix.
- Controlled timeout/stop paths terminate the complete process tree and wait for exit before the worker queue advances, preventing orphan test/build processes from racing a follow-up.
- If the operating system cannot confirm tree termination after the forced-kill window, the worker is poisoned: the active and queued turns fail without starting another process. Close it and create a new worker rather than risking concurrent descendants.
- A confirmed timeout recovery restarts `agy` with the saved `--conversation`; explicit cancellation, reset, and close intentionally discard that context. An unexpected Windows root-process exit poisons the worker when descendant cleanup can no longer be confirmed.
- Inactivity timers reset only on structured Antigravity progress, while a separate absolute cap prevents an endlessly chatty worker from running forever.
- `wait_task` is abortable but returns only at terminal state, avoiding repeated model turns. Negotiated MCP Tasks remain the preferred host-managed path.
- Inspection, stderr, model output, and persisted fields are bounded. Environment variables are excluded from event logs. Empty `SUCCESS` responses and denied actions remain visible as failures or diagnostics.
- The dashboard binds strictly to `127.0.0.1`, enforces per-process bearer tokens, validates `Host` headers against DNS rebinding, serves strict CSP headers, and uses safe DOM text APIs with zero external assets.
- Runtime logs, scratch files, dependencies, build output, and secrets are excluded from Git.

## Attention signals on job results

`wait_task`, `inspect_task`, history reads, and the dashboard add three optional fields to a job's compact result. None of them changes the job `status`.

- `denied_actions` / `total_denied_actions` list only denials that happened during that job. Antigravity reports `denied_actions` cumulatively per conversation, so the bridge keeps a per-worker baseline and attributes just the new entries; the baseline resets when the conversation changes. After a timeout or crash the next result cannot be attributed, so only step-level denials (a tool step whose error is a permission failure) are reported and a warning says so. Entries name the target when known, for example `ViewFile (read_file): <path>` or `RunCommand (command): <command line>`. Run history written by older versions only has the cumulative list and may still show stale entries.
- `tool_activity` is `{ tool_calls, files_changed, commands_run, tool_errors }`, counting each tool step once (`files_changed` holds up to 20 unique paths from file-writing tools).
- `warnings` is a list of plain-text attention signals, repeated in the `wait_task` summary line:
  - Denied actions: headless Antigravity auto-denies permissions it cannot prompt for and the turn often ends early. Reads outside the workspace need an [`add_dirs`](../README.md#optional-extra-readable-directories-add_dirs) entry using the real path (a symlink or junction alias is denied because Antigravity checks the literal path; the warning names the real path when it can tell). Commands need an allow rule in Antigravity's own settings (`permissions.allow`). The Antigravity stderr hint is included when one was printed.
  - An implementer job that succeeded without any file-changing tool call: verify the response before accepting it.
  - A tester job that modified files (see below).

### Tester mode

Testers are launched with `--mode plan`. Current `agy` prints `warning: --mode plan has no effect while slash command expansion is disabled.`, and the bridge keeps slash commands disabled, so the flag does nothing. In testing with agy 1.3.5, even with plan mode honored a tester could still run commands and create files when the prompt asks for it, and omitting `--mode` behaves the same, so the tester role is review-only by instruction, not an enforced read-only sandbox. Use `constraints` on `create_worker` to state the rule, and treat the tester-modified-files warning as a signal to review the diff.

## Token conservation for controllers

- **Prefer negotiated MCP Tasks:** the bridge advertises the official `io.modelcontextprotocol/tasks` extension. A compatible host receives a durable task handle from `dispatch_task`, observes it outside the model turn, and gets the compact final result from `tasks/get`. This removes model-driven `wait_task` and `inspect_task` calls.
- **Capability-safe fallback:** the bridge never returns a Task to a caller that did not declare Tasks support. Existing hosts retain the immediate enqueue response and make one terminal `wait_task` call; there is no fixed heartbeat loop.
- **Wait once:** call `wait_task({ job_id })` exactly once. Its terminal response already contains the bounded inspection result. Do not poll events, status, dashboard, or `inspect_task` unless the terminal result fails and diagnostics are needed.
- **Restart safety:** a persisted `queued` or `running` record cannot prove its child process survived a bridge restart. `wait_task` reports `ORPHANED_JOB` instead of pretending that record is terminal or dispatching duplicate work.
- **Load diagnostics only when needed:** on failure, use `include_prompt: true` and/or `include_steps: true`; keep them false for successful tasks. Inspection reports `caller_payload_chars` (serialized structured payload before that field is added), a 32,768-character budget, and whether result/error truncation occurred. These are character measurements, not model-token estimates.
- **Separate token domains:** `usage` is the per-turn Antigravity usage delta when the bridge has an uninterrupted counter baseline; it is intentionally omitted for the first success after a timeout or unobserved crash. `cumulative_usage` is the raw CLI conversation total. Neither is usage from the calling Codex/Claude controller. `duration_seconds` is bridge-observed wall time for the job; `cli_duration_seconds` preserves the raw CLI value.
- **Keep legacy status compact:** `agy_status` omits stderr by default; request `include_diagnostics: true` only while diagnosing a failure.

## Dashboard and history CLI

The dashboard serves over loopback HTTP (`127.0.0.1`) with a per-process token:

- Via the host session: call the `open_dashboard` tool (or say *"open dashboard"*).
- Standalone from a clone: `npm run dashboard` — reads the same per-user shared history store regardless of the current directory.

Features: project filter (dropdown or `?project=<name>`), split-pane conversation/activity/raw-event views, single-job and bulk history deletion, live SSE streaming with reconnect cursor deduplication and polling fallback.

Clean or prune the shared history store from your terminal:

```bash
npm run clean -- --dry-run                      # preview without deleting
npm run clean -- --terminal-only --keep 10      # drop terminal jobs, keep 10 newest
npm run clean -- --project "my project"         # all runs for one workspace
npm run clean -- --status failed,canceled       # only failed and canceled runs
npm run clean -- --job job-1791125238054-1      # one specific job
npm run clean -- --all -y                       # everything
```

All MCP instances for the same OS user write to this shared store, so the standalone dashboard shows jobs from every configured workspace. `AGY_RUNS_DIR` takes precedence when set and is also used by the standalone dashboard and cleanup commands. History written by older versions under a workspace-local `.antigravity-bridge/runs` directory is not copied automatically — temporarily point `AGY_RUNS_DIR` at it to view, or copy its `.ndjson` files into the shared store while no bridge process is writing.

For offline diagnosis, run `node scripts/analyze-runs.mjs [runs-directory]` after building. It emits aggregate timing/usage only, with no prompt, command, response, or agent call. Model/tool duration sums can overlap and are not wall time.

## Configuration reference

All configuration is environment variables except `allowed_roots` and `add_dirs`, which live in `~/.antigravity-bridge/config.json` (see the [README](../README.md#one-required-setting-allowed-workspace-roots)). The server does not automatically load `.env` files. See [`.env.example`](../.env.example) for a template.

| Variable | Default | Description |
| --- | --- | --- |
| `AGY_ALLOWED_ROOTS` | config file → user home | Allowed workspace roots; separated by `;` on Windows and `:` on macOS/Linux. Overrides the config file. |
| `AGY_ADD_DIRS` | config file `add_dirs` → none | Extra directories passed to every worker as additional `--add-dir` flags, in addition to its workspace. Separated like `AGY_ALLOWED_ROOTS`; overrides the file. Each entry must be an existing directory and is canonicalized; a malformed `add_dirs` value is a hard error. Antigravity checks the literal path, so reference the real path: a symlink or junction alias of an added directory is still denied. |
| `AGY_USER_CONFIG` | `~/.antigravity-bridge/config.json` | Path to the per-user config file. |
| `AGY_BIN` | Auto-discovered | Exact `agy` executable or command name. |
| `AGY_RUNS_DIR` | Per-user shared state directory | Override the NDJSON event directory. The default is `%LOCALAPPDATA%\antigravity-mcp-bridge\runs` on Windows, `~/Library/Application Support/antigravity-mcp-bridge/runs` on macOS, and `${XDG_STATE_HOME:-~/.local/state}/antigravity-mcp-bridge/runs` on Linux. |
| `AGY_DEFAULT_INACTIVITY_TIMEOUT_SECONDS` | `300` | Stop a worker after this many seconds without an `init` or `step_update` progress event. Set `inactivity_timeout_seconds` per job to override it. |
| `AGY_MAX_TURN_SECONDS` | `1800` | Absolute wall-clock safety cap even while progress continues. Near the deadline the bridge asks the worker to wrap up (FINISH_NOW) so partial work hands off as a normal result. Set `max_duration_seconds` per job to override it. |
| `AGY_MAX_STEPS` | Unset | Optional observed step ceiling. Repeated indexed updates count once; unindexed DONE updates count conservatively. Calibrate on useful-result benchmarks. |
| `AGY_MAX_TURN_TOKENS` | Unset | Optional observed streamed model-token ceiling, excluding cache-read. Duplicate indexed DONE usage is not charged twice. Upstream generation may overshoot before an event arrives. |
| `AGY_DEFAULT_TIMEOUT_SECONDS` | Unset | Backward-compatible alias for the inactivity timeout, used only when `AGY_DEFAULT_INACTIVITY_TIMEOUT_SECONDS` is unset. |
| `AGY_MAX_STDERR_BYTES` | `32768` | Maximum captured stderr per worker. |
| `AGY_MODEL` | Unset | Optional fixed model. |
| `AGY_EFFORT` | Unset | `low`, `medium`, `high`, `xhigh`, or `max`. |
| `AGY_AGENT` | Unset | Optional fixed agent. |
| `AGY_BASE_ARGS_JSON` | Unset | JSON array of strings inserted before the bridge's agy flags — for `AGY_BIN` wrappers. |
| `AGY_SANDBOX` | `false` | Enable Antigravity sandbox mode. |
| `AGY_DANGEROUSLY_SKIP_PERMISSIONS` | `false` | Bypass prompts; not recommended. |
| `AGY_DASHBOARD_ENABLED` | `true` | Enable local read-only web dashboard. |
| `AGY_DASHBOARD_PORT` | `0` | Port for dashboard HTTP server (`0` for dynamic ephemeral port). |

**MCP Tasks notes.** MCP Tasks uses the official `@modelcontextprotocol/ext-tasks` V2 schemas. The Antigravity `job_id` is the durable MCP `taskId`; terminal `tasks/get` responses include the same bounded inspection payload that previously required a separate `inspect_task` call.

**Versioning.** This project follows semantic versioning. While in `0.x` the minor number marks behavior changes (the role major plays after `1.0.0`); patches are pure fixes.
