import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ModelCatalog } from "../src/model-catalog.js";

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "fixtures", "fake-agy.mjs");

describe("ModelCatalog", () => {
  it("discovers models from agy models output and parses conservatively", async () => {
    const catalog = new ModelCatalog({
      executable: process.execPath,
      prefixArgs: [fixture],
      ttlSeconds: 60
    });

    const result = await catalog.listModels();
    expect(result.models).toContain("gemini-3.8-flash-high");
    expect(result.models).toContain("gemini-3.8-pro-high");
    expect(result.models).toContain("gemini-2.5-pro");
    expect(result.models).toContain("gemini-2.5-flash");
    expect(result.models).toContain("claude-3-7-sonnet");
    for (const model of result.models) {
      expect(model).not.toContain("\t");
      expect(model).not.toMatch(/\s/);
      expect(model).not.toMatch(/default/i);
      expect(model).toMatch(/^[a-z0-9][a-z0-9._-]*$/);
    }
    expect(result.cached).toBe(false);
    expect(result.ttlSeconds).toBe(60);
    expect(result.cachedAt).toBeDefined();
  });

  it("serves from cache on subsequent calls unless refresh is requested", async () => {
    const catalog = new ModelCatalog({
      executable: process.execPath,
      prefixArgs: [fixture],
      ttlSeconds: 60
    });

    const first = await catalog.listModels();
    expect(first.cached).toBe(false);

    const second = await catalog.listModels();
    expect(second.cached).toBe(true);
    expect(second.cachedAt).toBe(first.cachedAt);
    expect(second.models).toEqual(first.models);

    const refreshed = await catalog.listModels({ refresh: true });
    expect(refreshed.cached).toBe(false);
  });

  it("preserves previous cache when refresh fails", async () => {
    const catalog = new ModelCatalog({
      executable: process.execPath,
      prefixArgs: [fixture],
      ttlSeconds: 60
    });

    const initial = await catalog.listModels();
    expect(initial.cached).toBe(false);

    process.env.FAKE_AGY_MODELS_FAIL = "1";
    try {
      const fallback = await catalog.listModels({ refresh: true });
      expect(fallback.cached).toBe(true);
      expect(fallback.models).toEqual(initial.models);
      expect(fallback.stale).toBe(true);
    } finally {
      delete process.env.FAKE_AGY_MODELS_FAIL;
    }
  });

  it("throws if command fails and no prior cache exists", async () => {
    const catalog = new ModelCatalog({
      executable: process.execPath,
      prefixArgs: [fixture],
      ttlSeconds: 60
    });

    process.env.FAKE_AGY_MODELS_FAIL = "1";
    try {
      await expect(catalog.listModels()).rejects.toThrow(/models/i);
    } finally {
      delete process.env.FAKE_AGY_MODELS_FAIL;
    }
  });

  it("handles table headers, comments, separators, and ignores display names/tabs", () => {
    const catalog = new ModelCatalog({
      executable: process.execPath,
      ttlSeconds: 60
    });

    const sampleOutput = [
      "# Available Antigravity Models",
      "MODEL\tDISPLAY NAME\tDEFAULT",
      "----------------------------------------",
      "gemini-3.8-flash-high\tGemini 3.8 Flash (High)\tdefault",
      "gemini-3.8-pro-high\tGemini 3.8 Pro (High)",
      "claude-3-7-sonnet\tClaude 3.7 Sonnet (Latest)",
      "gpt-4o\tGPT-4o (Omni)\t",
      "=== Deprecated ===",
      "gemini-1.5-pro\tGemini 1.5 Pro\tlegacy"
    ].join("\n");

    const parsed = (catalog as unknown as { parseModelLines: (output: string) => string[] }).parseModelLines(sampleOutput);
    expect(parsed).toEqual([
      "gemini-3.8-flash-high",
      "gemini-3.8-pro-high",
      "claude-3-7-sonnet",
      "gpt-4o",
      "gemini-1.5-pro"
    ]);
    for (const slug of parsed) {
      expect(slug).not.toContain("\t");
      expect(slug).not.toMatch(/\s/);
    }
  });

  it("times out if models command hangs", async () => {
    const catalog = new ModelCatalog({
      executable: process.execPath,
      prefixArgs: [fixture],
      ttlSeconds: 60,
      timeoutMs: 200 // short timeout for test
    });

    process.env.FAKE_AGY_MODELS_HANG = "1";
    try {
      await expect(catalog.listModels()).rejects.toThrow(/timed out after 200ms/i);
    } finally {
      delete process.env.FAKE_AGY_MODELS_HANG;
    }
  });

  it("aborts and errors if stdout exceeds buffer limit", async () => {
    const catalog = new ModelCatalog({
      executable: process.execPath,
      prefixArgs: [fixture],
      ttlSeconds: 60,
      maxBufferBytes: 1024 // 1KB limit
    });

    process.env.FAKE_AGY_MODELS_FLOOD = "1";
    try {
      await expect(catalog.listModels()).rejects.toThrow(/exceeded limit of 1024 bytes/i);
    } finally {
      delete process.env.FAKE_AGY_MODELS_FLOOD;
    }
  });

  it("returns actionable error listing remedies when models query fails without cache", async () => {
    const catalog = new ModelCatalog({
      executable: process.execPath,
      prefixArgs: [fixture],
      ttlSeconds: 60
    });

    process.env.FAKE_AGY_MODELS_FAIL = "1";
    try {
      let err: Error | undefined;
      try {
        await catalog.listModels();
      } catch (e) {
        err = e as Error;
      }
      expect(err).toBeDefined();
      expect(err!.message).toMatch(/failed to query antigravity models/i);
      expect(err!.message).toMatch(/remedies:/i);
    } finally {
      delete process.env.FAKE_AGY_MODELS_FAIL;
    }
  });

  it("falls back to previous cache if timeout occurs during refresh", async () => {
    const catalog = new ModelCatalog({
      executable: process.execPath,
      prefixArgs: [fixture],
      ttlSeconds: 60,
      timeoutMs: 200
    });

    const initial = await catalog.listModels();
    expect(initial.cached).toBe(false);

    process.env.FAKE_AGY_MODELS_HANG = "1";
    try {
      const refreshed = await catalog.listModels({ refresh: true });
      expect(refreshed.cached).toBe(true);
      expect(refreshed.stale).toBe(true);
      expect(refreshed.models).toEqual(initial.models);
    } finally {
      delete process.env.FAKE_AGY_MODELS_HANG;
    }
  });
});
