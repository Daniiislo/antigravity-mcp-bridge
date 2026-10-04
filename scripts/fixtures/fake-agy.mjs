import readline from "node:readline";

const args = process.argv.slice(2);
if (args.includes("models")) {
  if (process.env.FAKE_AGY_MODELS_FAIL === "1") {
    process.stderr.write("fake agy models failed\n");
    process.exit(1);
  }
  if (process.env.FAKE_AGY_MODELS_HANG === "1") {
    // Keep process open indefinitely
    setInterval(() => {}, 10_000);
  } else if (process.env.FAKE_AGY_MODELS_FLOOD === "1") {
    process.stdout.write("x".repeat(100_000) + "\n");
    process.exit(0);
  } else {
    process.stdout.write(
      "gemini-3.8-flash-high\tGemini 3.8 Flash (High)\tdefault\n" +
      "gemini-3.8-pro-high\tGemini 3.8 Pro (High)\n" +
      "gemini-2.5-pro\tGemini 2.5 Pro (default)\n" +
      "gemini-2.5-flash\tGemini 2.5 Flash\n" +
      "claude-3-7-sonnet\tClaude 3.7 Sonnet\n"
    );
    process.exit(0);
  }
}

const mode = args[args.indexOf("--mode") + 1] ?? "unknown";
const conversationId = `fake-${mode}-${process.pid}`;
let turns = 0;

