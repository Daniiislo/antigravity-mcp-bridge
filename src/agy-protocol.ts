export interface AgyUsage {
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

export function normalizeDeniedAction(action: unknown, maxLen = 256): string {
  if (!action) return "";
  if (typeof action === "string") {
    const trimmed = action.trim();
    if (!trimmed) return "";
    return trimmed.length > maxLen ? trimmed.slice(0, maxLen) + " ... [truncated]" : trimmed;
  }
  if (typeof action === "object") {
    const obj = action as Record<string, unknown>;
    const displayName = typeof obj.display_name === "string" ? obj.display_name.trim()
      : (typeof obj.displayName === "string" ? obj.displayName.trim()
      : (typeof obj.name === "string" ? obj.name.trim() : ""));
    const actionType = typeof obj.action === "string" ? obj.action.trim()
      : (typeof obj.type === "string" ? obj.type.trim() : "");
    const detail = typeof obj.command === "string" ? obj.command.trim()
      : (typeof obj.detail === "string" ? obj.detail.trim()
      : (typeof obj.tool === "string" ? obj.tool.trim()
      : (typeof obj.target === "string" ? obj.target.trim() : "")));

    let summary = "";
    if (displayName && actionType && displayName.toLowerCase() !== actionType.toLowerCase()) {
      summary = `${displayName} (${actionType})`;
    } else if (displayName) {
      summary = displayName;
    } else if (actionType) {
      summary = actionType;
    }

    if (detail) {
      summary = summary ? `${summary}: ${detail}` : detail;
    }

    if (!summary) {
      try {
        summary = JSON.stringify(action);
      } catch {
        summary = "[denied action]";
      }
    }

    return summary.length > maxLen ? summary.slice(0, maxLen) + " ... [truncated]" : summary;
  }
  return String(action).slice(0, maxLen);
}

export interface DelegationResult {
  role: "implementer" | "tester";
  response: string;
  conversationId: string;
  status: string;
  durationSeconds: number;
  numTurns: number;
  usage: AgyUsage;
  progress: string[];
}

export interface AgyEvent {
  event: string;
  conversation_id?: string;
  init?: { cwd?: string; tools?: string[] };
  step_update?: { step_type?: string; state?: string; text_delta?: string };
  result?: AgyTerminalResult;
}

export function parseAgyEvent(line: string): AgyEvent {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error(`Antigravity emitted invalid NDJSON: ${line.slice(0, 200)}`);
  }
  if (!value || typeof value !== "object" || typeof (value as { event?: unknown }).event !== "string") {
    throw new Error(`Antigravity emitted an invalid event envelope: ${line.slice(0, 200)}`);
  }
  return value as AgyEvent;
}
