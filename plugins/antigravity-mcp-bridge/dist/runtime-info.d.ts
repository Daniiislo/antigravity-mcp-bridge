import type { BridgeConfig } from "./config.js";
export declare function runtimeInfo(config: BridgeConfig): {
    build_id: string;
    wait_mode: string;
    inactivity_seconds: number;
    maximum_turn_seconds: number;
    steps_budget: number | null;
    observed_token_budget: number | null;
    allowed_roots: string[];
    tasks_capability_gated: boolean;
};
