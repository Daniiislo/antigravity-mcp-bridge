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
create_worker → dispatch_task → wait_task (wait until terminal)
              → inspect_task → send_followup → close_worker
```

| Tool | Purpose |
| --- | --- |
| `list_models` | Discover available Antigravity models with bounded execution and caching. |
| `create_worker` | Create an isolated implementer or tester in an allowed workspace. |
| `dispatch_task` | Queue a task and return a `job_id` immediately. |
| `wait_task` | Bounded wait (up to 300s) for terminal state. Omit `after_cursor` for token efficiency. |
| `agy_events` | Poll normalized events using a cursor (intended for dashboards/tools). |
| `inspect_task` | Read bounded results, usage, errors, tool events, and denied actions. |
| `send_followup` | Continue the same worker conversation for a fix or recheck. |
| `cancel_task` | Cancel queued or active work. |
| `close_worker` | Stop and close a worker. |
| `agy_history` | Read persisted task summaries after server restarts. |
| `open_dashboard` | Get the local read-only dashboard URL to inspect workers, jobs, conversations, and events. |

Four compatibility tools remain available: `agy_delegate`, `agy_status`, `agy_stop`, and `agy_reset`.

### Token Conservation & Best Practices

To prevent excessive prompt token consumption in coordinating agents (such as Codex or Claude):

- **Omit `after_cursor` when waiting:** Call `wait_task({ job_id, wait_ms: 60000 })` without `after_cursor`. The call blocks until the task reaches a terminal state (`succeeded`, `failed`, or `canceled`) instead of waking the LLM on every step.
- **Inspect once on completion:** Call `inspect_task(job_id)` only after `wait_task` reports `terminal: true`.
- **Use the Web Dashboard for real-time monitoring:** Call `open_dashboard` to inspect live progress, tool calls, and logs in the local web interface without streaming raw JSON events into the LLM context window.

### Local Web Dashboard

The bridge includes an embedded, read-only local dashboard served over loopback HTTP (`127.0.0.1`):

- **Lazy start:** Starts on-demand on an ephemeral or configured port when `open_dashboard` is called or when workers/tasks are created.
- **Strict loopback & Bearer token:** Bound strictly to `127.0.0.1`, protected by a per-process 48-character hex token in the URL path, and validates `Host` headers to protect against DNS rebinding.
- **Read-only invariant:** Accepts only `GET` and `HEAD` requests; rejects mutations with `405 Method Not Allowed`.
- **Self-contained & Safe:** Zero external CDNs, fonts, or remote assets. Enforces a strict Content Security Policy and renders all content using safe DOM text APIs (no untrusted `innerHTML`).
- **Live SSE streaming:** Delivers real-time lifecycle and step events with reconnect cursor deduplication and polling fallback.
- **Dense layout:** Split-pane layout optimized for Codex side panel or browser tabs, featuring Conversation view, Activity timeline, and Raw event logs.

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
- `wait_task` is bounded up to 300 seconds (default 30s) and omits intermediate events by default to conserve tokens.
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
