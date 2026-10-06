# Antigravity MCP Bridge

A local Model Context Protocol (MCP) server that lets Codex or Claude Code coordinate persistent Antigravity CLI (`agy`) workers as independent implementers and testers.

The bridge uses stdio, starts child processes without a shell, restricts workers to explicit workspace roots, and records bounded NDJSON audit events locally.

## Requirements

- Node.js 20 or newer
- Codex CLI/Desktop or Claude Code
- Antigravity CLI (`agy`), authenticated for the current user
- Git

Verify the required commands:

```bash
node --version
agy --version
```

## Install

```bash
git clone https://github.com/Daniiislo/antigravity-mcp-bridge.git
cd antigravity-mcp-bridge
npm ci
npm run build
```

## Register

You can register the bridge in either of two ways:

1. **Method 1: Local Agent Plugin (Recommended for Codex & ChatGPT Desktop):** Registers as an Agent Plugin with full metadata (`plugin.json` / `mcp.json`), making it visible and manageable in the Plugins interface.
2. **Method 2: Direct MCP Server (Codex CLI or Claude Code):** Adds the stdio server directly to your host's MCP configuration (`config.toml` or `claude.json`).

---

### Method 1: Local Agent Plugin (Codex / ChatGPT Desktop)

Register the bridge into your local plugin marketplace:

```powershell
npm run register:plugin
```

To target your personal user marketplace catalog:

```powershell
# Windows PowerShell:
npm run register:plugin -- --catalog "$env:USERPROFILE\.agents\plugins\marketplace.json"

# macOS / Linux:
npm run register:plugin -- --catalog "$HOME/.agents/plugins/marketplace.json"
```

Alternatively, add the repository directory directly via Codex CLI:

```bash
codex plugin marketplace add "."
```

Verify that the plugin is recognized:

```bash
codex plugin list
```

---

### Method 2: Direct MCP Server Registration

Specify the workspace directories that Antigravity workers are allowed to access via `--root`:

Codex:

```powershell
npm run register:codex -- --root "C:\Projects" --root "D:\Work"
codex mcp get antigravity-bridge
```

Claude Code:

```powershell
npm run register:claude -- --root "C:\Projects" --root "D:\Work"
claude mcp get antigravity-bridge
```

The same commands work on macOS and Linux with POSIX paths:

```bash
npm run register:codex -- --root "$HOME/Projects"
# or
npm run register:claude -- --root "$HOME/Projects"
```

To allow complete Windows drives instead:

```powershell
npm run register:codex -- --root "C:\" --root "D:\"
```

Open a new Codex task or restart Claude Code after registration.

`--root` may be repeated. Use a project folder for tighter access or a drive root for every directory on that drive. Both installers automatically discover their host CLI, `agy`, and Node.js. Claude Code registration uses the global `user` scope.

## Controller API

The preferred asynchronous workflow is:

```text
create_worker → dispatch_task → MCP Task (when negotiated; host observes completion)
              → wait_task (single pending fallback; returns compact terminal result)
              → send_followup → close_worker
```

| Tool | Purpose |
| --- | --- |
| `list_models` | Discover available Antigravity models with bounded execution and caching. |
| `create_worker` | Create an isolated implementer or tester in an allowed workspace. |
| `dispatch_task` | Queue work. With negotiated MCP Tasks, return a durable task handle; otherwise return a `job_id` immediately. |
| `wait_task` | Hold one request pending until terminal state, then return the compact result. Host timeout configuration is required. |
| `agy_events` | Diagnostic-only event polling for humans and external tooling. Never call merely because time elapsed. |
| `inspect_task` | Read a compact result/usage/denial envelope. Prompt and step diagnostics are opt-in. |
| `send_followup` | Continue the same worker conversation for a fix or recheck. |
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
- **Capability-safe fallback:** The bridge never returns a Task to a caller that did not declare Tasks support. Existing hosts retain the immediate enqueue response and use the single-pending wait below.
- **Use one terminal wait:** Call `wait_task({ job_id })` exactly once. It remains pending until the job succeeds, fails, or is canceled, then returns the same bounded compact result as `inspect_task`. Do not poll and do not call `inspect_task` afterward unless diagnostics are explicitly needed.
- **Configure Codex for the pending call:** Codex defaults MCP tool calls to 300 seconds. Set `tool_timeout_sec` above the longest intended worker turn and route this namespace directly so Code Mode does not turn the request into model-visible polling:

  ```toml
  [mcp_servers.antigravity-bridge]
  tool_timeout_sec = 3600

  [features.code_mode]
  direct_only_tool_namespaces = ["mcp__antigravity_bridge"]
  ```

  Restart Codex after changing configuration. A host timeout or user interruption detaches only the waiter; it does not cancel the worker. Reuse the same job ID and never dispatch a duplicate.
