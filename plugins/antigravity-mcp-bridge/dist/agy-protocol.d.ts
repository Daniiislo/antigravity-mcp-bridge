export interface AgyUsage {
    /** Tokens consumed inside the Antigravity worker, not by the calling MCP controller. */
    input_tokens: number;
    output_tokens: number;
    thinking_tokens: number;
    cache_read_tokens: number;
    total_tokens: number;
}
export interface AgyTerminalResult {
    conversation_id: string;
    status: string;
    response: string;
    error?: string;
    duration_seconds: number;
    num_turns: number;
    usage: AgyUsage;
    denied_actions?: unknown[] | undefined;
}
export declare function normalizeDeniedAction(action: unknown, maxLen?: number): string;
export interface DelegationResult {
    role: "implementer" | "tester";
    response: string;
    conversationId: string;
    status: string;
    /** Per-turn bridge wall-clock duration. */
    durationSeconds: number;
    /** Raw duration reported by the CLI, which may be conversation-cumulative. */
    cliDurationSeconds: number;
    numTurns: number;
    /** Per-turn usage delta derived from the CLI cumulative counters. */
    usage?: AgyUsage | undefined;
    /** Raw usage counters reported by the CLI. */
    cumulativeUsage: AgyUsage;
    progress: string[];
}
export interface AgyEvent {
    event: string;
    conversation_id?: string;
    init?: {
        cwd?: string;
        tools?: string[];
    };
    step_update?: {
        step_index?: number;
        step_type?: string;
        state?: string;
        text_delta?: string;
        usage?: Partial<AgyUsage>;
        [k: string]: unknown;
    };
    result?: AgyTerminalResult;
}
export declare function parseAgyEvent(line: string): AgyEvent;
