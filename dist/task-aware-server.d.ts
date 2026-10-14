import { Server, type CallToolResult, type JSONRPCRequest, type ServerContext, type Transport } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { WorkerManager } from "./worker-manager.js";
type ToolResult = CallToolResult & {
    structuredContent?: Record<string, unknown>;
};
/**
 * The SDK's high-level McpServer intentionally validates tools/call against the
 * core result schema, which does not include extension-polymorphic Task results.
 * This advanced Server subclass bypasses the core tools/call codec solely for a
 * negotiated dispatch_task call. Its replacement handler validates tool name,
 * arguments, protocol revision and capability; ordinary calls retain SDK checks.
 */
declare class TasksProtocolServer extends Server {
    protected _wrapHandler(method: string, handler: (request: JSONRPCRequest, context: ServerContext) => Promise<Record<string, unknown>>): (request: JSONRPCRequest, context: ServerContext) => Promise<Record<string, unknown>>;
}
export declare class TaskAwareServer {
    private readonly manager;
    readonly server: TasksProtocolServer;
    private readonly tools;
    constructor(serverInfo: {
        name: string;
        version: string;
    }, manager: WorkerManager);
    registerTool<InputSchema extends z.ZodType>(name: string, config: {
        title?: string;
        description?: string;
        inputSchema: InputSchema;
        annotations?: Record<string, unknown>;
        icons?: Array<Record<string, unknown>>;
        _meta?: Record<string, unknown>;
    }, handler: (args: z.output<InputSchema>, context: ServerContext) => ToolResult | Promise<ToolResult>): void;
    connect(transport: Transport): Promise<void>;
    close(): Promise<void>;
    private installHandlers;
    private createTask;
    private getTask;
}
export {};
