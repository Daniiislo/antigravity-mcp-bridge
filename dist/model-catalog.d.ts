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
export declare class ModelCatalog {
    private readonly options;
    private cache?;
    private readonly ttlMs;
    private readonly ttlSeconds;
    private readonly timeoutMs;
    private readonly maxBufferBytes;
    constructor(options: ModelCatalogOptions);
    listModels(options?: {
        refresh?: boolean | undefined;
    } | undefined): Promise<ListModelsResult>;
    private fetchModels;
    private parseModelLines;
}
