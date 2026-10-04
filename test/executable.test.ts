import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveAgyExecutable, resolveClaudeExecutable, resolveCodexExecutable } from "../src/resolve-executable.js";

describe("resolveAgyExecutable", () => {
  describe("Windows simulated platform (path.win32)", () => {
    it("explicit AGY_BIN with backslash absolute path wins", () => {
      const customBin = "C:\\custom\\tools\\agy.exe";
      const existing = new Set([customBin]);
      const fileExists = (p: string) => existing.has(p);

      const result = resolveAgyExecutable({
        env: { AGY_BIN: customBin },
        platform: "win32",
        fileExists
      });

      expect(result).toBe(customBin);
    });

    it("explicit AGY_BIN with forward-slash absolute path normalizes to win32 path", () => {
      const customBin = "C:/custom/tools/agy.exe";
      const expected = path.win32.normalize(customBin); // C:\custom\tools\agy.exe
      const existing = new Set([expected]);
      const fileExists = (p: string) => existing.has(p);

      const result = resolveAgyExecutable({
        env: { AGY_BIN: customBin },
        platform: "win32",
        fileExists
      });

      expect(result).toBe(expected);
    });

    it("explicit AGY_BIN with backslash relative path resolves against cwd", () => {
      const cwd = "C:\\workspace";
      const relativeBin = ".\\bin\\agy.cmd";
      const expected = path.win32.resolve(cwd, relativeBin);
      const existing = new Set([expected]);
      const fileExists = (p: string) => existing.has(p);

      const result = resolveAgyExecutable({
        env: { AGY_BIN: relativeBin },
        cwd,
        platform: "win32",
        fileExists
      });

      expect(result).toBe(expected);
    });

    it("explicit AGY_BIN with forward-slash relative path resolves against cwd", () => {
      const cwd = "C:\\workspace";
      const relativeBin = "./bin/agy.cmd";
      const expected = path.win32.resolve(cwd, relativeBin);
      const existing = new Set([expected]);
      const fileExists = (p: string) => existing.has(p);

      const result = resolveAgyExecutable({
        env: { AGY_BIN: relativeBin },
        cwd,
        platform: "win32",
        fileExists
      });

      expect(result).toBe(expected);
    });

    it("explicit AGY_BIN with bare name resolves from PATH", () => {
      const pathDir = "C:\\tools\\bin";
      const binPath = path.win32.join(pathDir, "custom-agy.cmd");
      const existing = new Set([binPath]);
      const fileExists = (p: string) => existing.has(p);

      const result = resolveAgyExecutable({
        env: {
          AGY_BIN: "custom-agy.cmd",
          Path: pathDir
        },
        platform: "win32",
        fileExists
      });

      expect(result).toBe(binPath);
    });

    it("explicit AGY_BIN with bare name resolves from cwd when not in PATH", () => {
      const cwd = "C:\\workspace";
      const binPath = path.win32.resolve(cwd, "custom-agy.exe");
      const existing = new Set([binPath]);
      const fileExists = (p: string) => existing.has(p);

      const result = resolveAgyExecutable({
        env: {
          AGY_BIN: "custom-agy.exe",
          PATH: "C:\\empty"
        },
        cwd,
        platform: "win32",
        fileExists
      });

      expect(result).toBe(binPath);
    });

    it("searches PATH on Windows without a shell and respects PATHEXT", () => {
      const pathDir = "C:\\tools\\bin";
      const binPath = path.win32.join(pathDir, "agy.cmd");
      const existing = new Set([binPath]);
      const fileExists = (p: string) => existing.has(p);

      const result = resolveAgyExecutable({
        env: {
          Path: pathDir,
          PATHEXT: ".COM;.EXE;.BAT;.CMD"
        },
        platform: "win32",
        fileExists
      });

      expect(result).toBe(binPath);
    });

    it("searches PATH with multiple semicolon-separated directories and case-insensitive env", () => {
      const dir1 = "C:\\dir1";
      const dir2 = "C:\\tools with spaces\\bin";
      const binPath = path.win32.join(dir2, "agy.exe");
      const existing = new Set([binPath]);
      const fileExists = (p: string) => existing.has(p);

      const result = resolveAgyExecutable({
        env: {
          PATH: `${dir1};"${dir2}"`,
          pathext: ".EXE;.CMD"
        },
        platform: "win32",
        fileExists
      });

      expect(result).toBe(binPath);
    });

    it("falls back to well-known per-user install locations on Windows when not in PATH", () => {
      const homedir = "C:\\Users\\testuser";
      const expected = `${homedir}\\.gemini\\antigravity-cli\\bin\\agy.cmd`;
      const existing = new Set([expected]);
      const fileExists = (p: string) => existing.has(p);

      const result = resolveAgyExecutable({
        env: { PATH: "C:\\empty" },
        platform: "win32",
        homedir,
        fileExists
      });

      expect(result).toBe(expected);
    });

    it("does not scan arbitrary drives or directories on Windows", () => {
      const checkedPaths: string[] = [];
      const fileExists = (p: string) => {
        checkedPaths.push(p);
        return false;
      };

      try {
        resolveAgyExecutable({
          env: { PATH: "C:\\Tools" },
          platform: "win32",
          homedir: "C:\\Users\\testuser",
          fileExists
        });
      } catch {
        // Expected to fail
      }

      expect(checkedPaths.length).toBeGreaterThan(0);
      expect(checkedPaths.length).toBeLessThan(30);
      for (const p of checkedPaths) {
        expect(p).toMatch(/agy(\.exe|\.cmd|\.bat|\.com)?$/i);
      }
    });
  });

  describe("POSIX simulated platforms (path.posix)", () => {
    it("explicit AGY_BIN wins when pointing to an existing POSIX file", () => {
      const customBin = "/custom/tools/agy";
      const existing = new Set([customBin]);
      const fileExists = (p: string) => existing.has(p);

      const result = resolveAgyExecutable({
        env: { AGY_BIN: customBin },
        platform: "linux",
        fileExists
      });

      expect(result).toBe(customBin);
    });

    it("explicit AGY_BIN with relative path resolves against cwd on POSIX", () => {
      const cwd = "/workspace";
      const relativeBin = "./bin/agy";
      const expected = path.posix.resolve(cwd, relativeBin);
      const existing = new Set([expected]);
      const fileExists = (p: string) => existing.has(p);

      const result = resolveAgyExecutable({
        env: { AGY_BIN: relativeBin },
        cwd,
        platform: "linux",
        fileExists
      });

      expect(result).toBe(expected);
    });

    it("searches PATH on Linux without a shell", () => {
      const pathDir = "/usr/bin";
      const binPath = `${pathDir}/agy`;
      const existing = new Set([binPath]);
      const fileExists = (p: string) => existing.has(p);

      const result = resolveAgyExecutable({
        env: { PATH: `/bin:${pathDir}` },
        platform: "linux",
        fileExists
      });

      expect(result).toBe(binPath);
    });

    it("falls back to well-known per-user install locations on Linux when not in PATH", () => {
      const homedir = "/home/testuser";
      const expected = `${homedir}/.local/bin/agy`;
      const existing = new Set([expected]);
      const fileExists = (p: string) => existing.has(p);

      const result = resolveAgyExecutable({
        env: { PATH: "/bin" },
        platform: "linux",
        homedir,
        fileExists
      });

      expect(result).toBe(expected);
    });

    it("falls back to well-known per-user install locations on macOS when not in PATH", () => {
      const homedir = "/Users/testuser";
      const expected = "/opt/homebrew/bin/agy";
      const existing = new Set([expected]);
      const fileExists = (p: string) => existing.has(p);

      const result = resolveAgyExecutable({
        env: { PATH: "/usr/bin" },
        platform: "darwin",
        homedir,
        fileExists
      });

      expect(result).toBe(expected);
    });

    it("throws an actionable error listing safe remedies if agy is not found anywhere", () => {
      const fileExists = () => false;

      let thrown: Error | undefined;
      try {
        resolveAgyExecutable({
          env: { PATH: "" },
          platform: "linux",
          homedir: "/home/testuser",
          fileExists
        });
      } catch (err) {
        thrown = err as Error;
      }

      expect(thrown).toBeDefined();
      expect(thrown!.message).toContain("Could not resolve Antigravity executable (agy)");
      expect(thrown!.message).toContain("Remedies:");
      expect(thrown!.message).toContain("AGY_BIN");
      expect(thrown!.message).toContain("PATH");
    });
  });
});

