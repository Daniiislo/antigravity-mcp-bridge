# Antigravity Codex MCP Bridge

A local Model Context Protocol (MCP) server that lets Codex coordinate persistent Antigravity CLI (`agy`) workers as independent implementers and testers.

The bridge uses stdio, starts child processes without a shell, restricts workers to explicit workspace roots, and records bounded NDJSON audit events locally.

## Requirements

- Node.js 20 or newer
- Codex CLI or Codex Desktop with local MCP support
- Antigravity CLI (`agy`), authenticated for the current user
- Git

Verify the required commands:

```bash
node --version
codex --version
agy --version
```

## Install

```bash
git clone https://github.com/Daniiislo/antigravity-codex-mcp.git
cd antigravity-codex-mcp
npm ci
npm test
npm run typecheck
npm run smoke
```

The smoke test uses the compiled server and a local fake-CLI fixture. It does not consume Antigravity model quota.

## Register with Codex

`npm run register` is a portable wrapper around `codex mcp add`. It discovers the local `codex`, `agy`, Node.js, and compiled server paths, then asks Codex to register the bridge globally. Codex still owns and starts the MCP server; npm is used only to run the installer.

Preview the exact `codex mcp add` command without changing the Codex configuration:

```bash
npm run register -- --dry-run --root "/path/to/projects"
```

Register every directory that Antigravity workers may access. The first `--` tells npm to forward the remaining arguments to the installer. Each repeatable `--root` adds one directory to the bridge allowlist; it does not start or import that directory.

Windows PowerShell:

```powershell
npm run register -- --root "C:\Projects" --root "D:\Work"
```

macOS or Linux:

```bash
npm run register -- --root "$HOME/Projects" --root "/opt/work"
```

For readability, a long PowerShell command may be split with a trailing backtick (`` ` ``), while Bash uses a trailing backslash (`\`). These are shell line-continuation characters only and are not part of the installer syntax.

The installer discovers `codex` and `agy` without shell interpolation. If discovery fails, pass `--codex-bin <path>` or `--agy-bin <path>`. The generated command is equivalent to:

```text
codex mcp add antigravity-bridge --env "AGY_ALLOWED_ROOTS=<root-list>" --env "AGY_BIN=<agy-path>" -- <node-path> <bridge-dist/index.js>
```

At runtime, Codex launches the registered Node.js process over MCP stdio. The bridge then creates and supervises Antigravity workers while enforcing the registered root allowlist.

Verify the global registration:

```bash
codex mcp get antigravity-bridge
```

Start a new Codex task after registration so the MCP tool catalog is reloaded.

## Controller API

The preferred asynchronous workflow is:

```text
create_worker → dispatch_task → wait_task / agy_events
              → inspect_task → send_followup → close_worker
```

| Tool | Purpose |
| --- | --- |
| `list_models` | Discover available Antigravity models with bounded execution and caching. |
| `create_worker` | Create an isolated implementer or tester in an allowed workspace. |
| `dispatch_task` | Queue a task and return a `job_id` immediately. |
| `wait_task` | Wait up to 30 seconds for progress or terminal state. |
| `agy_events` | Poll normalized events using a cursor. |
| `inspect_task` | Read bounded results, usage, errors, tool events, and denied actions. |
| `send_followup` | Continue the same worker conversation for a fix or recheck. |
| `cancel_task` | Cancel queued or active work. |
| `close_worker` | Stop and close a worker. |
| `agy_history` | Read persisted task summaries after server restarts. |

Four compatibility tools remain available: `agy_delegate`, `agy_status`, `agy_stop`, and `agy_reset`.

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

## Safety properties

- Commands use argument arrays with `shell: false`.
- Workspace paths are canonicalized and checked against `AGY_ALLOWED_ROOTS`.
- `wait_task` is capped at 30 seconds.
- Inspection, stderr, model output, and persisted fields are bounded.
- Environment variables are excluded from event logs.
- Empty `SUCCESS` responses and denied actions remain visible as failures or diagnostics.
- Runtime logs, scratch files, dependencies, build output, and secrets are excluded from Git.

## Update

```bash
git pull
npm ci
npm test
npm run build
codex mcp remove antigravity-bridge
npm run register -- --root "/path/to/projects"
```

Registration is replaced as a whole. Include every allowed root when registering again.

## Remove

```bash
codex mcp remove antigravity-bridge
```

This removes the MCP registration but does not delete the repository or local run logs.

## Troubleshooting

- **`agy` not found:** install and authenticate `agy`, add it to `PATH`, or pass `--agy-bin`.
- **Workspace rejected:** register its canonical parent directory with `--root`.
- **Tools missing:** verify registration, then start a new Codex task.
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