- **Restart safety:** A persisted `queued` or `running` record cannot prove its child process survived a bridge restart. `wait_task` reports `ORPHANED_JOB` instead of pretending that record is terminal or dispatching duplicate work.
- **Load diagnostics only when needed:** On failure, use `include_prompt: true` and/or `include_steps: true`; keep them false for successful tasks. Inspection reports `caller_payload_chars` (serialized structured payload before that field is added), a 32,768-character budget, and whether result/error truncation occurred. These are character measurements, not model-token estimates.
- **Open the dashboard explicitly:** Frequent lifecycle tools omit dashboard URLs; call `open_dashboard` only when a human actually needs live diagnostics.
- **Separate token domains:** `usage` is Antigravity worker usage. It must not be presented as tokens consumed by the calling Codex/Claude controller.
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
   This starts the local dashboard server, prints the URL, and opens it directly in your default browser to inspect historical runs (`.antigravity-bridge/runs`).

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

Clean or prune `.antigravity-bridge/runs` history from your terminal at any time:

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

The registration installer writes environment variables into the host MCP configuration. The server does not automatically load `.env` files. See [`.env.example`](.env.example) in the source repository for a reference template.

| Variable | Default | Description |
| --- | --- | --- |
| `AGY_ALLOWED_ROOTS` | Server start directory | Allowed workspace roots; separated by `;` on Windows and `:` on macOS/Linux. |
| `AGY_BIN` | Auto-discovered | Exact `agy` executable or command name. |
| `AGY_RUNS_DIR` | `.antigravity-bridge/runs` | Local NDJSON event directory. |
| `AGY_DEFAULT_TIMEOUT_SECONDS` | `900` | Default worker-turn timeout. |
| `AGY_MAX_STDERR_BYTES` | `32768` | Maximum captured stderr per worker. |
| `AGY_MODEL` | Unset | Optional fixed model. |
| `AGY_EFFORT` | Unset | `low`, `medium`, `high`, `xhigh`, or `max`. |
| `AGY_SANDBOX` | `false` | Enable Antigravity sandbox mode. |
| `AGY_DANGEROUSLY_SKIP_PERMISSIONS` | `false` | Bypass prompts; not recommended. |
| `AGY_DASHBOARD_ENABLED` | `true` | Enable local read-only web dashboard. |
| `AGY_DASHBOARD_PORT` | `0` | Port for dashboard HTTP server (`0` for dynamic ephemeral port). |

## Safety properties

- Commands use argument arrays with `shell: false`.
- Workspace paths are canonicalized and checked against `AGY_ALLOWED_ROOTS`.
- `wait_task` holds one abortable request until terminal state and returns a bounded compact result, avoiding periodic controller wake-ups and the normal follow-up inspection call.
- MCP Tasks uses the official `@modelcontextprotocol/ext-tasks` V2 schemas. The Antigravity `job_id` is the durable MCP `taskId`; terminal `tasks/get` responses include the same bounded inspection payload that previously required a separate `inspect_task` call.
- Inspection, stderr, model output, and persisted fields are bounded.
- Environment variables are excluded from event logs.
- Empty `SUCCESS` responses and denied actions remain visible as failures or diagnostics.
- Local read-only dashboard binds strictly to `127.0.0.1`, enforces per-process bearer tokens, validates `Host` headers against DNS rebinding, serves strict CSP headers, and employs safe DOM text APIs with zero external assets.
- Runtime logs, scratch files, dependencies, build output, and secrets are excluded from Git.

## Update

```bash
git pull
npm ci
npm test
npm run build
codex mcp remove antigravity-bridge
npm run register:codex -- --root "/path/to/projects"
```

For Claude Code, replace the two commands above with `claude mcp remove antigravity-bridge --scope user` and `npm run register:claude -- ...`.

Registration is replaced as a whole. Include every allowed root when registering again.

## Remove

```bash
codex mcp remove antigravity-bridge
```

Claude Code:

```bash
claude mcp remove antigravity-bridge --scope user
```

This removes the MCP registration but does not delete the repository or local run logs.

## Troubleshooting

- **`agy` not found:** install and authenticate `agy`, add it to `PATH`, or pass `--agy-bin`.
- **Workspace rejected:** register its canonical parent directory with `--root`.
- **Tools missing:** verify registration, then start a new Codex task or restart Claude Code.
- **Registration exists:** remove the existing entry before registering again.
- **Action denied:** grant only the narrow Antigravity permission required by the task.

## Development

```bash
npm test
npm run typecheck
npm run smoke
npm audit --audit-level=high
npm pack --dry-run
```

CI runs these checks on Windows and Ubuntu with Node.js 20 and 22.

## License

MIT. See [LICENSE](LICENSE).
