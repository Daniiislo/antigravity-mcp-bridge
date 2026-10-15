import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/**
 * Read-only Codex configuration self-check. The bridge cannot change the host,
 * but a missing direct-only namespace or a short tool timeout silently turns
 * one `wait_task` into model-driven polling, so it warns instead. Every failure
 * path (no file, unreadable, unparseable) yields no warning and never throws.
 */

export interface CodexServerEntry {
  name: string;
  command?: string | undefined;
  args: string[];
  toolTimeoutSec?: number | undefined;
}

export interface CodexConfigSummary {
  /** Undefined when the key is absent. */
  directOnlyNamespaces?: string[] | undefined;
  servers: CodexServerEntry[];
}

/** Remove a trailing `# comment`, ignoring `#` inside quoted strings. */
function stripComment(line: string): string {
  let quote: string | undefined;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (quote) {
      if (ch === "\\" && quote === "\"") i += 1;
      else if (ch === quote) quote = undefined;
    } else if (ch === "\"" || ch === "'") quote = ch;
    else if (ch === "#") return line.slice(0, i);
  }
  return line;
}

/** Bracket depth change of a line outside strings, used to join multi-line arrays. */
function bracketDelta(line: string): number {
  let depth = 0;
  let quote: string | undefined;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (quote) {
      if (ch === "\\" && quote === "\"") i += 1;
      else if (ch === quote) quote = undefined;
    } else if (ch === "\"" || ch === "'") quote = ch;
    else if (ch === "[") depth += 1;
    else if (ch === "]") depth -= 1;
  }
  return depth;
}

function splitDotted(key: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: string | undefined;
  for (const ch of key.trim()) {
    if (quote) {
      if (ch === quote) quote = undefined;
      else current += ch;
    } else if (ch === "\"" || ch === "'") quote = ch;
    else if (ch === ".") {
      parts.push(current.trim());
      current = "";
    } else current += ch;
  }
  parts.push(current.trim());
  return parts;
}

function parseStrings(raw: string): string[] | undefined {
  const items: string[] = [];
  const pattern = /"((?:[^"\\]|\\.)*)"|'([^']*)'/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(raw)) !== null) {
    items.push(match[1] !== undefined ? match[1].replace(/\\(.)/g, "$1") : match[2]!);
  }
  return items;
}

function parseString(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!/^(".*"|'.*')$/.test(trimmed)) return undefined;
  return parseStrings(trimmed)?.[0];
}

/**
 * Targeted TOML reader: only `features.code_mode.direct_only_tool_namespaces`
 * and the command/args/tool_timeout_sec of each `mcp_servers.<name>` table.
 * Everything else is skipped.
 */
export function parseCodexConfig(text: string): CodexConfigSummary {
  const summary: CodexConfigSummary = { servers: [] };
  let table: string[] = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = stripComment(lines[index]!).trim();
    if (!line) continue;
    const header = /^\[([^\[\]].*)\]$/.exec(line);
    if (header) {
      table = splitDotted(header[1]!);
      continue;
    }
    if (line.startsWith("[[")) {
      table = ["<array>"];
      continue;
    }
    const equals = line.indexOf("=");
    if (equals < 0) continue;
    const keyPath = [...table, ...splitDotted(line.slice(0, equals))];
    let value = line.slice(equals + 1).trim();
    let depth = bracketDelta(value);
    while (depth > 0 && index + 1 < lines.length) {
      index += 1;
      const next = stripComment(lines[index]!);
      value += ` ${next.trim()}`;
      depth += bracketDelta(next);
    }
    const joined = keyPath.join("\u0000");
    if (joined === ["features", "code_mode", "direct_only_tool_namespaces"].join("\u0000")) {
      summary.directOnlyNamespaces = parseStrings(value);
      continue;
    }
    if (keyPath[0] === "mcp_servers" && keyPath.length === 3) {
      const name = keyPath[1]!;
      let entry = summary.servers.find((server) => server.name === name);
      if (!entry) {
        entry = { name, args: [] };
        summary.servers.push(entry);
      }
      if (keyPath[2] === "command") entry.command = parseString(value);
      else if (keyPath[2] === "args") entry.args = parseStrings(value) ?? [];
      else if (keyPath[2] === "tool_timeout_sec" && /^\d+$/.test(value.replace(/_/g, ""))) entry.toolTimeoutSec = Number(value.replace(/_/g, ""));
    }
  }
  return summary;
}

