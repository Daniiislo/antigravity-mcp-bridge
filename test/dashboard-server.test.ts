import http from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { type BridgeConfig } from "../src/config.js";
import { WorkerManager } from "../src/worker-manager.js";
import { DashboardServer, DASHBOARD_SECURITY_HEADERS } from "../src/dashboard-server.js";
import { getDashboardHtml } from "../src/dashboard-assets.js";
import { createServer } from "../src/server.js";

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "fixtures", "fake-agy.mjs");

const tempDirs: string[] = [];
const managers: WorkerManager[] = [];
const dashboardServers: DashboardServer[] = [];

function makeManager(overrides: Partial<BridgeConfig> = {}) {
  const runsDir = mkdtempSync(path.join(tmpdir(), "agy-runs-dash-"));
  tempDirs.push(runsDir);
  const config: BridgeConfig = {
    executable: process.execPath,
    allowedRoots: [process.cwd(), runsDir],
    sandbox: false,
    dangerouslySkipPermissions: false,
    defaultTimeoutMs: 5_000,
    maxStderrBytes: 4_096,
    dashboardEnabled: true,
    dashboardPort: 0,
    ...overrides
  };
  const mgr = new WorkerManager(config, [fixture], { runsDir });
  managers.push(mgr);
  return { mgr, runsDir };
}

afterEach(async () => {
  for (const ds of dashboardServers.splice(0)) {
    try {
      await ds.stop();
    } catch {
      // ignore
    }
  }
  for (const m of managers.splice(0)) {
    try {
      await m.stop();
    } catch {
      // ignore
    }
  }
  for (const d of tempDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

interface HttpResponse {
  statusCode: number;
  statusMessage: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function request(options: {
  port: number;
  path: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  setHost?: boolean;
}): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { ...options.headers };
    if (options.setHost !== false && !headers.Host && !headers.host) {
      headers.Host = `127.0.0.1:${options.port}`;
    }
    if (options.body && !headers["Content-Length"] && !headers["content-length"]) {
      headers["Content-Length"] = Buffer.byteLength(options.body).toString();
    }
    const req = http.request(
      {
        host: "127.0.0.1",
        port: options.port,
        path: options.path,
        method: options.method ?? "GET",
        setHost: options.setHost ?? true,
        headers
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            statusMessage: res.statusMessage ?? "",
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8")
          });
        });
      }
    );
    req.on("error", reject);
    req.end(options.body);
  });
}

