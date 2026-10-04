import { spawn } from "node:child_process";

export interface ModelCatalogOptions {
  executable: string;
  prefixArgs?: string[];
  ttlSeconds?: number;
  timeoutMs?: number;
  maxBufferBytes?: number;
}

export interface ListModelsResult {
  models: string[];
  cached: boolean;
  cachedAt: string;
  ttlSeconds: number;
  stale?: boolean;
}

interface CacheEntry {
  models: string[];
  cachedAtMs: number;
  cachedAtIso: string;
}

export class ModelCatalog {
  private cache?: CacheEntry;
  private readonly ttlMs: number;
  private readonly ttlSeconds: number;
  private readonly timeoutMs: number;
  private readonly maxBufferBytes: number;

  constructor(private readonly options: ModelCatalogOptions) {
    this.ttlSeconds = options.ttlSeconds ?? 300;
    this.ttlMs = this.ttlSeconds * 1_000;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.maxBufferBytes = options.maxBufferBytes ?? 65_536;
  }

  async listModels(options?: { refresh?: boolean | undefined } | undefined): Promise<ListModelsResult> {
    const forceRefresh = Boolean(options?.refresh);
    const now = Date.now();

    if (!forceRefresh && this.cache && (now - this.cache.cachedAtMs < this.ttlMs)) {
      return {
        models: [...this.cache.models],
        cached: true,
        cachedAt: this.cache.cachedAtIso,
        ttlSeconds: this.ttlSeconds
      };
    }

    try {
      const models = await this.fetchModels();
      const nowMs = Date.now();
      const cachedAtIso = new Date(nowMs).toISOString();
      this.cache = {
        models,
        cachedAtMs: nowMs,
        cachedAtIso
      };
      return {
        models: [...models],
        cached: false,
        cachedAt: cachedAtIso,
        ttlSeconds: this.ttlSeconds
      };
    } catch (error) {
      if (this.cache) {
        return {
          models: [...this.cache.models],
          cached: true,
          cachedAt: this.cache.cachedAtIso,
          ttlSeconds: this.ttlSeconds,
          stale: true
        };
      }
      const rawMsg = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to query Antigravity models: ${rawMsg}.\n` +
        `Remedies:\n` +
        `1. Ensure Antigravity CLI (agy) is installed and operational.\n` +
        `2. Check that AGY_BIN points to the valid executable.\n` +
        `3. Test running "agy models" directly in your terminal.`
      );
    }
  }

  private fetchModels(): Promise<string[]> {
    return new Promise((resolve, reject) => {
      const args = [...(this.options.prefixArgs ?? []), "models"];
      const child = spawn(this.options.executable, args, {
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"]
      });

      let stdout = "";
      let stderr = "";
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;

      const finishReject = (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { child.kill("SIGTERM"); } catch { /* ignore */ }
        reject(err);
      };

      const finishResolve = (models: string[]) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(models);
      };

      const timer = setTimeout(() => {
        finishReject(new Error(`Antigravity models command timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > this.maxBufferBytes) {
          finishReject(new Error(`Antigravity models stdout exceeded limit of ${this.maxBufferBytes} bytes`));
          return;
        }
        stdout += chunk.toString("utf8");
      });

      child.stderr.on("data", (chunk: Buffer) => {
        stderrBytes += chunk.length;
        if (stderrBytes > this.maxBufferBytes) {
          finishReject(new Error(`Antigravity models stderr exceeded limit of ${this.maxBufferBytes} bytes`));
          return;
        }
        stderr += chunk.toString("utf8");
      });

      child.on("error", (err) => {
        finishReject(new Error(`Failed to spawn Antigravity models command: ${err.message}`));
      });

      child.on("close", (code) => {
        if (settled) return;
        if (code !== 0) {
          finishReject(new Error(`Antigravity models command failed with exit code ${code}: ${stderr.trim() || stdout.trim()}`));
          return;
        }
        const models = this.parseModelLines(stdout);
        finishResolve(models);
      });
    });
  }

  private parseModelLines(output: string): string[] {
    const lines = output.split(/\r?\n/);
    const models: string[] = [];

    for (const rawLine of lines) {
      const trimmed = rawLine.trim();
      if (!trimmed) continue;
      // Skip comments or table headers
      if (trimmed.startsWith("#") || trimmed.startsWith("---") || trimmed.startsWith("===")) continue;
      if (/^available models/i.test(trimmed) || /^models:/i.test(trimmed)) continue;

      // Real agy models output is tab-delimited: <model-slug>\t<display-name>[\t<default>]
      // Extract the first column before tab (or take trimmed line if no tab)
      const firstCol = rawLine.split("\t")[0]?.trim() ?? "";
      if (!firstCol) continue;

      // Extract model name, removing trailing (default) or other parenthetical notes
      const clean = firstCol.replace(/\s+\(.*?\)$/, "").trim();
      if (!clean) continue;

      // Skip table header names
      if (/^(model|models|slug|id|name)$/i.test(clean)) continue;

      // Slugs must only contain valid slug characters and never display names or tabs
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(clean)) continue;

      if (!models.includes(clean)) {
        models.push(clean);
      }
    }

    return models;
  }
}
