import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";

/** Check only explicitly requested executables. Never execute probes or reveal PATH. */
export function checkRequiredTools(names: string[], env: NodeJS.ProcessEnv = process.env): void {
  if (names.length > 16) throw new Error("At most 16 required tools may be checked");
  const directories = (env.PATH ?? env.Path ?? "").split(path.delimiter).filter(Boolean);
  const extensions = process.platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";") : [""];
  const missing: string[] = [];
  for (const name of new Set(names)) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(name)) throw new Error("Required tools must be executable names, not commands or paths");
    const found = directories.some(directory => extensions.some(extension => {
      const candidate = path.join(directory.replace(/^"|"$/g, ""), path.extname(name) ? name : name + extension);
      try {
        if (!statSync(candidate).isFile()) return false;
        accessSync(candidate, process.platform === "win32" ? constants.F_OK : constants.X_OK);
        return true;
      } catch { return false; }
    }));
    if (!found) missing.push(name);
  }
  if (missing.length) throw new Error(`PREFLIGHT_MISSING_TOOLS: ${missing.join(", ")}. Provide the repository-native verification path before dispatch.`);
}
