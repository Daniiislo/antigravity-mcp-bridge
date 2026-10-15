# Antigravity MCP Bridge

Turn [Codex](https://developers.openai.com/codex/) or [Claude Code](https://claude.com/claude-code) into an orchestrator that delegates implementation and testing to persistent [Antigravity](https://antigravity.google) CLI (`agy`) workers.

```text
you ↔ Codex/Claude (orchestrator) ⇆ Antigravity Bridge (this MCP server) ⇆ agy workers (implementer / tester)
```

- **Persistent workers** — each worker keeps its conversation and workspace across tasks; resume the same implementer for follow-up fixes instead of re-explaining context.
- **Async jobs** — dispatch a brief, get the result when it finishes (MCP Tasks when the host supports it, one terminal wait otherwise). No polling loops.
- **Live dashboard** — watch conversations, steps, and tool calls of every worker in a local read-only web UI.
- **Deadline with grace** — near the time limit workers are asked to wrap up, so a result returned in the final window is a normal handoff, not a lost turn.
- **Bounded and audited** — every job is persisted as NDJSON history; briefs, stderr, and inspection payloads are size-capped; workers stay inside the workspace roots you allow.

## Requirements

- Codex CLI/Desktop or Claude Code
- [Antigravity CLI](https://antigravity.google) (`agy`), authenticated
- Node.js 20+ on `PATH`

## Install

**Codex:**

```bash
codex plugin marketplace add Daniiislo/antigravity-mcp-bridge --ref main
codex plugin add antigravity-mcp-bridge
```

**Claude Code:**

```bash
claude plugin marketplace add Daniiislo/antigravity-mcp-bridge
claude plugin install antigravity-mcp-bridge@antigravity-bridge
```

Restart the host after installing. The plugin ships prebuilt artifacts and bundled dependencies — no clone, build, or `npm install`.

## One required setting: allowed workspace roots

Workers may only touch directories you allow. After a marketplace install the plugin runs from its own cache, so tell the bridge where your projects live — create **one file**, once:

```jsonc
// ~/.antigravity-bridge/config.json   (Windows: %USERPROFILE%\.antigravity-bridge\config.json)
{
  "allowed_roots": [
    "C:\\Projects",      // Windows
    "D:\\work"           // add as many roots as you need
    // "/home/ada/projects"   macOS/Linux
  ]
}
```

Workers can then run in any subdirectory of those roots. Until this file exists the fallback is your user home directory; a workspace outside the allowed roots is rejected with an error that shows exactly this fix.

Prefer env variables? Set `AGY_ALLOWED_ROOTS` in your MCP server entry instead (see below) — it overrides the file.

### Optional: extra readable directories (`add_dirs`)

Workers can read their workspace only. If they must read another directory outside it (a shared skills or docs folder, for example), add it to the same file:

```jsonc
{
  "allowed_roots": ["<your-projects-dir>"],
  "add_dirs": ["<your-skills-dir>"]   // absolute paths of existing directories
}
```

Each entry is passed to every worker as an extra `--add-dir`. `AGY_ADD_DIRS` (paths separated like `AGY_ALLOWED_ROOTS`) overrides the file. Antigravity checks the literal path, so list the **real** path: a symlink or junction alias of an added directory is still denied. The effective list is reported by `runtime_info` as `add_dirs`.

## Update / Uninstall

```bash
# update (Codex)
codex plugin marketplace upgrade
codex plugin remove antigravity-mcp-bridge@antigravity-bridge && codex plugin add antigravity-mcp-bridge

# update (Claude Code)
claude plugin marketplace update antigravity-bridge
claude plugin update antigravity-mcp-bridge

# uninstall
codex plugin remove antigravity-mcp-bridge@antigravity-bridge && codex plugin marketplace remove antigravity-bridge
claude plugin uninstall antigravity-mcp-bridge && claude plugin marketplace remove antigravity-bridge
```

If removal reports a file lock, exit the host app first — a running host keeps cache files open.

## How the controller uses it

```text
create_worker → dispatch_task → (host observes completion via MCP Task)
               → wait_task (single terminal fallback)
               → send_followup → close_worker
```

18 tools cover the lifecycle: `list_models`, `runtime_info`, `create_worker`, `dispatch_task`, `wait_task`, `inspect_task`, `send_followup`, `cancel_task`, `close_worker`, `agy_history`, `open_dashboard`, `delete_task`, `clean_history`, plus compatibility tools (`agy_delegate`, `agy_status`, `agy_stop`, `agy_reset`, `agy_events`).

You don't need to teach the host any of this: the bridge serves its own usage protocol through the MCP initialize instructions, generated from live configuration, so the orchestrator always follows the rules of the exact build it is running.

### Dashboard

Say *"open dashboard"* in the host, or run `npm run dashboard` from a clone. Local loopback only, per-process token, strict CSP, zero external assets.

## Configuration

Most installs need only `allowed_roots` (above). Everything else is optional and defaults are sensible:

| Variable | Default | Purpose |
| --- | --- | --- |
| `AGY_ALLOWED_ROOTS` | config file → user home | Allowed workspace roots, `;`-separated (Windows) or `:` (macOS/Linux). |
| `AGY_ADD_DIRS` | config file `add_dirs` → none | Extra directories workers may read (`--add-dir`), same separator rules. Real paths only. |
| `AGY_BIN` | auto-discovered | `agy` executable name or path. |
| `AGY_MAX_TURN_SECONDS` | `1800` | Absolute per-job wall-clock cap. |
| `AGY_DEFAULT_INACTIVITY_TIMEOUT_SECONDS` | `300` | Stop a worker after this long without progress. |
| `AGY_MODEL` / `AGY_EFFORT` | unset | Pin a model or effort for all workers. |
| `AGY_RUNS_DIR` | per-user state dir | Where NDJSON run history is stored. |
| `AGY_DASHBOARD_ENABLED` | `true` | Local read-only dashboard. |

**Where to set them:** in your MCP server entry (`env` block of the plugin's `.mcp.json`, or the host's MCP config for manual registrations). The server does not load `.env` files. Full list with validation rules: [docs/advanced.md](docs/advanced.md#configuration-reference).

## Other MCP hosts

Any host can run the server from a clone — the repo ships prebuilt artifacts:

```bash
git clone https://github.com/Daniiislo/antigravity-mcp-bridge.git
```

Point your host at `<clone>/plugins/antigravity-mcp-bridge/dist/index.js` and set `AGY_ALLOWED_ROOTS`.

## Troubleshooting

- **`agy` not found** — install and authenticate Antigravity, put it on `PATH`, or set `AGY_BIN`.
- **Workspace rejected** — the error message includes the exact `config.json` fix.
- **Tools missing** — verify with `codex plugin list` / `claude plugin list`, restart the host.
- **Jobs stuck after a crash** — they surface as `orphaned`; inspect before replacing.

## Development

```bash
git clone https://github.com/Daniiislo/antigravity-mcp-bridge.git
cd antigravity-mcp-bridge
npm ci
npm test          # builds, then runs the full suite
npm run smoke
```

`npm run build` syncs compiled output and the production dependency closure into `plugins/antigravity-mcp-bridge/` (the marketplace payload) — commit it when changing runtime code. CI runs the suite on Windows and Ubuntu, Node 20 and 22.

## License

MIT — see [LICENSE](LICENSE).

Deep-dive: deadline and retry contracts, safety properties, token conservation notes → [docs/advanced.md](docs/advanced.md)