export function resolveCodexConfigPath(env: NodeJS.ProcessEnv = process.env, homeDirectory = homedir()): string {
  const codexHome = env.CODEX_HOME?.trim();
  return path.join(codexHome || path.join(homeDirectory, ".codex"), "config.toml");
}

export interface HostCheckOptions {
  clientName: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  homeDirectory?: string | undefined;
  /** Job budget in seconds; a registered server timeout must exceed it. */
  budgetSeconds?: number | undefined;
  reader?: ((file: string) => string) | undefined;
}

const DEFAULT_NAMESPACE = "mcp__antigravity_bridge";

/** Claude Code reads these from its own environment, which an MCP server process normally inherits. */
function claudeTimeoutWarnings(options: HostCheckOptions): string[] {
  const env = options.env ?? process.env;
  const neededMs = ((options.budgetSeconds ?? 1_800) + 100) * 1_000;
  const warnings: string[] = [];
  for (const [name, effect] of [
    ["MCP_TOOL_TIMEOUT", "cuts a long wait_task off while the job is still running"],
    ["CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT", "can end a long wait_task that is idle for that long"]
  ] as const) {
    const raw = env[name]?.trim();
    if (!raw) continue;
    const value = Number(raw);
    if (Number.isFinite(value) && value > 0 && value < neededMs) {
      warnings.push(`${name}=${raw} (ms) is below the job budget (${options.budgetSeconds ?? 1_800}s plus margin) and ${effect}. Unset it or raise it above ${neededMs} (see README 'Host configuration').`);
    }
  }
  return warnings;
}

export function hostWarnings(options: HostCheckOptions): string[] {
  if (options.clientName && /claude/i.test(options.clientName)) return claudeTimeoutWarnings(options);
  if (!options.clientName || !/codex/i.test(options.clientName)) return [];
  let summary: CodexConfigSummary;
  try {
    const file = resolveCodexConfigPath(options.env ?? process.env, options.homeDirectory);
    summary = parseCodexConfig((options.reader ?? ((target) => readFileSync(target, "utf8")))(file));
  } catch {
    return [];
  }
  const warnings: string[] = [];
  const listed = summary.directOnlyNamespaces ?? [];
  if (!listed.some((entry) => entry === DEFAULT_NAMESPACE || /^mcp__.*antigravity/i.test(entry))) {
    warnings.push(
      "Codex may wrap bridge tool calls in its code-mode exec and make the model poll, which costs a full model turn per poll. " +
      `Add to Codex config.toml: [features.code_mode] direct_only_tool_namespaces = ["${DEFAULT_NAMESPACE}"] (keep existing entries; see README "Host configuration").`
    );
  }
  const needed = Math.max(1_900, (options.budgetSeconds ?? 0) + 100);
  for (const server of summary.servers) {
    const references = [server.command ?? "", ...server.args].join(" ");
    if (!/antigravity/i.test(references) || !/index\.js/.test(references)) continue;
    if ((server.toolTimeoutSec ?? 300) < needed) {
      warnings.push(
        `Codex tool_timeout_sec for [mcp_servers.${server.name}] is ${server.toolTimeoutSec ?? "unset (Codex default 300)"}s, below the job budget; wait_task will be cut short. ` +
        `Set tool_timeout_sec = ${Math.max(3_600, needed)} in that table (see README "Host configuration").`
      );
    }
  }
  return warnings;
}