process.stdout.write(JSON.stringify({ event: "init", conversation_id: conversationId, init: { cwd: process.cwd(), tools: [] } }) + "\n");

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  const message = JSON.parse(line);
  const content = message?.message?.content;
  turns += 1;

  if (content === "MALFORMED") {
    process.stdout.write("not-json\n");
    return;
  }
  if (content === "BLANK_LINES") {
    process.stdout.write("\n\n   \r\n");
    process.stdout.write(JSON.stringify({ event: "step_update", step_update: {
      conversation_id: conversationId, step_index: turns, state: "DONE", step_type: "agent_response", text_delta: "ok"
    } }) + "\n");
    process.stdout.write("  \n\n");
    process.stdout.write(JSON.stringify({ event: "result", result: {
      conversation_id: conversationId, status: "SUCCESS", response: "blank lines handled",
      duration_seconds: 0.01, num_turns: turns,
      usage: { input_tokens: 1, output_tokens: 1, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 2 }
    } }) + "\n");
    process.stdout.write("\n\n");
    return;
  }
  if (content === "EXIT") process.exit(17);
  if (content === "HANG") return;
  if (content === "ERROR") {
    process.stdout.write(JSON.stringify({ event: "result", result: {
      conversation_id: conversationId, status: "ERROR", response: "", error: "fake failure",
      duration_seconds: 0.01, num_turns: turns,
      usage: { input_tokens: 1, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 1 }
    } }) + "\n");
    return;
  }
  if (content === "EMPTY_SUCCESS") {
    process.stdout.write(JSON.stringify({ event: "result", result: {
      conversation_id: conversationId, status: "SUCCESS", response: "   ",
      duration_seconds: 0.01, num_turns: turns,
      usage: { input_tokens: 1, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 1 }
    } }) + "\n");
    return;
  }
  if (content === "EMPTY_SUCCESS_WITH_DENIED") {
    process.stderr.write("auto-denied action: RunCommand\n");
    process.stdout.write(JSON.stringify({ event: "result", result: {
      conversation_id: conversationId, status: "SUCCESS", response: "",
      denied_actions: [{ action: "command", display_name: "RunCommand" }],
      duration_seconds: 0.01, num_turns: turns,
      usage: { input_tokens: 1, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 1 }
    } }) + "\n");
    return;
  }
  if (content === "RESULT_DENIED") {
    process.stderr.write("auto-denied action: RunCommand\n");
    process.stdout.write(JSON.stringify({ event: "result", result: {
      conversation_id: conversationId, status: "SUCCESS", response: "handled with denied action",
      denied_actions: [{ action: "command", display_name: "RunCommand" }],
      duration_seconds: 0.01, num_turns: turns,
      usage: { input_tokens: 1, output_tokens: 1, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 2 }
    } }) + "\n");
    return;
  }
  if (content === "MANY_DENIED") {
    const denied = [];
    for (let i = 1; i <= 35; i++) {
      denied.push({ action: "command", display_name: `DeniedAction${i}` });
    }
    process.stdout.write(JSON.stringify({ event: "result", result: {
      conversation_id: conversationId, status: "SUCCESS", response: "many denied actions",
      denied_actions: denied,
      duration_seconds: 0.01, num_turns: turns,
      usage: { input_tokens: 1, output_tokens: 1, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 2 }
    } }) + "\n");
    return;
  }
  if (content === "OVERSIZED") {
    const hugeDelta = "a".repeat(100_000);
    const hugeResponse = "b".repeat(150_000);
    process.stdout.write(JSON.stringify({ event: "step_update", step_update: {
      conversation_id: conversationId, step_index: 1, state: "DONE", step_type: "agent_response", text_delta: hugeDelta
    } }) + "\n");
    process.stdout.write(JSON.stringify({ event: "result", result: {
      conversation_id: conversationId, status: "SUCCESS", response: hugeResponse,
      duration_seconds: 0.01, num_turns: turns,
      usage: { input_tokens: 1, output_tokens: 1, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 2 }
    } }) + "\n");
    return;
  }
  if (typeof content === "string" && content.includes("DELAY:")) {
    const match = content.match(/DELAY:(\d+):(.*)/s);
    const delayMs = match ? Number(match[1]) : 50;
    const actualMsg = match ? match[2] : "delayed";
    setTimeout(() => {
      process.stderr.write(`diagnostic:${content}\n`);
      process.stdout.write(JSON.stringify({ event: "step_update", step_update: {
        conversation_id: conversationId, step_index: turns, state: "DONE", step_type: "agent_response", text_delta: `reply:${actualMsg}`
      } }) + "\n");
      process.stdout.write(JSON.stringify({ event: "result", result: {
        conversation_id: conversationId, status: "SUCCESS", response: `reply:${actualMsg}:${mode}`,
        duration_seconds: turns * 0.01, num_turns: turns,
        usage: { input_tokens: turns, output_tokens: turns, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: turns * 2 }
      } }) + "\n");
    }, delayMs);
    return;
  }
  if (typeof content === "string" && content.includes("MANY_STEPS:")) {
    const count = Number(content.split("MANY_STEPS:")[1]) || 25;
    for (let i = 1; i <= count; i++) {
      process.stdout.write(JSON.stringify({ event: "step_update", step_update: {
        conversation_id: conversationId, step_index: i, state: "RUNNING", step_type: "tool_use", text_delta: `step ${i}`
      } }) + "\n");
    }
    process.stdout.write(JSON.stringify({ event: "result", result: {
      conversation_id: conversationId, status: "SUCCESS", response: "completed many steps",
      duration_seconds: 0.05, num_turns: turns,
      usage: { input_tokens: 10, output_tokens: 10, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 20 }
    } }) + "\n");
    return;
  }
  if (typeof content === "string" && content.includes("DENIED")) {
    process.stderr.write("denied action\n");
    process.stdout.write(JSON.stringify({ event: "step_update", step_update: {
      conversation_id: conversationId, step_index: turns, state: "DENIED", step_type: "tool_permission", text_delta: "permission denied for edit"
    } }) + "\n");
    process.stdout.write(JSON.stringify({ event: "result", result: {
      conversation_id: conversationId, status: "SUCCESS", response: "handled denial",
      duration_seconds: 0.01, num_turns: turns,
      usage: { input_tokens: 1, output_tokens: 1, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 2 }
    } }) + "\n");
    return;
  }

  process.stderr.write(`diagnostic:${content}\n`);
  process.stdout.write(JSON.stringify({ event: "step_update", step_update: {
    conversation_id: conversationId, step_index: turns, state: "DONE", step_type: "agent_response", text_delta: `reply:${content}`
  } }) + "\n");
  process.stdout.write(JSON.stringify({ event: "result", result: {
    conversation_id: conversationId, status: "SUCCESS", response: `reply:${content}:${mode}`,
    duration_seconds: turns * 0.01, num_turns: turns,
    usage: { input_tokens: turns, output_tokens: turns, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: turns * 2 }
  } }) + "\n");
});
