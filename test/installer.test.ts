import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildCodexRegistration,
  executeCodexRegistration,
  formatBashCommand,
  formatPowerShellCommand,
  parseInstallerArgs,
  quoteBashArg,
  quotePowerShellArg
} from "../src/installer.js";

describe("installer CLI and Codex registration", () => {
  describe("parseInstallerArgs", () => {
    it("parses single root, name, and dry-run flag", () => {
      const parsed = parseInstallerArgs(["--root", "C:\\my-project", "--name", "my-bridge", "--dry-run"]);
      expect(parsed.roots).toEqual(["C:\\my-project"]);
      expect(parsed.name).toBe("my-bridge");
      expect(parsed.dryRun).toBe(true);
    });

    it("parses multiple --root flags", () => {
      const parsed = parseInstallerArgs([
        "--root", "/home/user/project1",
        "--root", "/home/user/project2",
        "--agy-bin", "/opt/agy",
        "--codex-bin", "/opt/codex"
      ]);
      expect(parsed.roots).toEqual(["/home/user/project1", "/home/user/project2"]);
      expect(parsed.name).toBe("antigravity-bridge");
      expect(parsed.dryRun).toBe(false);
      expect(parsed.agyBin).toBe("/opt/agy");
      expect(parsed.codexBin).toBe("/opt/codex");
    });

    it("handles comma or delimiter separated roots in a single flag", () => {
      const parsed = parseInstallerArgs(["--root", "dir1,dir2"]);
      expect(parsed.roots).toEqual(["dir1", "dir2"]);
    });

    it("defaults name to antigravity-bridge and roots to cwd if none provided", () => {
      const parsed = parseInstallerArgs([]);
      expect(parsed.name).toBe("antigravity-bridge");
      expect(parsed.roots).toEqual([process.cwd()]);
      expect(parsed.dryRun).toBe(false);
    });
  });

  describe("buildCodexRegistration", () => {
    it("builds exact command array without shell interpolation on Windows", () => {
      const root1 = "C:\\Projects\\App1";
      const root2 = "C:\\Projects\\App2";
      const agyBin = "C:\\Tools\\agy.cmd";
      const codexBin = "C:\\Tools\\codex.cmd";
      const serverScript = "C:\\Repo\\dist\\index.js";
      const nodeBin = "C:\\Node\\node.exe";

      const plan = buildCodexRegistration({
        name: "antigravity-bridge",
        roots: [root1, root2],
        agyBin,
        codexBin,
        serverScriptPath: serverScript,
        nodeBin,
        platform: "win32"
      });

      expect(plan.command).toBe(codexBin);
      expect(plan.args).toEqual([
        "mcp",
        "add",
        "antigravity-bridge",
        "--env",
        `AGY_ALLOWED_ROOTS=${root1};${root2}`,
        "--env",
        `AGY_BIN=${agyBin}`,
        "--",
        nodeBin,
        serverScript
      ]);
      expect(plan.removeCommand).toContain("mcp remove antigravity-bridge");
      expect(plan.getCommand).toContain("mcp get antigravity-bridge");
    });

    it("builds exact command array with colon delimiter on Linux/macOS", () => {
      const root1 = "/home/user/app1";
      const root2 = "/home/user/app2";
      const agyBin = "/usr/local/bin/agy";
      const codexBin = "/usr/local/bin/codex";
      const serverScript = "/repo/dist/index.js";
      const nodeBin = "/usr/bin/node";

      const plan = buildCodexRegistration({
        name: "test-bridge",
        roots: [root1, root2],
        agyBin,
        codexBin,
        serverScriptPath: serverScript,
        nodeBin,
        platform: "linux"
      });

      expect(plan.command).toBe(codexBin);
      expect(plan.args).toEqual([
        "mcp",
        "add",
        "test-bridge",
        "--env",
        `AGY_ALLOWED_ROOTS=${root1}:${root2}`,
        "--env",
        `AGY_BIN=${agyBin}`,
        "--",
        nodeBin,
        serverScript
      ]);
      expect(plan.removeCommand).toContain("mcp remove test-bridge");
    });

    it("auto-discovers agy and codex when not explicitly provided", () => {
      const existing = new Set(["/bin/codex", "/bin/agy"]);
      const fileExists = (p: string) => existing.has(p);

      const plan = buildCodexRegistration({
        roots: [process.cwd()],
        resolveOptions: {
          env: { PATH: "/bin" },
          platform: "linux",
          fileExists
        },
        platform: "linux"
      });

      expect(plan.agyBin).toBe("/bin/agy");
      expect(plan.command).toBe("/bin/codex");
    });
  });

  describe("executeCodexRegistration", () => {
    it("dry-run never invokes execution function or mutates config", async () => {
      const execFn = vi.fn();
      const plan = buildCodexRegistration({
        roots: ["/project"],
        agyBin: "/bin/agy",
        codexBin: "/bin/codex",
        platform: "linux"
      });

      const result = await executeCodexRegistration(plan, {
        dryRun: true,
        execFn
      });

      expect(result.dryRun).toBe(true);
      expect(execFn).not.toHaveBeenCalled();
    });

    it("executes command safely when dry-run is false", async () => {
      const execFn = vi.fn().mockResolvedValue({ stdout: "Added MCP server", stderr: "", exitCode: 0 });
      const plan = buildCodexRegistration({
        roots: ["/project"],
        agyBin: "/bin/agy",
        codexBin: "/bin/codex",
        platform: "linux"
      });

      const result = await executeCodexRegistration(plan, {
        dryRun: false,
        execFn
      });

      expect(result.dryRun).toBe(false);
      expect(execFn).toHaveBeenCalledWith(plan.command, plan.args);
      expect(result.stdout).toBe("Added MCP server");
    });
  });

  describe("shell quoting and human-readable representations", () => {
    it("quotes arbitrary Bash arguments safely and deterministically", () => {
      expect(quoteBashArg("simple")).toBe("simple");
      expect(quoteBashArg("/path/to/bin")).toBe("/path/to/bin");
      expect(quoteBashArg("path with spaces")).toBe("'path with spaces'");
      expect(quoteBashArg("var$name")).toBe("'var$name'");
      expect(quoteBashArg("foo&bar;baz")).toBe("'foo&bar;baz'");
      expect(quoteBashArg("don't")).toBe("'don'\\''t'");
      expect(quoteBashArg('"double"')).toBe('\'"double"\'');
      expect(quoteBashArg("back`tick`")).toBe("'back`tick`'");
    });

    it("quotes arbitrary PowerShell arguments safely and deterministically", () => {
      expect(quotePowerShellArg("simple")).toBe("simple");
      expect(quotePowerShellArg("C:\\Tools\\bin")).toBe("C:\\Tools\\bin");
      expect(quotePowerShellArg("path with spaces")).toBe("'path with spaces'");
      expect(quotePowerShellArg("$env:VAR")).toBe("'$env:VAR'");
      expect(quotePowerShellArg("foo&bar;baz")).toBe("'foo&bar;baz'");
      expect(quotePowerShellArg("don't")).toBe("'don''t'");
      expect(quotePowerShellArg('"double"')).toBe('\'"double"\'');
      expect(quotePowerShellArg("back`tick`")).toBe("'back`tick`'");
    });

    it("fails validation if argument contains unsafe control characters", () => {
      expect(() => quoteBashArg("injection\nrm -rf /")).toThrow(/unsafe control characters/i);
      expect(() => quoteBashArg("null\0byte")).toThrow(/unsafe control characters/i);
      expect(() => quotePowerShellArg("injection\r\npowik")).toThrow(/unsafe control characters/i);
    });

    it("formats PowerShell command using call operator & when command has spaces or slashes", () => {
      const formatted = formatPowerShellCommand("C:\\Program Files\\Codex\\codex.exe", [
        "mcp",
        "add",
        "my bridge",
        "--env",
        "AGY_ALLOWED_ROOTS=C:\\Path 1;C:\\Path 2"
      ]);
      expect(formatted).toBe(
        "& 'C:\\Program Files\\Codex\\codex.exe' mcp add 'my bridge' --env 'AGY_ALLOWED_ROOTS=C:\\Path 1;C:\\Path 2'"
      );
    });

    it("formats PowerShell command without call operator for bare simple commands", () => {
      const formatted = formatPowerShellCommand("codex", ["mcp", "get", "my-bridge"]);
      expect(formatted).toBe("codex mcp get my-bridge");
    });

    it("formats Bash command with safe single-quote escaping", () => {
      const formatted = formatBashCommand([
        "/opt/My Tools/codex",
        "mcp",
        "add",
        "bridge$1",
        "--env",
        "AGY_ALLOWED_ROOTS=/path/one:/path/two's"
      ]);
      expect(formatted).toBe(
        "'/opt/My Tools/codex' mcp add 'bridge$1' --env 'AGY_ALLOWED_ROOTS=/path/one:/path/two'\\''s'"
      );
    });

    it("buildCodexRegistration produces shell-safe representations while keeping args raw for spawn", () => {
      const plan = buildCodexRegistration({
        name: "bridge with spaces & $money",
        roots: ["C:\\Projects\\App 1", "C:\\Projects\\App'2"],
        agyBin: "C:\\Program Files\\agy\\agy.cmd",
        codexBin: "C:\\Program Files\\Codex\\codex.exe",
        serverScriptPath: "C:\\My Server\\dist\\index.js",
        nodeBin: "C:\\Program Files\\nodejs\\node.exe",
        platform: "win32"
      });

      // Raw command and args must remain unquoted arrays suitable for spawn(..., {shell:false})
      expect(plan.command).toBe("C:\\Program Files\\Codex\\codex.exe");
      expect(plan.args).toEqual([
        "mcp",
        "add",
        "bridge with spaces & $money",
        "--env",
        "AGY_ALLOWED_ROOTS=C:\\Projects\\App 1;C:\\Projects\\App'2",
        "--env",
        "AGY_BIN=C:\\Program Files\\agy\\agy.cmd",
        "--",
        "C:\\Program Files\\nodejs\\node.exe",
        "C:\\My Server\\dist\\index.js"
      ]);

      // PowerShell representation must be safely quoted with call operator
      expect(plan.powershellCommand).toBe(
        "& 'C:\\Program Files\\Codex\\codex.exe' mcp add 'bridge with spaces & $money' --env 'AGY_ALLOWED_ROOTS=C:\\Projects\\App 1;C:\\Projects\\App''2' --env 'AGY_BIN=C:\\Program Files\\agy\\agy.cmd' -- 'C:\\Program Files\\nodejs\\node.exe' 'C:\\My Server\\dist\\index.js'"
      );

      // Bash representation must also be safely quoted
      expect(plan.bashCommand).toBe(
        "'C:\\Program Files\\Codex\\codex.exe' mcp add 'bridge with spaces & $money' --env 'AGY_ALLOWED_ROOTS=C:\\Projects\\App 1;C:\\Projects\\App'\\''2' --env 'AGY_BIN=C:\\Program Files\\agy\\agy.cmd' -- 'C:\\Program Files\\nodejs\\node.exe' 'C:\\My Server\\dist\\index.js'"
      );

      // getCommand and removeCommand must be safely quoted
      expect(plan.getCommand).toBe(
        "& 'C:\\Program Files\\Codex\\codex.exe' mcp get 'bridge with spaces & $money'"
      );
      expect(plan.removeCommand).toBe(
        "& 'C:\\Program Files\\Codex\\codex.exe' mcp remove 'bridge with spaces & $money'"
      );
    });

    it("buildCodexRegistration throws when values contain unprintable control characters", () => {
      expect(() =>
        buildCodexRegistration({
          name: "bad\nserver",
          platform: "win32"
        })
      ).toThrow(/unsafe control characters/i);
    });
  });
});
