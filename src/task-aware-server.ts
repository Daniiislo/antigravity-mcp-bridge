import {
  ProtocolError,
  ProtocolErrorCode,
  Server,
  type CallToolResult,
  type JSONRPCRequest,
  type ListToolsResult,
  type ServerContext,
  type Transport
} from "@modelcontextprotocol/server";
import type { JsonValue } from "@modelcontextprotocol/ext-tasks/core";
import {
  CreateTaskResultV2Schema,
  GetTaskResultV2Schema,
  TASKS_EXTENSION_ID_V2,
  type CreateTaskResultV2,
  type DetailedTaskV2
} from "@modelcontextprotocol/ext-tasks/core/v2";
import * as z from "zod/v4";
import type { WorkerManager } from "./worker-manager.js";

type ToolResult = CallToolResult & { structuredContent?: Record<string, unknown> };
type ToolHandler = (args: unknown, context: ServerContext) => ToolResult | Promise<ToolResult>;

interface ToolDefinition {
  title?: string;
  description?: string;
  inputSchema: z.ZodType;
  annotations?: Record<string, unknown>;
  icons?: Array<Record<string, unknown>>;
  _meta?: Record<string, unknown>;
  handler: ToolHandler;
}

const CLIENT_CAPABILITIES_KEY = "io.modelcontextprotocol/clientCapabilities";
const PROTOCOL_VERSION_KEY = "io.modelcontextprotocol/protocolVersion";
const TASKS_PROTOCOL_VERSION = "2026-07-28";
const TASK_POLL_INTERVAL_MS = 60_000;
const jobIdSchema = z.string().regex(/^job-\d+-\d+$/, "Invalid task ID");

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function supportsTasks(context: ServerContext): boolean {
  const envelope = context.mcpReq.envelope as Record<string, unknown> | undefined;
  if (envelope?.[PROTOCOL_VERSION_KEY] !== TASKS_PROTOCOL_VERSION) return false;
  const capabilities = envelope?.[CLIENT_CAPABILITIES_KEY];
  if (!isRecord(capabilities) || !isRecord(capabilities.extensions)) return false;
  const extension = capabilities.extensions[TASKS_EXTENSION_ID_V2];
  return isRecord(extension) && Object.keys(extension).length === 0;
}

function requireTasks(context: ServerContext): void {
  if (!supportsTasks(context)) {
    throw new ProtocolError(-32_021, `The ${TASKS_EXTENSION_ID_V2} extension is required for this method`);
  }
}

/**
 * The SDK's high-level McpServer intentionally validates tools/call against the
 * core result schema, which does not include extension-polymorphic Task results.
 * This advanced Server subclass bypasses the core tools/call codec solely for a
 * negotiated dispatch_task call. Its replacement handler validates tool name,
 * arguments, protocol revision and capability; ordinary calls retain SDK checks.
 */
class TasksProtocolServer extends Server {
  protected override _wrapHandler(
    method: string,
    handler: (request: JSONRPCRequest, context: ServerContext) => Promise<Record<string, unknown>>
  ): (request: JSONRPCRequest, context: ServerContext) => Promise<Record<string, unknown>> {
    const wrapped = super._wrapHandler(method, handler);
    if (method !== "tools/call") return wrapped;

    return async (request, context) => {
      const params = isRecord(request.params) ? request.params : undefined;
      if (params?.name === "dispatch_task" && supportsTasks(context)) {
        return handler(request, context);
      }
      return wrapped(request, context);
    };
  }
}

function statusForJob(status: string): DetailedTaskV2["status"] {
  switch (status) {
    case "succeeded": return "completed";
    case "failed": return "failed";
    case "canceled": return "cancelled";
    default: return "working";
  }
}

export class TaskAwareServer {
  readonly server: TasksProtocolServer;
  private readonly tools = new Map<string, ToolDefinition>();

  constructor(
    serverInfo: { name: string; version: string },
    private readonly manager: WorkerManager
  ) {
    this.server = new TasksProtocolServer(serverInfo, {
      capabilities: {
        tools: { listChanged: false },
        extensions: { [TASKS_EXTENSION_ID_V2]: {} }
      }
    });
    this.installHandlers();
  }

  registerTool<InputSchema extends z.ZodType>(
    name: string,
    config: {
      title?: string;
      description?: string;
      inputSchema: InputSchema;
      annotations?: Record<string, unknown>;
      icons?: Array<Record<string, unknown>>;
      _meta?: Record<string, unknown>;
    },
    handler: (args: z.output<InputSchema>, context: ServerContext) => ToolResult | Promise<ToolResult>
  ): void {
    if (this.tools.has(name)) throw new Error(`Tool ${name} is already registered`);
    this.tools.set(name, {
      ...config,
      inputSchema: config.inputSchema ?? z.object({}),
      handler: handler as ToolHandler
    });
  }

