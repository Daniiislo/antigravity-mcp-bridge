import { existsSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface ResolveExecutableOptions {
  env?: NodeJS.ProcessEnv | undefined;
  platform?: NodeJS.Platform | undefined;
  homedir?: string | undefined;
  cwd?: string | undefined;
  fileExists?: ((filePath: string) => boolean) | undefined;
}

function defaultFileExists(filePath: string): boolean {
  try {
    return existsSync(filePath) && statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function getPathEnv(env: NodeJS.ProcessEnv): string {
  return env.PATH || env.Path || env.path || "";
}

function getPathExt(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  if (platform !== "win32") return [""];
  const raw = env.PATHEXT || ".COM;.EXE;.BAT;.CMD";
  const exts = raw.split(";").map((e) => e.trim().toLowerCase()).filter(Boolean);
  if (!exts.includes("")) exts.push("");
  return exts;
}

function searchPathForBinary(
  binaryName: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  fileExists: (filePath: string) => boolean
): { found?: string; searched: string[] } {
  const p = platform === "win32" ? path.win32 : path.posix;
  const pathEnv = getPathEnv(env);
  const delimiter = platform === "win32" ? ";" : ":";
  const rawDirs = pathEnv.split(delimiter).map((d) => d.trim().replace(/^"|"$/g, "")).filter(Boolean);
  const dirs = platform === "win32"
    ? rawDirs.map((d) => d.replace(/%([^%]+)%/g, (_, v) => env[v] || env[v.toUpperCase()] || env[v.toLowerCase()] || `%${v}%`))
    : rawDirs;
  const extensions = getPathExt(env, platform);
  const searched: string[] = [];

  for (const dir of dirs) {
    searched.push(dir);
    for (const ext of extensions) {
      const candidateName = ext && !binaryName.toLowerCase().endsWith(ext) ? `${binaryName}${ext}` : binaryName;
      const candidatePath = p.join(dir, candidateName);
      if (fileExists(candidatePath)) {
        return { found: candidatePath, searched };
      }
    }
  }

  return { searched };
}

export function resolveAgyExecutable(options: ResolveExecutableOptions = {}): string {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const p = platform === "win32" ? path.win32 : path.posix;
  const homedir = options.homedir ?? (platform === "win32" && process.platform !== "win32" ? "C:\\Users\\default" : (platform !== "win32" && process.platform === "win32" ? "/home/default" : os.homedir()));
  const cwd = options.cwd ?? (platform === "win32" && process.platform !== "win32" ? "C:\\workspace" : (platform !== "win32" && process.platform === "win32" ? "/workspace" : process.cwd()));
  const fileExists = options.fileExists ?? defaultFileExists;

  const explicit = env.AGY_BIN?.trim();
  if (explicit) {
    const hasSep = explicit.includes("/") || explicit.includes("\\");
    if (hasSep) {
      const resolved = p.isAbsolute(explicit) ? p.normalize(explicit) : p.resolve(cwd, explicit);
      if (fileExists(resolved)) {
        return resolved;
      }
      throw new Error(
        `Configured AGY_BIN not found at: ${explicit}\n` +
        `Remedies:\n` +
        `1. Verify the file exists and is executable at: ${resolved}\n` +
        `2. Unset AGY_BIN to let the bridge discover agy automatically from PATH or default install locations.`
      );
    }

    // Bare name passed in AGY_BIN
    const pathSearchResult = searchPathForBinary(explicit, env, platform, fileExists);
    if (pathSearchResult.found) {
      return pathSearchResult.found;
    }
    const resolvedInCwd = p.resolve(cwd, explicit);
    if (fileExists(resolvedInCwd)) {
      return resolvedInCwd;
    }

    throw new Error(
      `Configured AGY_BIN "${explicit}" not found in PATH or current working directory.\n` +
      `Remedies:\n` +
      `1. Specify an absolute or relative path to the agy executable in AGY_BIN.\n` +
      `2. Ensure the directory containing "${explicit}" is added to PATH.`
    );
  }

  // Search PATH
  const pathResult = searchPathForBinary("agy", env, platform, fileExists);
  if (pathResult.found) {
    return pathResult.found;
  }

  // Search well-known per-user install locations
  const wellKnownCandidates: string[] = [];
  if (platform === "win32") {
    wellKnownCandidates.push(
      p.join(homedir, ".gemini", "antigravity-cli", "bin", "agy.cmd"),
      p.join(homedir, ".gemini", "antigravity-cli", "bin", "agy.exe"),
      p.join(homedir, ".local", "bin", "agy.cmd"),
      p.join(homedir, ".local", "bin", "agy.exe"),
      p.join(homedir, "bin", "agy.cmd"),
      p.join(homedir, "bin", "agy.exe")
    );
    const localAppData = env.LOCALAPPDATA || p.join(homedir, "AppData", "Local");
    wellKnownCandidates.push(
      p.join(localAppData, "agy", "bin", "agy.cmd"),
      p.join(localAppData, "agy", "bin", "agy.exe"),
      p.join(localAppData, "Programs", "Antigravity", "agy.exe"),
      p.join(localAppData, "antigravity", "bin", "agy.cmd"),
      p.join(localAppData, "antigravity", "bin", "agy.exe"),
      p.join(localAppData, "Programs", "agy", "agy.exe")
    );
    const appData = env.APPDATA || p.join(homedir, "AppData", "Roaming");
    wellKnownCandidates.push(
      p.join(appData, "npm", "agy.cmd"),
      p.join(appData, "npm", "agy.exe")
    );
  } else if (platform === "darwin") {
    wellKnownCandidates.push(
      p.join(homedir, ".gemini", "antigravity-cli", "bin", "agy"),
      p.join(homedir, "Library", "Application Support", "antigravity", "bin", "agy"),
      p.join(homedir, ".local", "bin", "agy"),
      p.join(homedir, "bin", "agy"),
      "/opt/homebrew/bin/agy",
      "/usr/local/bin/agy"
    );
  } else {
    // Linux and others
    wellKnownCandidates.push(
      p.join(homedir, ".gemini", "antigravity-cli", "bin", "agy"),
      p.join(homedir, ".local", "bin", "agy"),
      p.join(homedir, "bin", "agy"),
      p.join(homedir, ".cargo", "bin", "agy"),
      p.join(homedir, ".npm-global", "bin", "agy"),
      "/usr/local/bin/agy"
    );
  }

  for (const candidate of wellKnownCandidates) {
    if (fileExists(candidate)) {
      return candidate;
    }
  }

  const delimiter = platform === "win32" ? ";" : ":";
  const searchedPathSummary = pathResult.searched.length > 0 ? pathResult.searched.join(delimiter) : "(empty)";
  throw new Error(
    `Could not resolve Antigravity executable (agy).\n\n` +
    `Searched:\n` +
    `- Environment variable AGY_BIN (not set)\n` +
    `- PATH directories: ${searchedPathSummary}\n` +
    `- Well-known candidate locations:\n` +
    wellKnownCandidates.map((c) => `  * ${c}`).join("\n") + "\n\n" +
    `Remedies:\n` +
    `1. Install Antigravity CLI (agy) for your platform.\n` +
    `2. Set the AGY_BIN environment variable to the exact path of your agy executable.\n` +
    `3. Add the directory containing agy to your PATH environment variable.`
  );
}

export function resolveCodexExecutable(options: ResolveExecutableOptions = {}): string {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const p = platform === "win32" ? path.win32 : path.posix;
  const homedir = options.homedir ?? (platform === "win32" && process.platform !== "win32" ? "C:\\Users\\default" : (platform !== "win32" && process.platform === "win32" ? "/home/default" : os.homedir()));
  const cwd = options.cwd ?? (platform === "win32" && process.platform !== "win32" ? "C:\\workspace" : (platform !== "win32" && process.platform === "win32" ? "/workspace" : process.cwd()));
  const fileExists = options.fileExists ?? defaultFileExists;

  const explicit = env.CODEX_BIN?.trim();
  if (explicit) {
    const hasSep = explicit.includes("/") || explicit.includes("\\");
    if (hasSep) {
      const resolved = p.isAbsolute(explicit) ? p.normalize(explicit) : p.resolve(cwd, explicit);
      if (fileExists(resolved)) {
        return resolved;
      }
      throw new Error(
        `Configured CODEX_BIN not found at: ${explicit}\n` +
        `Remedies:\n` +
        `1. Verify the file exists and is executable at: ${resolved}\n` +
        `2. Unset CODEX_BIN to let the installer discover codex from PATH.`
      );
    }
    const pathResult = searchPathForBinary(explicit, env, platform, fileExists);
    if (pathResult.found) return pathResult.found;
    const resolvedInCwd = p.resolve(cwd, explicit);
    if (fileExists(resolvedInCwd)) return resolvedInCwd;

    throw new Error(`Configured CODEX_BIN "${explicit}" not found in PATH or cwd.`);
  }

  const pathResult = searchPathForBinary("codex", env, platform, fileExists);
  if (pathResult.found) {
    return pathResult.found;
  }

  const wellKnownCandidates: string[] = [];
  if (platform === "win32") {
    wellKnownCandidates.push(
      p.join(homedir, ".local", "bin", "codex.cmd"),
      p.join(homedir, ".local", "bin", "codex.exe")
    );
    const localAppData = env.LOCALAPPDATA || p.join(homedir, "AppData", "Local");
    wellKnownCandidates.push(
      p.join(localAppData, "Programs", "Codex", "codex.exe"),
      p.join(localAppData, "codex", "bin", "codex.cmd")
    );
    const appData = env.APPDATA || p.join(homedir, "AppData", "Roaming");
    wellKnownCandidates.push(
      p.join(appData, "npm", "codex.cmd"),
      p.join(appData, "npm", "codex.exe")
    );
  } else if (platform === "darwin") {
    wellKnownCandidates.push(
      p.join(homedir, ".local", "bin", "codex"),
      "/opt/homebrew/bin/codex",
      "/usr/local/bin/codex"
    );
  } else {
    wellKnownCandidates.push(
      p.join(homedir, ".local", "bin", "codex"),
      p.join(homedir, "bin", "codex"),
      "/usr/local/bin/codex"
    );
  }

  for (const candidate of wellKnownCandidates) {
    if (fileExists(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    `Could not resolve Codex CLI executable (codex).\n\n` +
    `Searched PATH and well-known locations.\n` +
    `Remedies:\n` +
    `1. Ensure Codex CLI is installed.\n` +
    `2. Set the CODEX_BIN environment variable or pass --codex-bin <path> to the installer.\n` +
    `3. Add the directory containing codex to your PATH.`
  );
}

export function resolveClaudeExecutable(options: ResolveExecutableOptions = {}): string {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const p = platform === "win32" ? path.win32 : path.posix;
  const homedir = options.homedir ?? (platform === "win32" && process.platform !== "win32" ? "C:\\Users\\default" : (platform !== "win32" && process.platform === "win32" ? "/home/default" : os.homedir()));
  const cwd = options.cwd ?? (platform === "win32" && process.platform !== "win32" ? "C:\\workspace" : (platform !== "win32" && process.platform === "win32" ? "/workspace" : process.cwd()));
  const fileExists = options.fileExists ?? defaultFileExists;
  const preferNativeWindowsBinary = (candidate: string): string => {
    if (platform !== "win32" || !/\.(?:cmd|bat)$/i.test(candidate)) return candidate;
    const nativeBinary = p.join(p.dirname(candidate), "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
    if (fileExists(nativeBinary)) return nativeBinary;
    throw new Error(
      `Claude Code was found only as a Windows command shim: ${candidate}\n` +
      `Install the current native Claude Code distribution or pass --claude-bin <path-to-claude.exe>.`
    );
  };

  const explicit = env.CLAUDE_BIN?.trim();
  if (explicit) {
    const hasSep = explicit.includes("/") || explicit.includes("\\");
    if (hasSep) {
      const resolved = p.isAbsolute(explicit) ? p.normalize(explicit) : p.resolve(cwd, explicit);
      if (fileExists(resolved)) return preferNativeWindowsBinary(resolved);
      throw new Error(`Configured CLAUDE_BIN not found at: ${explicit}`);
    }
    const pathResult = searchPathForBinary(explicit, env, platform, fileExists);
    if (pathResult.found) return preferNativeWindowsBinary(pathResult.found);
    const resolvedInCwd = p.resolve(cwd, explicit);
    if (fileExists(resolvedInCwd)) return preferNativeWindowsBinary(resolvedInCwd);
    throw new Error(`Configured CLAUDE_BIN "${explicit}" not found in PATH or cwd.`);
  }

  const pathResult = searchPathForBinary("claude", env, platform, fileExists);
  if (pathResult.found) return preferNativeWindowsBinary(pathResult.found);

  const candidates: string[] = platform === "win32"
    ? [
        p.join(homedir, ".local", "bin", "claude.exe"),
        p.join(homedir, ".local", "bin", "claude.cmd"),
        p.join(env.APPDATA || p.join(homedir, "AppData", "Roaming"), "npm", "claude.cmd"),
        p.join(env.APPDATA || p.join(homedir, "AppData", "Roaming"), "npm", "claude.exe")
      ]
    : [
        p.join(homedir, ".local", "bin", "claude"),
        p.join(homedir, "bin", "claude"),
        "/opt/homebrew/bin/claude",
        "/usr/local/bin/claude"
      ];

  for (const candidate of candidates) {
    if (fileExists(candidate)) return preferNativeWindowsBinary(candidate);
  }

  throw new Error(
    `Could not resolve Claude Code executable (claude).\n\n` +
    `Remedies:\n` +
    `1. Ensure Claude Code is installed.\n` +
    `2. Set CLAUDE_BIN or pass --claude-bin <path> to the installer.\n` +
    `3. Add the directory containing claude to PATH.`
  );
}
