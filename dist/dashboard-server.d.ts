import type { WorkerManager } from "./worker-manager.js";
import type { EventStore } from "./event-store.js";
export declare const DASHBOARD_SECURITY_HEADERS: {
    readonly "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none';";
    readonly "X-Content-Type-Options": "nosniff";
    readonly "Cache-Control": "no-store, no-cache, must-revalidate, private";
    readonly Pragma: "no-cache";
    readonly "Referrer-Policy": "no-referrer";
    readonly "X-Frame-Options": "DENY";
    readonly "Cross-Origin-Opener-Policy": "same-origin";
    readonly "Cross-Origin-Resource-Policy": "same-origin";
};
export interface DashboardServerOptions {
    manager: WorkerManager;
    eventStore: EventStore;
    runsDir: string;
    port?: number | undefined;
    enabled?: boolean | undefined;
    token?: string | undefined;
}
export declare class DashboardServer {
    private server?;
    private readonly configuredPort;
    private actualPort?;
    readonly enabled: boolean;
    readonly token: string;
    private readonly manager;
    private readonly eventStore;
    private readonly runsDir;
    private startPromise?;
    private readonly activeSockets;
    private readonly sseClients;
    constructor(options: DashboardServerOptions);
    get isRunning(): boolean;
    getPort(): number | undefined;
    getBaseUrl(): string;
    getUrl(options?: {
        workerId?: string | undefined;
        jobId?: string | undefined;
        workspace?: string | undefined;
    }): Promise<string>;
    start(): Promise<string>;
    stop(): Promise<void>;
    private sendJsonError;
    private sendJson;
    private handleRequest;
    private handleSnapshot;
    private handleJobDetail;
    private handleDeleteJob;
    private handleClean;
    private readJsonBody;
    private handleEvents;
    private handleStream;
}
