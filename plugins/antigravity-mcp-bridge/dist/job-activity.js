import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { normalizeDeniedAction } from "./agy-protocol.js";
const MAX_FILES_CHANGED = 20;
const MAX_TARGET_CHARS = 120;
const DENIAL_MESSAGE = /permission check failed|denied permission|auto-denied/i;
const DISPLAY_NAMES = { view_file: "ViewFile", run_command: "RunCommand" };
const PATH_KEYS = ["TargetFile", "AbsolutePath", "FilePath", "file_path", "path"];
function record(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}
function toolInfo(step) {
    return record(step.tool_info);
}
function toolName(step) {
    const info = toolInfo(step);
    const name = typeof step.tool_name === "string" ? step.tool_name : info?.name;
    return typeof name === "string" ? name : "";
}
function toolParameters(step) {
    return record(toolInfo(step)?.parameters) ?? {};
}
function toolErrorMessage(step) {
    const error = record(toolInfo(step)?.error);
    return typeof error?.message === "string" ? error.message : undefined;
}
function firstString(source, keys) {
    for (const key of keys) {
        const value = source[key];
        if (typeof value === "string" && value.trim())
            return value.trim();
    }
    return undefined;
}
function isToolStep(step) {
    return String(step.step_type ?? "").toLowerCase() === "tool" || toolName(step) !== "" || toolInfo(step) !== undefined;
}
export function isCommandTool(name) {
    return /(run|exec|execute)_?(command|shell)|^(shell|bash)$/i.test(name);
}
export function isFileWritingTool(name) {
    const lower = name.toLowerCase();
    if (/^(view|read|list|find|grep|search|get)/.test(lower))
        return false;
    return /(write|edit|replace|create|delete|remove|overwrite|rename|move|patch)/.test(lower) && /(file|patch)/.test(lower);
}
/** Truncate a command/path target so one denial never bloats a payload. */
export function boundTarget(target) {
    const single = target.replace(/\s+/g, " ").trim();
    return single.length > MAX_TARGET_CHARS ? `${single.slice(0, MAX_TARGET_CHARS)}...` : single;
}
/**
 * Normalized denial entry for a tool step that agy rejected with a permission
 * error, e.g. `ViewFile (read_file): <path>`. Returns undefined otherwise.
 */
export function stepDenial(step) {
    const message = toolErrorMessage(step);
    if (!message || !DENIAL_MESSAGE.test(message))
        return undefined;
    const name = toolName(step);
    const action = /permission check failed for (\w+)/i.exec(message)?.[1] ?? /denied permission for (\w+)/i.exec(message)?.[1];
    const parameters = toolParameters(step);
    const target = isCommandTool(name)
        ? firstString(parameters, ["CommandLine", "command"])
        : firstString(parameters, PATH_KEYS);
    return normalizeDeniedAction({
        display_name: DISPLAY_NAMES[name] ?? (name || action || "tool"),
        action: action ?? name,
        ...(target ? { detail: boundTarget(target) } : {})
    });
}
/** Add an entry unless an equal or more specific one (with a target) is already present. */
export function addDeniedAction(list, entry) {
    if (!entry || list.includes(entry))
        return;
    if (list.some((existing) => existing.startsWith(`${entry}: `)))
        return;
    const bare = list.findIndex((existing) => entry.startsWith(`${existing}: `));
    if (bare >= 0)
        list[bare] = entry;
    else
        list.push(entry);
}
/** The CommandLine of the most recent command-running step, for attributing a result-level command denial. */
export function lastCommandLine(steps) {
    for (let index = steps.length - 1; index >= 0; index -= 1) {
        const step = steps[index];
        if (!isCommandTool(toolName(step)))
            continue;
        const line = firstString(toolParameters(step), ["CommandLine", "command"]);
        if (line)
            return boundTarget(line);
    }
    return undefined;
}
/**
 * Attach a target to a result-level denial that has none: a denied command
 * shows no step error, so the closest evidence is the last command step.
 */