describe("resolveCodexExecutable", () => {
  it("explicit CODEX_BIN wins on Windows (path.win32)", () => {
    const customCodex = "C:\\custom\\bin\\codex.cmd";
    const existing = new Set([customCodex]);
    const result = resolveCodexExecutable({
      env: { CODEX_BIN: customCodex },
      platform: "win32",
      fileExists: (p) => existing.has(p)
    });
    expect(result).toBe(customCodex);
  });

  it("explicit CODEX_BIN wins on Linux (path.posix)", () => {
    const customCodex = "/custom/bin/codex";
    const existing = new Set([customCodex]);
    const result = resolveCodexExecutable({
      env: { CODEX_BIN: customCodex },
      platform: "linux",
      fileExists: (p) => existing.has(p)
    });
    expect(result).toBe(customCodex);
  });

  it("discovers codex in PATH on Linux", () => {
    const binDir = "/usr/local/bin";
    const codexBin = `${binDir}/codex`;
    const existing = new Set([codexBin]);
    const result = resolveCodexExecutable({
      env: { PATH: binDir },
      platform: "linux",
      fileExists: (p) => existing.has(p)
    });
    expect(result).toBe(codexBin);
  });

  it("discovers codex in PATH on Windows", () => {
    const binDir = "C:\\Tools\\bin";
    const codexBin = "C:\\Tools\\bin\\codex.exe";
    const existing = new Set([codexBin]);
    const result = resolveCodexExecutable({
      env: { Path: binDir },
      platform: "win32",
      fileExists: (p) => existing.has(p)
    });
    expect(result).toBe(codexBin);
  });
});

describe("resolveClaudeExecutable", () => {
  it("resolves a Windows npm command shim to Claude Code's native executable", () => {
    const binDir = "C:\\Tools\\bin";
    const shim = "C:\\Tools\\bin\\claude.cmd";
    const claudeBin = "C:\\Tools\\bin\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe";
    expect(resolveClaudeExecutable({
      env: { Path: binDir, PATHEXT: ".EXE;.CMD" },
      platform: "win32",
      fileExists: (candidate) => candidate === shim || candidate === claudeBin
    })).toBe(claudeBin);
  });

  it("honors CLAUDE_BIN on POSIX", () => {
    expect(resolveClaudeExecutable({
      env: { CLAUDE_BIN: "/opt/claude" },
      platform: "linux",
      fileExists: (candidate) => candidate === "/opt/claude"
    })).toBe("/opt/claude");
  });
});
