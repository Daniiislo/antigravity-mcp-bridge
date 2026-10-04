import http from "node:http";
import crypto from "node:crypto";
import type { Socket } from "node:net";
import type { WorkerManager } from "./worker-manager.js";
import type { EventStore, NormalizedEvent } from "./event-store.js";
import { getDashboardHtml } from "./dashboard-assets.js";

export const DASHBOARD_SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none';",
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "no-store, no-cache, must-revalidate, private",
  "Pragma": "no-cache",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin"
} as const;

export interface DashboardServerOptions {
  manager: WorkerManager;
  eventStore: EventStore;
  runsDir: string;
  port?: number | undefined;
  enabled?: boolean | undefined;
  token?: string | undefined;
}

export class DashboardServer {
  private server?: http.Server | undefined;
  private readonly configuredPort: number;
  private actualPort?: number | undefined;
  public readonly enabled: boolean;
  public readonly token: string;
  private readonly manager: WorkerManager;
  private readonly eventStore: EventStore;
  private readonly runsDir: string;
  private startPromise?: Promise<string> | undefined;
  private readonly activeSockets = new Set<Socket>();
  private readonly sseClients = new Set<http.ServerResponse>();

  constructor(options: DashboardServerOptions) {
    this.manager = options.manager;
    this.eventStore = options.eventStore;
    this.runsDir = options.runsDir;
    this.configuredPort = options.port ?? 0;
    this.enabled = options.enabled ?? true;
    this.token = options.token || crypto.randomBytes(24).toString("hex");
  }

  get isRunning(): boolean {
    return this.server !== undefined && this.actualPort !== undefined;
  }

  getPort(): number | undefined {
    return this.actualPort;
  }

  getBaseUrl(): string {
    if (!this.actualPort) {
      throw new Error("Dashboard server is not listening");
    }
    return `http://127.0.0.1:${this.actualPort}/${this.token}/`;
  }

  async getUrl(options?: { workerId?: string | undefined; jobId?: string | undefined }): Promise<string> {
    if (!this.enabled) {
      throw new Error("Dashboard is disabled via AGY_DASHBOARD_ENABLED=false");
    }
    const base = await this.start();
    const params = new URLSearchParams();
    if (options?.workerId) params.set("worker_id", options.workerId);
    if (options?.jobId) params.set("job_id", options.jobId);
    const q = params.toString();
    return q ? `${base}?${q}` : base;
  }

  async start(): Promise<string> {
    if (!this.enabled) {
      throw new Error("Dashboard is disabled via AGY_DASHBOARD_ENABLED=false");
    }
    if (this.server && this.actualPort) {
      return this.getBaseUrl();
    }
    if (this.startPromise) {
      return this.startPromise;
    }

    this.startPromise = new Promise<string>((resolve, reject) => {
      const server = http.createServer((req, res) => {
        this.handleRequest(req, res);
      });

      server.on("connection", (socket) => {
        this.activeSockets.add(socket);
        socket.on("close", () => {
          this.activeSockets.delete(socket);
        });
      });

      server.on("error", (err) => {
        this.startPromise = undefined;
        reject(err);
      });

      // Bind strictly to 127.0.0.1 loopback
      server.listen(this.configuredPort, "127.0.0.1", () => {
        const addr = server.address();
        if (typeof addr === "object" && addr) {
          this.actualPort = addr.port;
        } else {
          this.actualPort = this.configuredPort;
        }
        this.server = server;
        // Invariant: Do not expose the token in logs
        console.error(`[antigravity-mcp-bridge] dashboard server listening on 127.0.0.1:${this.actualPort}`);
        resolve(this.getBaseUrl());
      });
    });

    return this.startPromise;
  }

  async stop(): Promise<void> {
    for (const res of this.sseClients) {
      try {
        res.end();
      } catch {
        // ignore
      }
    }
    this.sseClients.clear();

    for (const socket of this.activeSockets) {
      try {
        socket.destroy();
      } catch {
        // ignore
      }
    }
    this.activeSockets.clear();

    if (this.server) {
      const s = this.server;
      this.server = undefined;
      this.actualPort = undefined;
      this.startPromise = undefined;
      await new Promise<void>((resolve) => {
        s.close(() => resolve());
      });
    }
  }

