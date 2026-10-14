export function normalizeDeniedAction(action, maxLen = 256) {
    if (!action)
        return "";
    if (typeof action === "string") {
        const trimmed = action.trim();
        if (!trimmed)
            return "";
        return trimmed.length > maxLen ? trimmed.slice(0, maxLen) + " ... [truncated]" : trimmed;
    }
    if (typeof action === "object") {
        const obj = action;
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
        }
        else if (displayName) {
            summary = displayName;
        }
        else if (actionType) {
            summary = actionType;
        }
        if (detail) {
            summary = summary ? `${summary}: ${detail}` : detail;
        }
        if (!summary) {
            try {
                summary = JSON.stringify(action);
            }
            catch {
                summary = "[denied action]";
            }
        }
        return summary.length > maxLen ? summary.slice(0, maxLen) + " ... [truncated]" : summary;
    }
    return String(action).slice(0, maxLen);
}
export function parseAgyEvent(line) {
    let value;
    try {
        value = JSON.parse(line);
    }
    catch {
        throw new Error(`Antigravity emitted invalid NDJSON: ${line.slice(0, 200)}`);
    }
    if (!value || typeof value !== "object" || typeof value.event !== "string") {
        throw new Error(`Antigravity emitted an invalid event envelope: ${line.slice(0, 200)}`);
    }
    return value;
}
//# sourceMappingURL=agy-protocol.js.map