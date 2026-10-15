import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
/** Remove a trailing `# comment`, ignoring `#` inside quoted strings. */
function stripComment(line) {
    let quote;
    for (let i = 0; i < line.length; i += 1) {
        const ch = line[i];
        if (quote) {
            if (ch === "\\" && quote === "\"")
                i += 1;
            else if (ch === quote)
                quote = undefined;
        }
        else if (ch === "\"" || ch === "'")
            quote = ch;
        else if (ch === "#")
            return line.slice(0, i);
    }
    return line;
}
/** Bracket depth change of a line outside strings, used to join multi-line arrays. */
function bracketDelta(line) {
    let depth = 0;
    let quote;
    for (let i = 0; i < line.length; i += 1) {
        const ch = line[i];
        if (quote) {
            if (ch === "\\" && quote === "\"")
                i += 1;
            else if (ch === quote)
                quote = undefined;
        }
        else if (ch === "\"" || ch === "'")
            quote = ch;
        else if (ch === "[")
            depth += 1;
        else if (ch === "]")
            depth -= 1;
    }
    return depth;
}
function splitDotted(key) {
    const parts = [];
    let current = "";
    let quote;
    for (const ch of key.trim()) {
        if (quote) {
            if (ch === quote)
                quote = undefined;
            else
                current += ch;
        }
        else if (ch === "\"" || ch === "'")
            quote = ch;
        else if (ch === ".") {
            parts.push(current.trim());
            current = "";
        }
        else
            current += ch;
    }
    parts.push(current.trim());
    return parts;
}
function parseStrings(raw) {
    const items = [];
    const pattern = /"((?:[^"\\]|\\.)*)"|'([^']*)'/g;
    let match;
    while ((match = pattern.exec(raw)) !== null) {
        items.push(match[1] !== undefined ? match[1].replace(/\\(.)/g, "$1") : match[2]);
    }
    return items;
}
function parseString(raw) {
    const trimmed = raw.trim();
    if (!/^(".*"|'.*')$/.test(trimmed))
        return undefined;
    return parseStrings(trimmed)?.[0];
}
/**
 * Targeted TOML reader: only `features.code_mode.direct_only_tool_namespaces`
 * and the command/args/tool_timeout_sec of each `mcp_servers.<name>` table.
 * Everything else is skipped.
 */
export function parseCodexConfig(text) {
    const summary = { servers: [] };
    let table = [];
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
        const line = stripComment(lines[index]).trim();
        if (!line)
            continue;
        const header = /^\[([^\[\]].*)\]$/.exec(line);
        if (header) {
            table = splitDotted(header[1]);
            continue;
        }
        if (line.startsWith("[[")) {
            table = ["<array>"];
            continue;
        }
        const equals = line.indexOf("=");
        if (equals < 0)
            continue;
        const keyPath = [...table, ...splitDotted(line.slice(0, equals))];
        let value = line.slice(equals + 1).trim();
        let depth = bracketDelta(value);
        while (depth > 0 && index + 1 < lines.length) {
            index += 1;
            const next = stripComment(lines[index]);
            value += ` ${next.trim()}`;
            depth += bracketDelta(next);
        }
        const joined = keyPath.join("\u0000");
        if (joined === ["features", "code_mode", "direct_only_tool_namespaces"].join("\u0000")) {
            summary.directOnlyNamespaces = parseStrings(value);
            continue;
        }
        if (keyPath[0] === "mcp_servers" && keyPath.length === 3) {
            const name = keyPath[1];
            let entry = summary.servers.find((server) => server.name === name);
            if (!entry) {
                entry = { name, args: [] };
                summary.servers.push(entry);
            }
            if (keyPath[2] === "command")
                entry.command = parseString(value);
            else if (keyPath[2] === "args")
                entry.args = parseStrings(value) ?? [];
            else if (keyPath[2] === "tool_timeout_sec" && /^\d+$/.test(value.replace(/_/g, "")))
                entry.toolTimeoutSec = Number(value.replace(/_/g, ""));
        }
    }
    return summary;
}
export function resolveCodexConfigPath(env = process.env, homeDirectory = homedir()) {
    const codexHome = env.CODEX_HOME?.trim();
    return path.join(codexHome || path.join(homeDirectory, ".codex"), "config.toml");
}
const DEFAULT_NAMESPACE = "mcp__antigravity_bridge";
/** Claude Code reads these from its own environment, which an MCP server process normally inherits. */
function claudeTimeoutWarnings(options) {
    const env = options.env ?? process.env;
    const neededMs = ((options.budgetSeconds ?? 1_800) + 100) * 1_000;
    const warnings = [];
    for (const [name, effect] of [
        ["MCP_TOOL_TIMEOUT", "cuts a long wait_task off while the job is still running"],
        ["CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT", "can end a long wait_task that is idle for that long"]
    ]) {
        const raw = env[name]?.trim();
        if (!raw)
            continue;
        const value = Number(raw);
        if (Number.isFinite(value) && value > 0 && value < neededMs) {
            warnings.push(`${name}=${raw} (ms) is below the job budget (${options.budgetSeconds ?? 1_800}s plus margin) and ${effect}. Unset it or raise it above ${neededMs} (see README 'Host configuration').`);
        }
    }
    return warnings;
}
export function hostWarnings(options) {
    if (options.clientName && /claude/i.test(options.clientName))
        return claudeTimeoutWarnings(options);
    if (!options.clientName || !/codex/i.test(options.clientName))
        return [];
    let summary;
    try {
        const file = resolveCodexConfigPath(options.env ?? process.env, options.homeDirectory);
        summary = parseCodexConfig((options.reader ?? ((target) => readFileSync(target, "utf8")))(file));
    }
    catch {
        return [];
    }
    const warnings = [];
    const listed = summary.directOnlyNamespaces ?? [];
    if (!listed.some((entry) => entry === DEFAULT_NAMESPACE || /^mcp__.*antigravity/i.test(entry))) {
        warnings.push("Codex may wrap bridge tool calls in its code-mode exec and make the model poll, which costs a full model turn per poll. " +
            `Add to Codex config.toml: [features.code_mode] direct_only_tool_namespaces = ["${DEFAULT_NAMESPACE}"] (keep existing entries; see README "Host configuration").`);
    }
    const needed = Math.max(1_900, (options.budgetSeconds ?? 0) + 100);
    for (const server of summary.servers) {
        const references = [server.command ?? "", ...server.args].join(" ");
        if (!/antigravity/i.test(references) || !/index\.js/.test(references))
            continue;
        if ((server.toolTimeoutSec ?? 300) < needed) {
            warnings.push(`Codex tool_timeout_sec for [mcp_servers.${server.name}] is ${server.toolTimeoutSec ?? "unset (Codex default 300)"}s, below the job budget; wait_task will be cut short. ` +
                `Set tool_timeout_sec = ${Math.max(3_600, needed)} in that table (see README "Host configuration").`);
        }
    }
    return warnings;
}
//# sourceMappingURL=host-check.js.map