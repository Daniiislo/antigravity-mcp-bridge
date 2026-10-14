# Antigravity MCP Bridge

A Model Context Protocol (MCP) server that lets Codex or Claude Code coordinate persistent [Antigravity](https://antigravity.google) CLI (`agy`) workers as independent implementers and testers.

Install it from the Git marketplace like any published plugin — no clone, no build, no `npm install`. The plugin ships prebuilt artifacts and bundled dependencies.

The bridge uses stdio, starts child processes without a shell, restricts workers to explicit workspace roots, and records bounded NDJSON audit events locally.

## Requirements

- [Codex](https://developers.openai.com/codex/) CLI/Desktop or [Claude Code](https://claude.com/claude-code)
- [Antigravity CLI](https://antigravity.google) (`agy`), authenticated for the current user
- Node.js 20 or newer on `PATH`

Verify `agy`:

```bash
agy --version
```

## Install (Codex)

Add the marketplace once, then install the plugin:

```bash
codex plugin marketplace add Daniiislo/antigravity-mcp-bridge --ref main
codex plugin add antigravity-mcp-bridge
```

Verify:

```bash
codex plugin list
```

The bridge registers an MCP server named `antigravity-bridge` with 18 tools. Restart Codex after installing.

## Install (Claude Code)

Claude Code has the same marketplace flow:

```bash
claude plugin marketplace add Daniiislo/antigravity-mcp-bridge
claude plugin install antigravity-mcp-bridge@antigravity-bridge
```

Verify:

```bash
claude plugin list
```

Restart Claude Code after installing.

## Which directory can workers touch?

By default the bridge allows the directory it starts in. To let workers edit any project under a folder (or a whole drive), set `AGY_ALLOWED_ROOTS` in the plugin MCP config (see [Configuration](#configuration)) — for example `C:\Projects` or `$HOME/Projects`; repeat roots with the OS path separator (`;` on Windows, `:` elsewhere).

## Any other MCP host

Any MCP host can run the server directly from a clone — the repository ships prebuilt artifacts, no build step:

```bash
git clone https://github.com/Daniiislo/antigravity-mcp-bridge.git
```

Then point your host at `<clone>/plugins/antigravity-mcp-bridge/dist/index.js` with `AGY_ALLOWED_ROOTS` set to your project directories (see [Configuration](#configuration)).

## Update

Codex:

```bash
codex plugin marketplace upgrade
codex plugin remove antigravity-mcp-bridge@antigravity-bridge
codex plugin add antigravity-mcp-bridge
```

Claude Code:

```bash
claude plugin marketplace update antigravity-bridge
claude plugin update antigravity-mcp-bridge
```

If removal reports a file lock, exit Codex Desktop / Claude Code first (a running host keeps the cache files open) and retry.

## Uninstall

Codex:

```bash
codex plugin remove antigravity-mcp-bridge@antigravity-bridge
codex plugin marketplace remove antigravity-bridge
```

Claude Code:

```bash
claude plugin uninstall antigravity-mcp-bridge
claude plugin marketplace remove antigravity-bridge
```

If removal reports a file lock, exit the host app first. This removes the plugin and marketplace registration; run logs (under the OS state directory, see [Configuration](#configuration)) stay on disk.

## Controller API

The preferred asynchronous workflow is:

```text
create_worker → dispatch_task → MCP Task (when negotiated; host observes completion)
              → wait_task (single terminal fallback; no model-driven polling)
              → send_followup → close_worker
```

| Tool | Purpose |
| --- | --- |
| `list_models` | Discover available Antigravity models with bounded execution and caching. |
| `runtime_info` | Read build identity and safe execution limits once after restart; never use as a polling tool. |
| `create_worker` | Create an isolated implementer or tester in an allowed workspace. |
| `dispatch_task` | Queue work with optional inactivity and absolute duration limits. With negotiated MCP Tasks, return a durable task handle; otherwise return a `job_id` immediately. |
| `wait_task` | Hold one abortable request until terminal state and return the compact result once. The job continues if the caller cancels only the wait. |
| `agy_events` | Diagnostic-only event polling for humans and external tooling. Never call merely because time elapsed. |
| `inspect_task` | Read a compact result/usage/denial envelope. Prompt and step diagnostics are opt-in. |
| `send_followup` | Continue the same worker conversation for a fix or recheck, optionally with different inactivity and absolute duration limits. A timeout resumes the saved conversation; explicit cancel/reset starts fresh. |
| `cancel_task` | Cancel queued or active work. |
| `close_worker` | Stop and close a worker. |
| `agy_history` | Read persisted task summaries after server restarts. |
| `open_dashboard` | Get the local dashboard URL to inspect workers, jobs, conversations, and events. |
| `delete_task` | Delete an individual completed task run and its NDJSON log from disk. |
| `clean_history` | Prune or clean historical task runs by project, status, age, or retention limit. |

Four compatibility tools remain available: `agy_delegate`, `agy_status`, `agy_stop`, and `agy_reset`.

### Token Conservation & Best Practices

To prevent excessive prompt token consumption in coordinating agents (such as Codex or Claude):

- **Prefer negotiated MCP Tasks:** The bridge advertises the official `io.modelcontextprotocol/tasks` extension. A compatible host receives a durable task handle from `dispatch_task`, observes it outside the model turn, and gets the compact final result from `tasks/get`. This removes model-driven `wait_task` and `inspect_task` calls.
- **Capability-safe fallback:** The bridge never returns a Task to a caller that did not declare Tasks support. Existing hosts retain the immediate enqueue response and make one terminal `wait_task` call; there is no fixed heartbeat loop.
- **Wait once:** Call `wait_task({ job_id })` exactly once. Its terminal response already contains the bounded inspection result. Do not poll events, status, dashboard, or `inspect_task` unless the terminal result fails and diagnostics are needed.
- **Set the host timeout above the worker cap:** The default absolute worker cap is 1800 seconds, so a 1900-second MCP tool timeout leaves cleanup margin without waking the model periodically. Near the deadline the bridge asks the worker to wrap up (FINISH_NOW); a result returned in that grace window is a normal handoff, not a failure.
- **Restart safety:** A persisted `queued` or `running` record cannot prove its child process survived a bridge restart. `wait_task` reports `ORPHANED_JOB` instead of pretending that record is terminal or dispatching duplicate work.
- **Load diagnostics only when needed:** On failure, use `include_prompt: true` and/or `include_steps: true`; keep them false for successful tasks. Inspection reports `caller_payload_chars` (serialized structured payload before that field is added), a 32,768-character budget, and whether result/error truncation occurred. These are character measurements, not model-token estimates.
- **Open the dashboard explicitly:** Frequent lifecycle tools omit dashboard URLs; call `open_dashboard` only when a human actually needs live diagnostics.
- **Separate token domains:** `usage` is the per-turn Antigravity usage delta when the bridge has an uninterrupted counter baseline; it is intentionally omitted for the first success after a timeout or unobserved crash. `cumulative_usage` is the raw CLI conversation total. Neither is usage from the calling Codex/Claude controller. `duration_seconds` is bridge-observed wall time for the job; `cli_duration_seconds` preserves the raw CLI value.
- **Keep legacy status compact:** `agy_status` omits stderr by default; request `include_diagnostics: true` only while diagnosing a failure.
- **Use the Web Dashboard for real-time monitoring:** Call `open_dashboard` to inspect live progress, tool calls, and logs in the local web interface without streaming raw JSON events into the LLM context window.

### Local Web Dashboard & Project Filtering

The bridge includes an embedded local dashboard served over loopback HTTP (`127.0.0.1`):

#### How to Open:
1. **Via Codex / Claude (During MCP Session):**
   - Say: *"Mở dashboard"* or *"Open dashboard"*.
   - Codex calls the `open_dashboard` MCP tool, which returns the direct loopback URL (and clickable `resource_link`).
2. **Via Command Line (Standalone / History Viewer):**
   ```bash
   npm run dashboard
   ```
   This starts the local dashboard server, prints the URL, and opens it directly in your default browser. It reads the same per-user shared history store as every MCP instance, regardless of the current directory.

#### Dashboard Capabilities:
- **Project Filter:** Filter runs by project/workspace via dropdown or URL query parameter (`?project=<name>`).
- **Dense layout:** Split-pane layout with Conversation view (prompts and assistant responses), Activity timeline (steps, tool calls, commands, stderr), and Raw event logs.
- **Interactive Cleanup & Deletion:**
  - **Single Job Deletion:** Click the `🗑️ Delete` button in the job detail header.
  - **Prune History Modal:** Click the `🧹 Clean History` button in the sidebar to delete finished jobs, clean by project, delete failed jobs, or reset all history with optional retention (`keep newest N jobs`).
- **Live SSE streaming:** Delivers real-time lifecycle and step events with reconnect cursor deduplication and polling fallback.
- **Strict loopback & Bearer token:** Bound strictly to `127.0.0.1`, protected by a per-process 48-character hex token in the URL path, and validates `Host` headers to protect against DNS rebinding.
- **Self-contained & Safe:** Zero external CDNs, fonts, or remote assets. Enforces a strict Content Security Policy and renders all content using safe DOM text APIs (no untrusted `innerHTML`).

### History Cleanup & Pruning CLI

Clean or prune the shared history store from your terminal at any time:

```bash
# Preview candidates without deleting (safe dry-run)
npm run clean -- --dry-run

# Delete completed/terminal jobs while keeping the 10 newest runs
npm run clean -- --terminal-only --keep 10

# Delete all runs belonging to a specific workspace or project
npm run clean -- --project "Antigravity Bridge Codex MCP"

# Delete only failed and canceled runs
npm run clean -- --status failed,canceled

# Delete a single specific job
npm run clean -- --job job-1791125238054-1

# Delete all history (with confirmation prompt, or pass -y to skip)
npm run clean -- --all -y
```

## Configuration

All configuration is environment variables — set them in your host's MCP server entry (`AGY_ALLOWED_ROOTS` is the one most installs need). The server does not automatically load `.env` files. See [`.env.example`](.env.example) for a full reference template.

| Variable | Default | Description |
| --- | --- | --- |
| `AGY_ALLOWED_ROOTS` | Server start directory | Allowed workspace roots; separated by `;` on Windows and `:` on macOS/Linux. |
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
| `AGY_SANDBOX` | `false` | Enable Antigravity sandbox mode. |
| `AGY_DANGEROUSLY_SKIP_PERMISSIONS` | `false` | Bypass prompts; not recommended. |
| `AGY_DASHBOARD_ENABLED` | `true` | Enable local read-only web dashboard. |
| `AGY_DASHBOARD_PORT` | `0` | Port for dashboard HTTP server (`0` for dynamic ephemeral port). |

All MCP instances for the same OS user write to this shared store, so `npm run dashboard` can display jobs from every configured workspace and the project dropdown can filter them by their recorded workspace. `AGY_RUNS_DIR` takes precedence when set and is also used by the standalone dashboard and cleanup commands.

History written by older versions under a workspace-local `.antigravity-bridge/runs` directory is not copied automatically. To view it, temporarily set `AGY_RUNS_DIR` to that legacy directory, or copy its `.ndjson` files into the shared store while no bridge process is writing them. A standalone dashboard rereads shared files when the page is loaded; refresh the page to discover jobs appended by a different live MCP process.

## Safety properties

- Commands use argument arrays with `shell: false`.
- Workspace paths are canonicalized and checked against `AGY_ALLOWED_ROOTS`.
- Controlled timeout/stop paths terminate the complete process tree and wait for exit before the worker queue advances, preventing orphan test/build processes from racing a follow-up.
- If the operating system cannot confirm tree termination after the forced-kill window, the worker is poisoned: the active and queued turns fail without starting another process. Close it and create a new worker rather than risking concurrent descendants.
- A confirmed timeout recovery restarts `agy` with the saved `--conversation`; explicit cancellation, reset, and close intentionally discard that context. An unexpected Windows root-process exit poisons the worker when descendant cleanup can no longer be confirmed.
- Inactivity timers reset only on structured Antigravity progress, while a separate absolute cap prevents an endlessly chatty worker from running forever.
- `wait_task` is abortable but returns only at terminal state, avoiding repeated model turns. Negotiated MCP Tasks remain the preferred host-managed path.
- When configured, a compact prompt states the observed step/token budget and asks for a concise final handoff. Effort defaults remain the CLI's choice unless explicitly overridden.

### Deadline, retry, and preflight contracts

`dispatch_task` and `send_followup` accept `total_duration_seconds`, measured from dispatch including queue time. It defaults to the effective maximum duration (1800 seconds with default configuration). Queued expiry does not start AGY; active expiry waits for confirmed process-tree cleanup before queue advancement. Set the host timeout above this total budget plus cleanup margin. The compatibility `agy_delegate` remains a direct turn and has no manager queue deadline.

Use optional `request_key` for uncertain retries with exactly the same worker, brief and explicit options. Identical retries return the original job, including after restart for completed jobs; conflicting reuse fails. A persisted nonterminal retry returns `ORPHANED_JOB` instead of starting duplicate work. Keys are scoped to a bridge history store; this is not a distributed cross-process locking guarantee. Recover the original job after waiter interruption rather than inventing a new key.

`create_worker(required_tools: ["dotnet", "node"])` checks task-specific executable presence without spawning AGY. It does not check modules, permissions or command correctness. Supply exact native verification commands and relevant capability evidence in the brief. Fresh sessions use explicit project/workspace binding and disable slash-command expansion; related process recovery uses the saved conversation.

For offline diagnosis, run `node scripts/analyze-runs.mjs [runs-directory]` after building. It emits aggregate timing/usage only, with no prompt, command, response or agent call. Model/tool duration sums can overlap and are not wall time. Real AGY performance and host Tasks negotiation still require runtime evidence; deterministic fixture tests do not establish a latency-saving percentage.
- MCP Tasks uses the official `@modelcontextprotocol/ext-tasks` V2 schemas. The Antigravity `job_id` is the durable MCP `taskId`; terminal `tasks/get` responses include the same bounded inspection payload that previously required a separate `inspect_task` call.
- Inspection, stderr, model output, and persisted fields are bounded.
- Environment variables are excluded from event logs.
- Empty `SUCCESS` responses and denied actions remain visible as failures or diagnostics.
- Local read-only dashboard binds strictly to `127.0.0.1`, enforces per-process bearer tokens, validates `Host` headers against DNS rebinding, serves strict CSP headers, and employs safe DOM text APIs with zero external assets.
- Runtime logs, scratch files, dependencies, build output, and secrets are excluded from Git.

## Troubleshooting

- **`agy` not found:** install and authenticate the Antigravity CLI, add it to `PATH`, or set `AGY_BIN` to its exact location.
- **Workspace rejected:** add the project's canonical parent directory to `AGY_ALLOWED_ROOTS`.
- **Tools missing:** verify the plugin with `codex plugin list`, then restart Codex.
- **Action denied:** grant only the narrow Antigravity permission required by the task.
- **Stale job after a crash:** jobs stuck queued/running across a bridge restart are reported as `orphaned`; inspect them with `inspect_task` before replacing the work.

## Development

```bash
git clone https://github.com/Daniiislo/antigravity-mcp-bridge.git
cd antigravity-mcp-bridge
npm ci
npm test          # builds, then runs the full suite
npm run typecheck
npm run smoke
```

`npm run build` also syncs the compiled output and the production dependency closure into `plugins/antigravity-mcp-bridge/`, which is the directory shipped through the marketplace — commit it when changing runtime code.

CI runs these checks on Windows and Ubuntu with Node.js 20 and 22.

## License

MIT. See [LICENSE](LICENSE).