  async connect(transport: Transport): Promise<void> {
    await this.server.connect(transport);
  }

  async close(): Promise<void> {
    await this.server.close();
  }

  private installHandlers(): void {
    this.server.setRequestHandler("tools/list", async () => ({
      tools: [...this.tools.entries()].map(([name, tool]) => ({
        name,
        ...(tool.title ? { title: tool.title } : {}),
        ...(tool.description ? { description: tool.description } : {}),
        inputSchema: z.toJSONSchema(tool.inputSchema) as Record<string, unknown>,
        ...(tool.annotations ? { annotations: tool.annotations } : {}),
        ...(tool.icons ? { icons: tool.icons } : {}),
        ...(tool._meta ? { _meta: tool._meta } : {})
      }))
    }) as ListToolsResult);

    this.server.setRequestHandler("tools/call", async (request, context) => {
      const tool = this.tools.get(request.params.name);
      if (!tool) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Tool ${request.params.name} not found`);

      const parsed = await tool.inputSchema.safeParseAsync(request.params.arguments ?? {});
      if (!parsed.success) {
        throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Invalid arguments for tool ${request.params.name}: ${parsed.error.message}`);
      }

      try {
        const result = await tool.handler(parsed.data as Record<string, unknown>, context);
        if (request.params.name !== "dispatch_task" || !supportsTasks(context) || result.isError) return result;

        const jobId = result.structuredContent?.jobId;
        if (typeof jobId !== "string") return result;
        return this.createTask(jobId) as unknown as CallToolResult;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: message }], isError: true };
      }
    });

    const taskIdParams = z.object({ taskId: jobIdSchema });
    this.server.setRequestHandler("tasks/get", { params: taskIdParams }, async ({ taskId }, context) => {
      requireTasks(context);
      return this.getTask(taskId);
    });
    this.server.setRequestHandler("tasks/update", {
      params: z.object({ taskId: jobIdSchema, inputResponses: z.record(z.string(), z.unknown()) })
    }, async ({ taskId }, context) => {
      requireTasks(context);
      this.manager.inspectTask(taskId);
      return { resultType: "complete" };
    });
    this.server.setRequestHandler("tasks/cancel", { params: taskIdParams }, async ({ taskId }, context) => {
      requireTasks(context);
      await this.manager.cancelTask(taskId);
      return { resultType: "complete" };
    });
  }

  private createTask(jobId: string): CreateTaskResultV2 {
    const job = this.manager.inspectTask(jobId);
    return CreateTaskResultV2Schema.parse({
      resultType: "task",
      taskId: jobId,
      status: statusForJob(job.status),
      createdAt: job.created_at,
      lastUpdatedAt: job.finished_at ?? job.started_at ?? job.created_at,
      ttlMs: null,
      pollIntervalMs: TASK_POLL_INTERVAL_MS
    });
  }

  private getTask(jobId: string): DetailedTaskV2 & { resultType: "complete" } {
    const job = this.manager.inspectTask(jobId);
    const base = {
      resultType: "complete" as const,
      taskId: jobId,
      createdAt: job.created_at,
      lastUpdatedAt: job.finished_at ?? job.started_at ?? job.created_at,
      ttlMs: null,
      pollIntervalMs: TASK_POLL_INTERVAL_MS
    };

    let result: DetailedTaskV2 & { resultType: "complete" };
    if ((job.status === "queued" || job.status === "running") && !this.manager.hasLiveJob(jobId)) {
      result = {
        ...base,
        status: "failed",
        error: {
          code: -32_000,
          message: `ORPHANED_JOB: ${jobId} was interrupted by a bridge restart`,
          data: JSON.parse(JSON.stringify(job)) as JsonValue
        }
      };
      return GetTaskResultV2Schema.parse(result);
    }

    switch (job.status) {
      case "succeeded":
        result = {
          ...base,
          status: "completed",
          result: successResult(job as unknown as Record<string, unknown>, `Job ${jobId} completed.`)
        };
        break;
      case "failed":
        result = {
          ...base,
          status: "failed",
          error: {
            code: -32_000,
            message: job.error ?? `Job ${jobId} failed`,
            data: JSON.parse(JSON.stringify(job)) as JsonValue
          }
        };
        break;
      case "canceled":
        result = { ...base, status: "cancelled" };
        break;
      default:
        result = { ...base, status: "working" };
    }
    return GetTaskResultV2Schema.parse(result);
  }
}

function successResult(data: Record<string, unknown>, summary: string): Readonly<Record<string, JsonValue>> {
  return {
    content: [{ type: "text", text: summary }],
    structuredContent: JSON.parse(JSON.stringify(data)) as Record<string, JsonValue>
  };
}
