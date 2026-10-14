import { ProtocolError, ProtocolErrorCode, Server } from "@modelcontextprotocol/server";
import { CreateTaskResultV2Schema, GetTaskResultV2Schema, TASKS_EXTENSION_ID_V2 } from "@modelcontextprotocol/ext-tasks/core/v2";
import * as z from "zod/v4";
const CLIENT_CAPABILITIES_KEY = "io.modelcontextprotocol/clientCapabilities";
const PROTOCOL_VERSION_KEY = "io.modelcontextprotocol/protocolVersion";
const TASKS_PROTOCOL_VERSION = "2026-07-28";
const TASK_POLL_INTERVAL_MS = 60_000;
const jobIdSchema = z.string().regex(/^job-\d+-\d+$/, "Invalid task ID");
function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
function supportsTasks(context) {
    const envelope = context.mcpReq.envelope;
    if (envelope?.[PROTOCOL_VERSION_KEY] !== TASKS_PROTOCOL_VERSION)
        return false;
    const capabilities = envelope?.[CLIENT_CAPABILITIES_KEY];
    if (!isRecord(capabilities) || !isRecord(capabilities.extensions))
        return false;
    const extension = capabilities.extensions[TASKS_EXTENSION_ID_V2];
    return isRecord(extension) && Object.keys(extension).length === 0;
}
function requireTasks(context) {
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
    _wrapHandler(method, handler) {
        const wrapped = super._wrapHandler(method, handler);
        if (method !== "tools/call")
            return wrapped;
        return async (request, context) => {
            const params = isRecord(request.params) ? request.params : undefined;
            if (params?.name === "dispatch_task" && supportsTasks(context)) {
                return handler(request, context);
            }
            return wrapped(request, context);
        };
    }
}
function statusForJob(status) {
    switch (status) {
        case "succeeded": return "completed";
        case "failed": return "failed";
        case "canceled": return "cancelled";
        case "orphaned": return "failed";
        default: return "working";
    }
}
export class TaskAwareServer {
    manager;
    server;
    tools = new Map();
    constructor(serverInfo, manager) {
        this.manager = manager;
        this.server = new TasksProtocolServer(serverInfo, {
            capabilities: {
                tools: { listChanged: false },
                extensions: { [TASKS_EXTENSION_ID_V2]: {} }
            },
            instructions: this.manager.serverInstructions()
        });
        this.installHandlers();
    }
    registerTool(name, config, handler) {
        if (this.tools.has(name))
            throw new Error(`Tool ${name} is already registered`);
        this.tools.set(name, {
            ...config,
            inputSchema: config.inputSchema ?? z.object({}),
            handler: handler
        });
    }
    async connect(transport) {
        await this.server.connect(transport);
    }
    async close() {
        await this.server.close();
    }
    installHandlers() {
        this.server.setRequestHandler("tools/list", async () => ({
            tools: [...this.tools.entries()].map(([name, tool]) => ({
                name,
                ...(tool.title ? { title: tool.title } : {}),
                ...(tool.description ? { description: tool.description } : {}),
                inputSchema: z.toJSONSchema(tool.inputSchema),
                ...(tool.annotations ? { annotations: tool.annotations } : {}),
                ...(tool.icons ? { icons: tool.icons } : {}),
                ...(tool._meta ? { _meta: tool._meta } : {})
            }))
        }));
        this.server.setRequestHandler("tools/call", async (request, context) => {
            const tool = this.tools.get(request.params.name);
            if (!tool)
                throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Tool ${request.params.name} not found`);
            const parsed = await tool.inputSchema.safeParseAsync(request.params.arguments ?? {});
            if (!parsed.success) {
                throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Invalid arguments for tool ${request.params.name}: ${parsed.error.message}`);
            }
            try {
                const result = await tool.handler(parsed.data, context);
                if (request.params.name !== "dispatch_task" || !supportsTasks(context) || result.isError)
                    return result;
                const jobId = result.structuredContent?.jobId;
                if (typeof jobId !== "string")
                    return result;
                return this.createTask(jobId);
            }
            catch (error) {
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
    createTask(jobId) {
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
    getTask(jobId) {
        const job = this.manager.inspectTask(jobId);
        const base = {
            resultType: "complete",
            taskId: jobId,
            createdAt: job.created_at,
            lastUpdatedAt: job.finished_at ?? job.started_at ?? job.created_at,
            ttlMs: null,
            pollIntervalMs: TASK_POLL_INTERVAL_MS
        };
        let result;
        if ((job.status === "queued" || job.status === "running" || job.status === "orphaned") && !this.manager.hasLiveJob(jobId)) {
            result = {
                ...base,
                status: "failed",
                error: {
                    code: -32_000,
                    message: `ORPHANED_JOB: ${jobId} was interrupted by a bridge restart`,
                    data: JSON.parse(JSON.stringify(job))
                }
            };
            return GetTaskResultV2Schema.parse(result);
        }
        switch (job.status) {
            case "succeeded":
                result = {
                    ...base,
                    status: "completed",
                    result: successResult(job, `Job ${jobId} completed.`)
                };
                break;
            case "failed":
                result = {
                    ...base,
                    status: "failed",
                    error: {
                        code: -32_000,
                        message: job.error ?? `Job ${jobId} failed`,
                        data: JSON.parse(JSON.stringify(job))
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
function successResult(data, summary) {
    return {
        content: [{ type: "text", text: summary }],
        structuredContent: JSON.parse(JSON.stringify(data))
    };
}
//# sourceMappingURL=task-aware-server.js.map