  private sendJsonError(res: http.ServerResponse, status: number, message: string, headers: Record<string, string> = {}): void {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      ...DASHBOARD_SECURITY_HEADERS,
      ...headers
    });
    res.end(JSON.stringify({ error: message }));
  }

  private sendJson(res: http.ServerResponse, status: number, data: unknown): void {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      ...DASHBOARD_SECURITY_HEADERS
    });
    res.end(JSON.stringify(data));
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    // 1. Loopback remote peer validation
    const remote = req.socket.remoteAddress;
    const isLoopback = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
    if (!isLoopback) {
      this.sendJsonError(res, 403, "Forbidden: loopback access only");
      return;
    }

    // 2. Host header validation to prevent DNS rebinding attacks
    const host = req.headers.host;
    if (!host) {
      this.sendJsonError(res, 400, "Missing Host header");
      return;
    }

    let hostname = host;
    let portFromHost: string | undefined;
    if (host.startsWith("[")) {
      const endBracket = host.indexOf("]");
      if (endBracket !== -1) {
        hostname = host.slice(0, endBracket + 1);
        if (host[endBracket + 1] === ":") {
          portFromHost = host.slice(endBracket + 2);
        }
      }
    } else if (host.includes(":")) {
      const parts = host.split(":");
      hostname = parts[0]!;
      portFromHost = parts[1];
    }

    const validHostnames = ["127.0.0.1", "localhost", "[::1]"];
    if (!validHostnames.includes(hostname.toLowerCase())) {
      this.sendJsonError(res, 400, "Invalid Host header");
      return;
    }
    if (portFromHost && Number(portFromHost) !== this.actualPort) {
      this.sendJsonError(res, 400, "Invalid Host header port");
      return;
    }

    // 3. Method validation: Read-only server allows GET and HEAD only
    if (req.method !== "GET" && req.method !== "HEAD") {
      if (typeof req.resume === "function") req.resume();
      this.sendJsonError(res, 405, "Method not allowed", { "Allow": "GET, HEAD" });
      return;
    }

    // 4. URL and Token validation
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(req.url || "/", `http://127.0.0.1:${this.actualPort}`);
    } catch {
      this.sendJsonError(res, 400, "Malformed URL");
      return;
    }

    const pathname = parsedUrl.pathname;
    const tokenPrefix = `/${this.token}`;
    if (!pathname.startsWith(tokenPrefix)) {
      this.sendJsonError(res, 401, "Unauthorized: invalid or missing token");
      return;
    }

    const subpath = pathname.slice(tokenPrefix.length);
    if (subpath !== "" && !subpath.startsWith("/")) {
      this.sendJsonError(res, 401, "Unauthorized: invalid or missing token");
      return;
    }

    // 5. Route handling
    try {
      if (subpath === "" || subpath === "/") {
        // Dashboard HTML
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          ...DASHBOARD_SECURITY_HEADERS
        });
        if (req.method === "HEAD") {
          res.end();
          return;
        }
        res.end(getDashboardHtml(this.token));
        return;
      }

      if (subpath === "/api/snapshot") {
        this.handleSnapshot(res);
        return;
      }

      if (subpath.startsWith("/api/jobs/")) {
        const jobId = subpath.slice("/api/jobs/".length);
        this.handleJobDetail(res, jobId);
        return;
      }

      if (subpath === "/api/events") {
        this.handleEvents(res, parsedUrl);
        return;
      }

      if (subpath === "/api/stream") {
        this.handleStream(req, res, parsedUrl);
        return;
      }

      this.sendJsonError(res, 404, "Not found");
    } catch (err) {
      // JSON errors, no stacks exposed
      const msg = err instanceof Error ? err.message : "Internal server error";
      this.sendJsonError(res, 500, msg);
    }
  }

  private async handleSnapshot(res: http.ServerResponse): Promise<void> {
    try {
      const explicitWorkers = this.manager.getExplicitWorkersList();
      const history = await this.manager.getHistory({ limit: 100 });
      const eventsRes = this.eventStore.getEvents({ limit: 1 });

      const snapshot = {
        workers: explicitWorkers,
        jobs: history.jobs,
        latest_cursor: eventsRes.latest_cursor
      };

      this.sendJson(res, 200, snapshot);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to load snapshot";
      this.sendJsonError(res, 500, msg);
    }
  }

  private handleJobDetail(res: http.ServerResponse, jobId: string): void {
    if (!jobId || !/^[a-zA-Z0-9_\-\.]+$/.test(jobId)) {
      this.sendJsonError(res, 400, "Invalid job ID");
      return;
    }

    const job = this.manager.getJobDetail(jobId);
    if (!job) {
      this.sendJsonError(res, 404, "Job not found");
      return;
    }

    this.sendJson(res, 200, job);
  }

  private handleEvents(res: http.ServerResponse, parsedUrl: URL): void {
    const rawAfter = parsedUrl.searchParams.get("after");
    let afterCursor: number | undefined;
    if (rawAfter !== null && rawAfter !== "") {
      const parsed = Number(rawAfter);
      if (!Number.isInteger(parsed) || parsed < 0) {
        this.sendJsonError(res, 400, "Invalid after cursor (must be a non-negative integer)");
        return;
      }
      afterCursor = parsed;
    }

    const rawLimit = parsedUrl.searchParams.get("limit");
    let limit: number | undefined;
    if (rawLimit !== null && rawLimit !== "") {
      const parsed = Number(rawLimit);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 500) {
        this.sendJsonError(res, 400, "Invalid limit (must be an integer between 1 and 500)");
        return;
      }
      limit = parsed;
    }

    const workerId = parsedUrl.searchParams.get("worker_id") || undefined;
    if (workerId && !/^[a-zA-Z0-9_\-\.]+$/.test(workerId)) {
      this.sendJsonError(res, 400, "Invalid worker_id");
      return;
    }

    const jobId = parsedUrl.searchParams.get("job_id") || undefined;
    if (jobId && !/^[a-zA-Z0-9_\-\.]+$/.test(jobId)) {
      this.sendJsonError(res, 400, "Invalid job_id");
      return;
    }

    const result = this.manager.getEvents({
      workerId,
      jobId,
      afterCursor,
      limit
    });

    this.sendJson(res, 200, result);
  }

  private handleStream(req: http.IncomingMessage, res: http.ServerResponse, parsedUrl: URL): void {
    const headerLastId = Array.isArray(req.headers["last-event-id"])
      ? req.headers["last-event-id"][0]
      : req.headers["last-event-id"];
    const rawAfter = parsedUrl.searchParams.get("after") ?? headerLastId;
    let afterCursor: number | undefined;
    if (rawAfter !== null && rawAfter !== undefined && rawAfter !== "") {
      const parsed = Number(rawAfter);
      if (!Number.isInteger(parsed) || parsed < 0) {
        this.sendJsonError(res, 400, "Invalid after cursor");
        return;
      }
      afterCursor = parsed;
    }

    const workerId = parsedUrl.searchParams.get("worker_id") || undefined;
    if (workerId && !/^[a-zA-Z0-9_\-\.]+$/.test(workerId)) {
      this.sendJsonError(res, 400, "Invalid worker_id");
      return;
    }

    const jobId = parsedUrl.searchParams.get("job_id") || undefined;
    if (jobId && !/^[a-zA-Z0-9_\-\.]+$/.test(jobId)) {
      this.sendJsonError(res, 400, "Invalid job_id");
      return;
    }

    res.writeHead(200, {
      ...DASHBOARD_SECURITY_HEADERS,
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform, no-store, private",
      "Connection": "keep-alive"
    });

    this.sseClients.add(res);

    let lastSentCursor = afterCursor ?? 0;

    // Send catch-up events if requested
    if (afterCursor !== undefined && afterCursor >= 0) {
      const pastEvents = this.eventStore.getEvents({
        workerId,
        jobId,
        afterCursor: lastSentCursor,
        limit: 500
      });
      for (const evt of pastEvents.events) {
        if (evt.cursor > lastSentCursor) {
          lastSentCursor = evt.cursor;
          res.write(`id: ${evt.cursor}\nevent: event\ndata: ${JSON.stringify(evt)}\n\n`);
        }
      }
    }

    // Invariant: Prevent duplicate reconnect delivery by filtering on lastSentCursor
    const onEvent = (evt: NormalizedEvent) => {
      if (workerId && evt.workerId !== workerId) return;
      if (jobId && evt.jobId !== jobId) return;
      if (evt.cursor <= lastSentCursor) return;
      lastSentCursor = evt.cursor;
      res.write(`id: ${evt.cursor}\nevent: event\ndata: ${JSON.stringify(evt)}\n\n`);
    };

    this.eventStore.on("event", onEvent);

    const pingTimer = setInterval(() => {
      try {
        res.write(": ping\n\n");
      } catch {
        // ignore
      }
    }, 15_000);
    pingTimer.unref?.();

    res.write(": connected\n\n");

    res.on("close", () => {
      this.sseClients.delete(res);
      this.eventStore.removeListener("event", onEvent);
      clearInterval(pingTimer);
    });
  }
}
