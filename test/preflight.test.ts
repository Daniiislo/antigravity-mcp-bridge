import { describe, it, expect } from "vitest";
import path from "node:path";
import { checkRequiredTools } from "../src/preflight.js";

describe("required executable preflight", () => {
  it("finds the running Node executable without invoking it", () => {
    expect(() => checkRequiredTools([path.basename(process.execPath)], { PATH: path.dirname(process.execPath) })).not.toThrow();
  });
  it("reports only missing executable names and rejects command probes", () => {
    expect(() => checkRequiredTools(["missing-tool"], { PATH: "" })).toThrow(/PREFLIGHT_MISSING_TOOLS: missing-tool/);
    expect(() => checkRequiredTools(["node --version"])).toThrow(/not commands/);
  });
});