export function withCommandTarget(entry, steps) {
    if (entry.includes(": ") || !/\(command\)|^command$/i.test(entry))
        return entry;
    const line = lastCommandLine(steps);
    return line ? `${entry}: ${line}` : entry;
}
/** Summarize one job's tool steps. agy emits several updates per step, so each step_index counts once. */
export function summarizeToolActivity(steps) {
    const byStep = new Map();
    let anonymous = 0;
    for (const step of steps) {
        if (!isToolStep(step))
            continue;
        const index = typeof step.step_index === "number" ? `i${step.step_index}` : `a${anonymous++}`;
        const merged = byStep.get(index) ?? { name: "", parameters: {}, errored: false, tool: true };
        merged.name ||= toolName(step);
        Object.assign(merged.parameters, toolParameters(step));
        if (toolErrorMessage(step) !== undefined || String(step.state ?? "").toUpperCase() === "ERROR")
            merged.errored = true;
        byStep.set(index, merged);
    }
    const files = [];
    let commands = 0;
    let errors = 0;
    for (const step of byStep.values()) {
        if (step.errored)
            errors += 1;
        if (isCommandTool(step.name))
            commands += 1;
        if (isFileWritingTool(step.name) && !step.errored) {
            const target = firstString(step.parameters, PATH_KEYS);
            if (target && !files.includes(target) && files.length < MAX_FILES_CHANGED)
                files.push(target);
        }
    }
    return { tool_calls: byStep.size, files_changed: files, commands_run: commands, tool_errors: errors };
}
/** The agy stderr line explaining an auto-denied permission, when one was printed. */
export function extractStderrHint(stderr) {
    for (const line of stderr.split(/\r?\n/)) {
        if (/auto-denied|permission that headless mode cannot prompt/i.test(line))
            return line.trim().slice(0, 600);
    }
    return undefined;
}
function samePath(a, b) {
    return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}
/** The permission named by agy's headless auto-deny stderr line (e.g. `command`), when one was printed. */
export function stderrDeniedPermission(stderr) {
    return /required the "([\w-]+)" permission[^\n]*auto-denied/i.exec(stderr)?.[1];
}
function isUnder(candidate, dir) {
    const relative = path.relative(dir, candidate);
    return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}
/** Best effort, never throws: the real path when a denied target is a symlink/junction alias of an allowed directory. */
export function aliasRealPath(target, allowedDirs) {
    try {
        if (!path.isAbsolute(target) || !existsSync(target))
            return undefined;
        const real = realpathSync.native(target);
        if (samePath(path.resolve(target), real))
            return undefined;
        const roots = allowedDirs.map((dir) => {
            try {
                return realpathSync.native(dir);
            }
            catch {
                return dir;
            }
        });
        return roots.some((root) => isUnder(real, root)) ? real : undefined;
    }
    catch {
        return undefined;
    }
}
/** Attention signals for a job. These never change the job status. */
export function buildJobWarnings(input) {
    const warnings = [];
    if (input.deniedActions.length > 0) {
        const listed = input.deniedActions.slice(0, 5).join("; ");
        const more = input.deniedActions.length > 5 ? ` (+${input.deniedActions.length - 5} more)` : "";
        const lines = [
            `${input.deniedActions.length} action(s) were denied: ${listed}${more}. Headless Antigravity auto-denies permissions it cannot prompt for, and the turn often ends early; verify the response and the workspace before accepting it.`,
            "Reads outside the workspace need the directory in add_dirs (config file or AGY_ADD_DIRS), using the real path rather than a symlink/junction alias; commands need an allow rule in Antigravity's settings (permissions.allow)."
        ];
        if (input.stderrHint)
            lines.push(`Antigravity stderr: ${input.stderrHint}`);
        warnings.push(lines.join(" "));
        for (const entry of input.deniedActions) {
            const target = /: (.+)$/.exec(entry)?.[1];
            const real = target ? aliasRealPath(target, input.allowedDirs ?? []) : undefined;
            if (real)
                warnings.push(`Denied path ${target} is an alias; use the real path ${real}.`);
        }
    }
    if (input.untrustedDeniedBaseline) {
        warnings.push("Antigravity's cumulative denial list could not be attributed to this job (the conversation was resumed after an interrupted turn); only step-level denials are reported.");
    }
    if (input.role === "tester" && input.toolActivity && input.toolActivity.files_changed.length > 0) {
        warnings.push(`Tester modified ${input.toolActivity.files_changed.length} file(s): ${input.toolActivity.files_changed.slice(0, 5).join(", ")}. Testers are launched with --mode plan, which current agy ignores, so they are not enforced read-only; review the diff.`);
    }
    if (input.role === "implementer" && input.status === "succeeded" && input.toolActivity && input.toolActivity.files_changed.length === 0) {
        const ranCommands = input.toolActivity.commands_run > 0 ? " Commands ran and may have modified files." : "";
        warnings.push(`Implementer finished without changing any file; verify the response before accepting it.${ranCommands}`);
    }
    return warnings;
}
//# sourceMappingURL=job-activity.js.map