describe("DashboardServer & Dashboard MCP Integration", () => {
  describe("Security Invariants & Host/Loopback Binding", () => {
    it("binds strictly to 127.0.0.1 loopback and rejects non-loopback clients", async () => {
      const { mgr } = makeManager();
      const url = await mgr.getDashboardUrl();
      expect(url).toBeDefined();
      const ds = mgr.getDashboardServer()!;
      expect(ds.isRunning).toBe(true);

      const port = ds.getPort()!;
      expect(port).toBeGreaterThan(0);
      expect(url).toContain(`http://127.0.0.1:${port}/${ds.token}/`);

      // Mock request from a non-loopback IP (e.g. 192.168.1.50)
      const mockReq = {
        socket: { remoteAddress: "192.168.1.50" },
        headers: { host: `127.0.0.1:${port}` },
        method: "GET",
        url: `/${ds.token}/api/snapshot`,
        resume: () => {}
      } as unknown as http.IncomingMessage;

      let statusCode = 0;
      let headers: Record<string, string> = {};
      let responseBody = "";
      const mockRes = {
        writeHead: (code: number, h: Record<string, string>) => {
          statusCode = code;
          headers = h;
        },
        end: (data?: string) => {
          if (data) responseBody = data;
        }
      } as unknown as http.ServerResponse;

      (ds as any).handleRequest(mockReq, mockRes);
      expect(statusCode).toBe(403);
      expect(JSON.parse(responseBody)).toEqual({ error: "Forbidden: loopback access only" });
      expect(headers["Content-Type"]).toContain("application/json");
      expect(headers["Content-Security-Policy"]).toBeDefined();
    });

    it("enforces per-process bearer token on all routes", async () => {
      const { mgr } = makeManager();
      await mgr.getDashboardUrl();
      const ds = mgr.getDashboardServer()!;
      const port = ds.getPort()!;

      // 1. Missing token on root
      const noTokenRes = await request({ port, path: "/" });
      expect(noTokenRes.statusCode).toBe(401);
      expect(JSON.parse(noTokenRes.body)).toEqual({ error: "Unauthorized: invalid or missing token" });

      // 2. Missing token on API
      const noTokenApi = await request({ port, path: "/api/snapshot" });
      expect(noTokenApi.statusCode).toBe(401);

      // 3. Invalid token
      const badToken = await request({ port, path: "/badtoken123/api/snapshot" });
      expect(badToken.statusCode).toBe(401);

      // 4. Token prefix collision (token followed by suffix without slash)
      const prefixCollision = await request({ port, path: `/${ds.token}suffix/api/snapshot` });
      expect(prefixCollision.statusCode).toBe(401);

      // 5. Valid token on HTML UI
      const validHtml = await request({ port, path: `/${ds.token}/` });
      expect(validHtml.statusCode).toBe(200);
      expect(validHtml.headers["content-type"]).toContain("text/html");
      expect(validHtml.body).toContain("Antigravity MCP Bridge Dashboard");

      // 6. Valid token without trailing slash
      const validNoSlash = await request({ port, path: `/${ds.token}` });
      expect(validNoSlash.statusCode).toBe(200);
      expect(validNoSlash.body).toContain("Antigravity MCP Bridge Dashboard");
    });

    it("validates Host header and prevents DNS rebinding", async () => {
      const { mgr } = makeManager();
      await mgr.getDashboardUrl();
      const ds = mgr.getDashboardServer()!;
      const port = ds.getPort()!;

      // 1. Missing Host header
      const noHost = await request({
        port,
        path: `/${ds.token}/api/snapshot`,
        setHost: false,
        headers: {}
      });
      expect(noHost.statusCode).toBe(400);
      if (noHost.body) {
        expect(JSON.parse(noHost.body).error).toMatch(/Host header/i);
      }

      // Also verify application-level handleRequest returns 400 on empty Host
      const mockReqNoHost = {
        socket: { remoteAddress: "127.0.0.1" },
        headers: { host: "" },
        method: "GET",
        url: `/${ds.token}/api/snapshot`,
        resume: () => {}
      } as unknown as http.IncomingMessage;
      let emptyHostCode = 0;
      let emptyHostBody = "";
      const mockResNoHost = {
        writeHead: (code: number) => { emptyHostCode = code; },
        end: (data?: string) => { if (data) emptyHostBody = data; }
      } as unknown as http.ServerResponse;
      (ds as any).handleRequest(mockReqNoHost, mockResNoHost);
      expect(emptyHostCode).toBe(400);
      expect(JSON.parse(emptyHostBody).error).toBe("Missing Host header");

      // 2. Attacker DNS Host header
      const evilHost = await request({
        port,
        path: `/${ds.token}/api/snapshot`,
        headers: { Host: "evil.attacker.com" }
      });
      expect(evilHost.statusCode).toBe(400);
      expect(JSON.parse(evilHost.body).error).toMatch(/Invalid Host header/i);

      // 3. Localhost hostname with mismatched port
      const wrongPort = await request({
        port,
        path: `/${ds.token}/api/snapshot`,
        headers: { Host: `localhost:9999` }
      });
      expect(wrongPort.statusCode).toBe(400);
      expect(JSON.parse(wrongPort.body).error).toMatch(/Invalid Host header port/i);

      // 4. Valid localhost and [::1] host headers
      const validLocalhost = await request({
        port,
        path: `/${ds.token}/api/snapshot`,
        headers: { Host: `localhost:${port}` }
      });
      expect(validLocalhost.statusCode).toBe(200);

      const validIpv6 = await request({
        port,
        path: `/${ds.token}/api/snapshot`,
        headers: { Host: `[::1]:${port}` }
      });
      expect(validIpv6.statusCode).toBe(200);
    });

    it("restricts HTTP methods to GET and HEAD, rejecting mutations with 405", async () => {
      const { mgr } = makeManager();
      await mgr.getDashboardUrl();
      const ds = mgr.getDashboardServer()!;
      const port = ds.getPort()!;

      // HEAD request succeeds without body
      const headRes = await request({ port, path: `/${ds.token}/`, method: "HEAD" });
      expect(headRes.statusCode).toBe(200);
      expect(headRes.body).toBe("");
      expect(headRes.headers["content-type"]).toContain("text/html");

      // Mutation methods return 405 with Allow header
      for (const m of ["POST", "PUT", "DELETE", "PATCH"]) {
        const res = await request({
          port,
          path: `/${ds.token}/api/snapshot`,
          method: m,
          body: JSON.stringify({ malicious: true })
        });
        expect(res.statusCode).toBe(405);
        expect(res.headers["allow"]).toBe("GET, HEAD");
        expect(JSON.parse(res.body).error).toBe("Method not allowed");
      }
    });

    it("serves CSP and security headers on all responses", async () => {
      const { mgr } = makeManager();
      await mgr.getDashboardUrl();
      const ds = mgr.getDashboardServer()!;
      const port = ds.getPort()!;

      const res = await request({ port, path: `/${ds.token}/api/snapshot` });
      expect(res.statusCode).toBe(200);
      for (const [k, v] of Object.entries(DASHBOARD_SECURITY_HEADERS)) {
        expect(res.headers[k.toLowerCase()]).toBe(v);
      }
    });

    it("returns clean JSON errors with no stack traces on invalid routes and inputs", async () => {
      const { mgr } = makeManager();
      await mgr.getDashboardUrl();
      const ds = mgr.getDashboardServer()!;
      const port = ds.getPort()!;

      // 404 for unknown endpoint
      const notFound = await request({ port, path: `/${ds.token}/api/unknown-endpoint` });
      expect(notFound.statusCode).toBe(404);
      expect(JSON.parse(notFound.body)).toEqual({ error: "Not found" });
      expect(notFound.body).not.toContain("Error:");
      expect(notFound.body).not.toContain("at ");

      // 400 for invalid job_id characters or encoded path traversal
      const badJob = await request({ port, path: `/${ds.token}/api/jobs/job*invalid` });
      expect(badJob.statusCode).toBe(400);
      expect(JSON.parse(badJob.body).error).toBe("Invalid job ID");

      const badJobEncoded = await request({ port, path: `/${ds.token}/api/jobs/%2E%2E%2Fetc%2Fpasswd` });
      expect(badJobEncoded.statusCode).toBe(400);
      expect(JSON.parse(badJobEncoded.body).error).toBe("Invalid job ID");

      // 404 for non-existent valid job_id
      const missingJob = await request({ port, path: `/${ds.token}/api/jobs/job-nonexistent-123` });
      expect(missingJob.statusCode).toBe(404);
      expect(JSON.parse(missingJob.body).error).toBe("Job not found");

      // 400 for invalid query parameters
      const badAfter = await request({ port, path: `/${ds.token}/api/events?after=-5` });
      expect(badAfter.statusCode).toBe(400);

      const badLimit = await request({ port, path: `/${ds.token}/api/events?limit=0` });
      expect(badLimit.statusCode).toBe(400);

      const badWorker = await request({ port, path: `/${ds.token}/api/events?worker_id=worker;rm%20-rf` });
      expect(badWorker.statusCode).toBe(400);
    });
  });

  describe("UI Assets & XSS Safety", () => {
    it("HTML asset contains zero innerHTML, zero external CDNs, and safe JSON token embedding", () => {
      const token = "a1b2c3d4e5f6789012345678901234567890123456789012";
      const html = getDashboardHtml(token);

      // Safe embedding of token
      expect(html).toContain(JSON.stringify(token));

      // Invariants: No external links/scripts/CDNs
      expect(html).not.toMatch(/https?:\/\/(?!127\.0\.0\.1|localhost)/);
      expect(html).not.toContain("cdn.");
      expect(html).not.toContain("cdnjs.");
      expect(html).not.toContain("unpkg.");
      expect(html).not.toContain("jsdelivr.");
      expect(html).not.toContain("fonts.googleapis.com");

      // Invariant: No unsafe DOM sinks
      expect(html).not.toContain(".innerHTML");
      expect(html).not.toContain(".outerHTML");
      expect(html).not.toContain("document.write");
      expect(html).not.toContain("eval(");
      expect(html).toContain(".textContent");
    });

    it("inline JavaScript script tag parses with zero syntax errors", () => {
      const token = "a1b2c3d4e5f6789012345678901234567890123456789012";
      const html = getDashboardHtml(token);
      const match = html.match(/<script>([\s\S]*?)<\/script>/);
      expect(match).not.toBeNull();
      const scriptContent = match?.[1] ?? "";
      expect(scriptContent.length).toBeGreaterThan(0);

      // Ensure that parsing the script with Function constructor produces no SyntaxErrors
      expect(() => {
        new Function(scriptContent);
      }).not.toThrow();
    });

    it("renders malicious XSS payloads safely as plain text in detail and events", async () => {
      const { mgr, runsDir } = makeManager();
      const xssJobId = "job-xss-test-1";
      const xssBrief = '<script>alert("XSS-BRIEF")</script><img src="x" onerror="alert(1)">';
      const xssPrompt = '<script>alert("XSS-PROMPT")</script>';
      const xssResult = '<svg onload="alert(document.cookie)">';

      // Write NDJSON with XSS payloads
      const line1 = JSON.stringify({
        cursor: 1,
        timestamp: new Date().toISOString(),
        eventType: "lifecycle",
        workerId: "worker-xss",
        jobId: xssJobId,
        data: {
          lifecycle: "queued",
          role: "implementer",
          workspace: process.cwd(),
          brief: xssBrief,
          effective_prompt: xssPrompt
        }
      });
      const line2 = JSON.stringify({
        cursor: 2,
        timestamp: new Date().toISOString(),
        eventType: "result",
        workerId: "worker-xss",
        jobId: xssJobId,
        data: {
          status: "SUCCESS",
          response: xssResult
        }
      });
      writeFileSync(path.join(runsDir, `${xssJobId}.ndjson`), `${line1}\n${line2}\n`, "utf8");

      await mgr.getDashboardUrl();
      const ds = mgr.getDashboardServer()!;
      const port = ds.getPort()!;

      const res = await request({ port, path: `/${ds.token}/api/jobs/${xssJobId}` });
      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.brief).toBe(xssBrief);
      expect(data.result).toBe(xssResult);

      // Verify HTML page uses safe make() helper with textContent
      const htmlRes = await request({ port, path: `/${ds.token}/` });
      expect(htmlRes.statusCode).toBe(200);
      expect(htmlRes.body).toContain("function make(tag, className, textContent)");
      expect(htmlRes.body).toContain("elem.textContent = String(textContent);");
    });
  });

  describe("Snapshot, SSE Stream, Cursors, and Filtering", () => {
    it("returns bounded snapshot with explicit workers and historical jobs", async () => {
      const { mgr, runsDir } = makeManager();
      const worker = await mgr.createWorker({ role: "implementer", workspace: process.cwd() });
      const job = await mgr.dispatchTask(worker.workerId, "snapshot task");
      await mgr.waitTask(job.jobId, { waitMs: 2_000 });

      await mgr.getDashboardUrl();
      const ds = mgr.getDashboardServer()!;
      const port = ds.getPort()!;

      const snapRes = await request({ port, path: `/${ds.token}/api/snapshot` });
      expect(snapRes.statusCode).toBe(200);
      const snap = JSON.parse(snapRes.body);

      expect(Array.isArray(snap.workers)).toBe(true);
      expect(snap.workers.length).toBe(1);
      expect(snap.workers[0].workerId).toBe(worker.workerId);
      expect(snap.workers[0].role).toBe("implementer");

      expect(Array.isArray(snap.jobs)).toBe(true);
      expect(snap.jobs.length).toBe(1);
      expect(snap.jobs[0].job_id).toBe(job.jobId);
      expect(snap.jobs[0].status).toBe("succeeded");
      expect(snap.latest_cursor).toBeGreaterThan(0);
    });

    it("streams live SSE events and supports reconnect cursor without duplicate delivery", async () => {
      const { mgr } = makeManager();
      const worker = await mgr.createWorker({ role: "tester", workspace: process.cwd() });

      await mgr.getDashboardUrl();
      const ds = mgr.getDashboardServer()!;
      const port = ds.getPort()!;

      // Connect to SSE stream
      const sseEvents: Array<{ id?: string | undefined; data: any }> = [];
      const sseReq = http.request({
        host: "127.0.0.1",
        port,
        path: `/${ds.token}/api/stream`,
        headers: { Host: `127.0.0.1:${port}` }
      });

      const connectedPromise = new Promise<void>((resolve) => {
        sseReq.on("response", (res) => {
          let buffer = "";
          res.on("data", (chunk: Buffer) => {
            buffer += chunk.toString("utf8");
            const lines = buffer.split("\n\n");
            buffer = lines.pop() ?? "";
            for (const block of lines) {
              if (block.includes(": connected")) {
                resolve();
              } else if (block.includes("event: event")) {
                const matchId = block.match(/id:\s*(\d+)/);
                const matchData = block.match(/data:\s*(\{.*\})/);
                if (matchData) {
                  sseEvents.push({
                    id: matchId ? matchId[1] : undefined,
                    data: JSON.parse(matchData[1]!)
                  });
                }
              }
            }
          });
        });
      });
      sseReq.end();
      await connectedPromise;

      // Now dispatch task to produce live events
      const job = await mgr.dispatchTask(worker.workerId, "live SSE task");
      await mgr.waitTask(job.jobId, { waitMs: 2_000 });

      // Wait a bit for SSE flush
      await new Promise((r) => setTimeout(r, 100));
      sseReq.destroy();

      expect(sseEvents.length).toBeGreaterThan(0);
      const cursors = sseEvents.map((e) => Number(e.id)).filter(Boolean);
      expect(cursors.length).toBeGreaterThan(0);
      const lastSeenCursor = Math.max(...cursors);

      // Now reconnect with ?after=<lastSeenCursor> and verify NO duplicates are re-delivered
      const reconnectEvents: Array<{ id?: string | undefined; data: any }> = [];
      const recReq = http.request({
        host: "127.0.0.1",
        port,
        path: `/${ds.token}/api/stream?after=${lastSeenCursor}`,
        headers: { Host: `127.0.0.1:${port}` }
      });

      const recConnectedPromise = new Promise<void>((resolve) => {
        recReq.on("response", (res) => {
          let buffer = "";
          res.on("data", (chunk: Buffer) => {
            buffer += chunk.toString("utf8");
            const lines = buffer.split("\n\n");
            buffer = lines.pop() ?? "";
            for (const block of lines) {
              if (block.includes(": connected")) {
                resolve();
              } else if (block.includes("event: event")) {
                const matchId = block.match(/id:\s*(\d+)/);
                const matchData = block.match(/data:\s*(\{.*\})/);
                if (matchData) {
                  reconnectEvents.push({
                    id: matchId ? matchId[1] : undefined,
                    data: JSON.parse(matchData[1]!)
                  });
                }
              }
            }
          });
        });
      });
      recReq.end();
      await recConnectedPromise;

      // No new events should have been delivered on reconnect since none were emitted after lastSeenCursor
      await new Promise((r) => setTimeout(r, 50));
      recReq.destroy();
      expect(reconnectEvents.length).toBe(0);
    });

    it("filters events by worker_id and job_id in SSE stream and polling API", async () => {
      const { mgr } = makeManager();
      const w1 = await mgr.createWorker({ role: "implementer", workspace: process.cwd() });
      const w2 = await mgr.createWorker({ role: "tester", workspace: process.cwd() });

      const j1 = await mgr.dispatchTask(w1.workerId, "task-w1");
      const j2 = await mgr.dispatchTask(w2.workerId, "task-w2");
      await mgr.waitTask(j1.jobId, { waitMs: 2_000 });
      await mgr.waitTask(j2.jobId, { waitMs: 2_000 });

      await mgr.getDashboardUrl();
      const ds = mgr.getDashboardServer()!;
      const port = ds.getPort()!;

      // 1. Polling filtered by w1
      const pollW1 = await request({ port, path: `/${ds.token}/api/events?worker_id=${w1.workerId}` });
      expect(pollW1.statusCode).toBe(200);
      const dataW1 = JSON.parse(pollW1.body);
      expect(dataW1.events.length).toBeGreaterThan(0);
      for (const ev of dataW1.events) {
        expect(ev.workerId).toBe(w1.workerId);
      }

      // 2. Polling filtered by j2
      const pollJ2 = await request({ port, path: `/${ds.token}/api/events?job_id=${j2.jobId}` });
      expect(pollJ2.statusCode).toBe(200);
      const dataJ2 = JSON.parse(pollJ2.body);
      expect(dataJ2.events.length).toBeGreaterThan(0);
      for (const ev of dataJ2.events) {
        expect(ev.jobId).toBe(j2.jobId);
      }
    });
  });

  describe("Historical NDJSON & Old-Format Compatibility", () => {
    it("loads legacy un-normalized NDJSON job runs from disk with steps and results", async () => {
      const { mgr, runsDir } = makeManager();
      const legacyJobId = "job-legacy-001";

      // Write legacy NDJSON lines matching pre-normalized schema
      const lines = [
        JSON.stringify({
          eventType: "lifecycle",
          workerId: "worker-legacy",
          jobId: legacyJobId,
          data: {
            state: "queued",
            role: "implementer",
            workspace: process.cwd(),
            task: "Old format task description",
            created_at: new Date(Date.now() - 60000).toISOString()
          }
        }),
        JSON.stringify({
          event: "init",
          conversation_id: "conv-legacy-999"
        }),
        JSON.stringify({
          event: "step_update",
          step_update: {
            step_type: "command",
            command: "echo legacy",
            state: "COMPLETED"
          }
        }),
        JSON.stringify({
          event: "stderr",
          stderr: "warning: legacy stderr line"
        }),
        JSON.stringify({
          event: "result",
          result: {
            status: "SUCCESS",
            response: "Legacy completion response",
            duration_seconds: 1.25,
            usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 }
          }
        })
      ];

      writeFileSync(path.join(runsDir, `${legacyJobId}.ndjson`), lines.join("\n") + "\n", "utf8");

      await mgr.getDashboardUrl();
      const ds = mgr.getDashboardServer()!;
      const port = ds.getPort()!;

      // Query job detail from dashboard API
      const res = await request({ port, path: `/${ds.token}/api/jobs/${legacyJobId}` });
      expect(res.statusCode).toBe(200);
      const job = JSON.parse(res.body);

      expect(job.job_id).toBe(legacyJobId);
      expect(job.status).toBe("succeeded");
      expect(job.brief).toBe("Old format task description");
      expect(job.conversation_id).toBe("conv-legacy-999");
      expect(job.result).toBe("Legacy completion response");
      expect(job.duration_seconds).toBe(1.25);
      expect(job.usage?.total_tokens).toBe(150);

      // Verify events synthesis
      expect(Array.isArray(job.events)).toBe(true);
      expect(job.events.length).toBeGreaterThanOrEqual(4);
      const eventTypes = job.events.map((e: any) => e.eventType);
      expect(eventTypes).toContain("step");
      expect(eventTypes).toContain("result");
      expect(eventTypes).toContain("init");
      expect(eventTypes).toContain("stderr");

      // Verify history listing picks up legacy job
      const histRes = await request({ port, path: `/${ds.token}/api/snapshot` });
      const snap = JSON.parse(histRes.body);
      const foundInHistory = snap.jobs.find((j: any) => j.job_id === legacyJobId);
      expect(foundInHistory).toBeDefined();
      expect(foundInHistory.status).toBe("succeeded");
    });
  });

  describe("Clean Shutdown & Port Management", () => {
    it("cleanly stops server, destroys connections, and is idempotent", async () => {
      const { mgr } = makeManager();
      const url = await mgr.getDashboardUrl();
      expect(url).toBeDefined();
      const ds = mgr.getDashboardServer()!;
      const port = ds.getPort()!;

      expect(ds.isRunning).toBe(true);

      // Verify server is listening
      const res = await request({ port, path: `/${ds.token}/api/snapshot` });
      expect(res.statusCode).toBe(200);

      // Stop dashboard server
      await ds.stop();
      expect(ds.isRunning).toBe(false);

      // Verify connections now fail
      await expect(request({ port, path: `/${ds.token}/api/snapshot` })).rejects.toThrow();

      // Repeated stop is safe and idempotent
      await expect(ds.stop()).resolves.toBeUndefined();
    });

    it("respects fixed AGY_DASHBOARD_PORT configuration", async () => {
      // Find an available port by creating a temporary server
      const tempServer = http.createServer();
      const chosenPort = await new Promise<number>((resolve) => {
        tempServer.listen(0, "127.0.0.1", () => {
          const p = (tempServer.address() as any).port;
          tempServer.close(() => resolve(p));
        });
      });

      const { mgr } = makeManager({ dashboardPort: chosenPort });
      await mgr.getDashboardUrl();
      const ds = mgr.getDashboardServer()!;
      expect(ds.getPort()).toBe(chosenPort);

      const res = await request({ port: chosenPort, path: `/${ds.token}/api/snapshot` });
      expect(res.statusCode).toBe(200);
    });
  });

  describe("MCP Tools Integration", () => {
    it("open_dashboard returns structured URL, read_only, optional IDs, absolute URL text and resource_link", async () => {
      const { mgr } = makeManager();
      const server = createServer(mgr);
      const [t1, t2] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "test-client", version: "1.0.0" });

      await server.connect(t1);
      await client.connect(t2);

      try {
        // 1. open_dashboard without arguments
        const res = await client.callTool({
          name: "open_dashboard",
          arguments: {}
        });

        expect(res.isError).toBeFalsy();
        const content = res.content as Array<any>;
        expect(content.length).toBe(2);

        // Text with absolute URL
        expect(content[0].type).toBe("text");
        expect(content[0].text).toMatch(/^Antigravity dashboard available at http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]+\/ \(read-only\)\.$/);

        // Valid resource_link
        expect(content[1].type).toBe("resource_link");
        expect(content[1].name).toBe("antigravity-dashboard");
        expect(content[1].title).toBe("Antigravity Dashboard");
        expect(content[1].uri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]+\/$/);

        // Structured content
        const sc = res.structuredContent as Record<string, unknown>;
        expect(sc.read_only).toBe(true);
        expect(sc.dashboard_url).toBe(content[1].uri);
        expect(sc.worker_id).toBeUndefined();
        expect(sc.job_id).toBeUndefined();

        // 2. open_dashboard with worker_id and job_id
        const resFiltered = await client.callTool({
          name: "open_dashboard",
          arguments: {
            worker_id: "worker-custom-1",
            job_id: "job-custom-2"
          }
        });

        const scFiltered = resFiltered.structuredContent as Record<string, unknown>;
        expect(scFiltered.worker_id).toBe("worker-custom-1");
        expect(scFiltered.job_id).toBe("job-custom-2");
        expect(scFiltered.dashboard_url).toContain("worker_id=worker-custom-1");
        expect(scFiltered.dashboard_url).toContain("job_id=job-custom-2");
      } finally {
        await client.close();
        await server.close();
      }
    });

    it("create_worker, dispatch_task, inspect_task include useful URLs, while polling tools do not", async () => {
      const { mgr } = makeManager();
      const server = createServer(mgr);
      const [t1, t2] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "test-client", version: "1.0.0" });

      await server.connect(t1);
      await client.connect(t2);

      try {
        // 1. create_worker includes worker-filtered URL
        const workerRes = await client.callTool({
          name: "create_worker",
          arguments: { role: "implementer", workspace: process.cwd() }
        });
        const wSc = workerRes.structuredContent as any;
        expect(wSc.workerId).toBeDefined();
        expect(wSc.dashboard_url).toContain(`worker_id=${wSc.workerId}`);

        // 2. dispatch_task includes direct job URL with both workerId and jobId
        const dispatchRes = await client.callTool({
          name: "dispatch_task",
          arguments: { worker_id: wSc.workerId, brief: "test task" }
        });
        const dSc = dispatchRes.structuredContent as any;
        expect(dSc.jobId).toBeDefined();
        expect(dSc.dashboard_url).toContain(`worker_id=${wSc.workerId}`);
        expect(dSc.dashboard_url).toContain(`job_id=${dSc.jobId}`);

        // 3. wait_task (polling) does NOT include dashboard_url
        const waitRes = await client.callTool({
          name: "wait_task",
          arguments: { job_id: dSc.jobId, wait_ms: 2_000 }
        });
        const waitSc = waitRes.structuredContent as any;
        expect(waitSc.terminal).toBe(true);
        expect(waitSc.dashboard_url).toBeUndefined();

        // 4. agy_events (polling) does NOT include dashboard_url
        const eventsRes = await client.callTool({
          name: "agy_events",
          arguments: { job_id: dSc.jobId }
        });
        const eventsSc = eventsRes.structuredContent as any;
        expect(eventsSc.events).toBeDefined();
        expect(eventsSc.dashboard_url).toBeUndefined();

        // 5. inspect_task includes dashboard_url
        const inspectRes = await client.callTool({
          name: "inspect_task",
          arguments: { job_id: dSc.jobId }
        });
        const insSc = inspectRes.structuredContent as any;
        expect(insSc.dashboard_url).toContain(`job_id=${dSc.jobId}`);
      } finally {
        await client.close();
        await server.close();
      }
    });

    it("respects AGY_DASHBOARD_ENABLED=false: tools omit URL, open_dashboard fails, server never starts", async () => {
      const { mgr } = makeManager({ dashboardEnabled: false });
      const server = createServer(mgr);
      const [t1, t2] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "test-client", version: "1.0.0" });

      await server.connect(t1);
      await client.connect(t2);

      try {
        // open_dashboard should fail when disabled
        const openRes = await client.callTool({
          name: "open_dashboard",
          arguments: {}
        });
        expect(openRes.isError).toBe(true);
        const openErr = (openRes.structuredContent as any)?.error;
        expect(openErr).toContain("AGY_DASHBOARD_ENABLED=false");

        // create_worker should succeed but NOT include dashboard_url
        const workerRes = await client.callTool({
          name: "create_worker",
          arguments: { role: "implementer", workspace: process.cwd() }
        });
        const wSc = workerRes.structuredContent as any;
        expect(wSc.workerId).toBeDefined();
        expect(wSc.dashboard_url).toBeUndefined();

        // Server should never have started
        expect(mgr.getDashboardServer()).toBeUndefined();
      } finally {
        await client.close();
        await server.close();
      }
    });
  });
});
