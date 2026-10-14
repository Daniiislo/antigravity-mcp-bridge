import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveAgyExecutable, resolveClaudeExecutable, resolveCodexExecutable } from "./resolve-executable.js";
export function parseInstallerArgs(argv) {
    let name = "antigravity-bridge";
    const roots = [];
    let agyBin;
    let codexBin;
    let claudeBin;
    let dryRun = false;
    let help = false;
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (!arg)
            continue;
        if (arg === "--name" && i + 1 < argv.length) {
            const next = argv[++i];
            if (next)
                name = next;
        }
        else if (arg.startsWith("--name=")) {
            name = arg.slice("--name=".length);
        }
        else if (arg === "--root" && i + 1 < argv.length) {
            const val = argv[++i];
            if (val) {
                for (const piece of val.split(/[,;]/)) {
                    const trimmed = piece.trim();
                    if (trimmed)
                        roots.push(trimmed);
                }
            }
        }
        else if (arg.startsWith("--root=")) {
            const val = arg.slice("--root=".length);
            for (const piece of val.split(/[,;]/)) {
                const trimmed = piece.trim();
                if (trimmed)
                    roots.push(trimmed);
            }
        }
        else if (arg === "--agy-bin" && i + 1 < argv.length) {
            agyBin = argv[++i];
        }
        else if (arg.startsWith("--agy-bin=")) {
            agyBin = arg.slice("--agy-bin=".length);
        }
        else if (arg === "--codex-bin" && i + 1 < argv.length) {
            codexBin = argv[++i];
        }
        else if (arg.startsWith("--codex-bin=")) {
            codexBin = arg.slice("--codex-bin=".length);
        }
        else if (arg === "--claude-bin" && i + 1 < argv.length) {
            claudeBin = argv[++i];
        }
        else if (arg.startsWith("--claude-bin=")) {
            claudeBin = arg.slice("--claude-bin=".length);
        }
        else if (arg === "--dry-run") {
            dryRun = true;
        }
        else if (arg === "--help" || arg === "-h") {
            help = true;
        }
    }
    if (roots.length === 0) {
        roots.push(process.cwd());
    }
    return { name, roots, agyBin, codexBin, claudeBin, dryRun, help };
}
export function validateSafeShellString(value, label = "Value") {
    if (/[\x00\r\n]/.test(value)) {
        throw new Error(`Invalid ${label}: contains unsafe control characters (newlines or null bytes) that cannot be safely represented in shell commands.`);
    }
}
export function quoteBashArg(arg) {
    validateSafeShellString(arg, "Bash argument");
    if (!arg)
        return "''";
    if (/^[a-zA-Z0-9_./:=+-]+$/.test(arg)) {
        return arg;
    }
    return `'` + arg.replace(/'/g, `'\\''`) + `'`;
}
export function quotePowerShellArg(arg) {
    validateSafeShellString(arg, "PowerShell argument");
    if (!arg)
        return "''";
    if (/^[a-zA-Z0-9_./\\=:-]+$/.test(arg) && !arg.startsWith("@")) {
        return arg;
    }
    return `'` + arg.replace(/'/g, `''`) + `'`;
}
export function formatBashCommand(parts) {
    return parts.map(quoteBashArg).join(" ");
}
export function formatPowerShellCommand(command, args) {
    validateSafeShellString(command, "PowerShell command");
    const quotedArgs = args.map(quotePowerShellArg).join(" ");
    const needsCallOp = /[\s/'"\\$`~()[\]{}*?%&|;]/.test(command);
    const quotedCommand = quotePowerShellArg(command);
    if (needsCallOp) {
        return `& ${quotedCommand}${quotedArgs ? " " + quotedArgs : ""}`;
    }
    return `${quotedCommand}${quotedArgs ? " " + quotedArgs : ""}`;
}
export function buildCodexRegistration(options = {}) {
    const platform = options.platform ?? process.platform;
    const delimiter = platform === "win32" ? ";" : ":";
    const name = options.name?.trim() || "antigravity-bridge";
    const rawRoots = options.roots && options.roots.length > 0 ? options.roots : [process.cwd()];
    const roots = rawRoots.map((r) => r.trim()).filter(Boolean);
    const rootsString = roots.join(delimiter);
    // Reject unsafe user input before executable discovery so diagnostics are
    // deterministic and invalid values never influence later command building.
    validateSafeShellString(name, "server name");
    for (const root of roots) {
        validateSafeShellString(root, "root directory");
    }
    const resolveOpts = {
        platform,
        ...(options.resolveOptions ?? {})
    };
    const agyBin = options.agyBin || resolveAgyExecutable(resolveOpts);
    const codexBin = options.codexBin || resolveCodexExecutable(resolveOpts);
    let defaultServerScript;
    try {
        const currentDir = path.dirname(fileURLToPath(import.meta.url));
        defaultServerScript = path.resolve(currentDir, "index.js");
    }
    catch {
        defaultServerScript = path.resolve(process.cwd(), "dist", "index.js");
    }
    const serverScriptPath = options.serverScriptPath || defaultServerScript;
    const nodeBin = options.nodeBin || process.execPath;
    validateSafeShellString(agyBin, "AGY binary path");
    validateSafeShellString(codexBin, "Codex binary path");
    validateSafeShellString(serverScriptPath, "server script path");
    validateSafeShellString(nodeBin, "Node binary path");
    const args = [
        "mcp",
        "add",
        name,
        "--env",
        `AGY_ALLOWED_ROOTS=${rootsString}`,
        "--env",
        `AGY_BIN=${agyBin}`,
        "--",
        nodeBin,
        serverScriptPath
    ];
    const powershellCommand = formatPowerShellCommand(codexBin, args);
    const bashCommand = formatBashCommand([codexBin, ...args]);
    const getCommand = platform === "win32"
        ? formatPowerShellCommand(codexBin, ["mcp", "get", name])
        : formatBashCommand([codexBin, "mcp", "get", name]);
    const removeCommand = platform === "win32"
        ? formatPowerShellCommand(codexBin, ["mcp", "remove", name])
        : formatBashCommand([codexBin, "mcp", "remove", name]);
    return {
        name,
        command: codexBin,
        args,
        agyBin,
        roots,
        rootsString,
        nodeBin,
        serverScriptPath,
        powershellCommand,
        bashCommand,
        getCommand,
        removeCommand
    };
}
export function buildClaudeRegistration(options = {}) {
    const platform = options.platform ?? process.platform;
    const delimiter = platform === "win32" ? ";" : ":";
    const name = options.name?.trim() || "antigravity-bridge";
    const rawRoots = options.roots && options.roots.length > 0 ? options.roots : [process.cwd()];
    const roots = rawRoots.map((root) => root.trim()).filter(Boolean);
    const rootsString = roots.join(delimiter);
    validateSafeShellString(name, "server name");
    for (const root of roots)
        validateSafeShellString(root, "root directory");
    const resolveOpts = { platform, ...(options.resolveOptions ?? {}) };
    const agyBin = options.agyBin || resolveAgyExecutable(resolveOpts);
    const claudeBin = options.claudeBin || resolveClaudeExecutable(resolveOpts);
    let defaultServerScript;
    try {
        defaultServerScript = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "index.js");
    }
    catch {
        defaultServerScript = path.resolve(process.cwd(), "dist", "index.js");
    }
    const serverScriptPath = options.serverScriptPath || defaultServerScript;
    const nodeBin = options.nodeBin || process.execPath;
    validateSafeShellString(agyBin, "AGY binary path");
    validateSafeShellString(claudeBin, "Claude binary path");
    validateSafeShellString(serverScriptPath, "server script path");
    validateSafeShellString(nodeBin, "Node binary path");
    const args = [
        "mcp", "add", name,
        "--scope", "user",
        "--env", `AGY_ALLOWED_ROOTS=${rootsString}`,
        "--env", `AGY_BIN=${agyBin}`,
        "--", nodeBin, serverScriptPath
    ];
    return {
        name,
        command: claudeBin,
        args,
        agyBin,
        roots,
        rootsString,
        nodeBin,
        serverScriptPath,
        powershellCommand: formatPowerShellCommand(claudeBin, args),
        bashCommand: formatBashCommand([claudeBin, ...args]),
        getCommand: platform === "win32"
            ? formatPowerShellCommand(claudeBin, ["mcp", "get", name])
            : formatBashCommand([claudeBin, "mcp", "get", name]),
        removeCommand: platform === "win32"
            ? formatPowerShellCommand(claudeBin, ["mcp", "remove", name, "--scope", "user"])
            : formatBashCommand([claudeBin, "mcp", "remove", name, "--scope", "user"])
    };
}
export async function executeCodexRegistration(plan, options = {}) {
    const isDryRun = Boolean(options.dryRun);
    if (isDryRun) {
        return {
            dryRun: true,
            plan
        };
    }
    const defaultExec = (cmd, args) => new Promise((resolve, reject) => {
        const child = spawn(cmd, args, {
            shell: false,
            stdio: ["ignore", "pipe", "pipe"]
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
        child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
        child.on("error", (err) => reject(new Error(`Failed to execute "${cmd}": ${err.message}`)));
        child.on("close", (exitCode) => resolve({ stdout, stderr, exitCode: exitCode ?? 0 }));
    });
    const exec = options.execFn || defaultExec;
    const res = await exec(plan.command, plan.args);
    if (res.exitCode !== 0) {
        throw new Error(`MCP registration failed with exit code ${res.exitCode}:\n${res.stderr || res.stdout}\n` +
            `Command was: ${plan.command} ${plan.args.join(" ")}\n` +
            `Safe remedy: Check permissions or run the command directly with --dry-run.`);
    }
    return {
        dryRun: false,
        plan,
        stdout: res.stdout,
        stderr: res.stderr,
        exitCode: res.exitCode
    };
}
export const executeClaudeRegistration = executeCodexRegistration;
export async function runInstallerCli(argv = process.argv.slice(2)) {
    const options = parseInstallerArgs(argv);
    if (options.help) {
        console.log(`
Antigravity Bridge - Codex MCP Global Registration

Usage:
  node scripts/register-codex.mjs [options]
  npm run register:codex -- [options]

Options:
  --root <path>       Allowed workspace root (can be specified multiple times)
  --name <name>       MCP server name (default: antigravity-bridge)
  --agy-bin <path>    Explicit path to agy executable (auto-discovered if omitted)
  --codex-bin <path>  Explicit path to codex CLI (auto-discovered if omitted)
  --dry-run           Print generated command and config without modifying Codex
  --help, -h          Show this help message

Examples:
  # Dry-run with current directory
  npm run register:codex -- --dry-run

  # Register with multiple allowed workspace roots
  npm run register:codex -- --root /path/to/project1 --root /path/to/project2

  # Windows PowerShell with explicit roots
  npm run register:codex -- --root "C:\\Projects\\App1" --root "C:\\Projects\\App2"
`);
        return;
    }
    const plan = buildCodexRegistration(options);
    if (options.dryRun) {
        console.log("\n=== Codex MCP Registration (DRY RUN) ===");
        console.log(`Server Name:           ${plan.name}`);
        console.log(`Codex Executable:      ${plan.command}`);
        console.log(`Antigravity (agy):     ${plan.agyBin}`);
        console.log(`Allowed Roots:         ${plan.rootsString}`);
        console.log(`Server Script:         ${plan.serverScriptPath}`);
        console.log("\nEquivalent Command (PowerShell):");
        console.log(`  ${plan.powershellCommand}`);
        console.log("\nEquivalent Command (Bash):");
        console.log(`  ${plan.bashCommand}`);
        console.log("\nVerification Command:");
        console.log(`  ${plan.getCommand}`);
        console.log("\nRemoval / Update Command:");
        console.log(`  ${plan.removeCommand}`);
        console.log("\nNo changes made (--dry-run enabled).\n");
        return;
    }
    console.log(`Registering "${plan.name}" with Codex...`);
    const result = await executeCodexRegistration(plan);
    console.log(`Successfully registered "${plan.name}".`);
    if (result.stdout?.trim())
        console.log(result.stdout.trim());
    console.log(`Verify registration: ${plan.getCommand}`);
    console.log(`Remove registration: ${plan.removeCommand}`);
}
export async function runClaudeInstallerCli(argv = process.argv.slice(2)) {
    const options = parseInstallerArgs(argv);
    if (options.help) {
        console.log(`
Antigravity MCP Bridge - Claude Code user registration

Usage:
  npm run register:claude -- [options]

Options:
  --root <path>        Allowed workspace root (repeatable)
  --name <name>        MCP server name (default: antigravity-bridge)
  --agy-bin <path>     Explicit agy executable
  --claude-bin <path>  Explicit Claude Code executable
  --dry-run            Print the generated command without changing Claude Code
  --help, -h           Show this help
`);
        return;
    }
    const plan = buildClaudeRegistration(options);
    if (options.dryRun) {
        console.log(process.platform === "win32" ? plan.powershellCommand : plan.bashCommand);
        return;
    }
    console.log(`Registering "${plan.name}" with Claude Code (user scope)...`);
    const result = await executeClaudeRegistration(plan);
    console.log(`Successfully registered "${plan.name}".`);
    if (result.stdout?.trim())
        console.log(result.stdout.trim());
    console.log(`Verify registration: ${plan.getCommand}`);
}
//# sourceMappingURL=installer.js.map