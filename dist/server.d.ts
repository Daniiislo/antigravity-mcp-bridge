import { TaskAwareServer } from "./task-aware-server.js";
import { WorkerManager } from "./worker-manager.js";
/** Interval between MCP progress notifications while a wait is pending (keeps host idle timeouts from firing). */
export declare const PROGRESS_KEEPALIVE_MS = 30000;
export declare function createServer(manager: WorkerManager, options?: {
    progressIntervalMs?: number;
}): TaskAwareServer;
