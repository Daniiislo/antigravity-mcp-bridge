import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
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
const conversationArgIndex = args.indexOf("--conversation");
const resumedConversationId = conversationArgIndex >= 0 ? args[conversationArgIndex + 1] : undefined;
const conversationId = resumedConversationId || `fake-${mode}-${process.pid}`;
let turns = 0;
// Real agy reports denied_actions cumulatively for the whole conversation.
const cumulativeDenied = [];
const USAGE = { input_tokens: 1, output_tokens: 1, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 2 };
const emitStep = (step) => process.stdout.write(JSON.stringify({ event: "step_update", step_update: { conversation_id: conversationId, ...step } }) + "\n");
const emitResult = (response) => process.stdout.write(JSON.stringify({ event: "result", result: {
  conversation_id: conversationId, status: "SUCCESS", response,
  ...(cumulativeDenied.length > 0 ? { denied_actions: [...cumulativeDenied] } : {}),
  duration_seconds: 0.01, num_turns: turns, usage: USAGE
} }) + "\n");

process.stdout.write(JSON.stringify({ event: "init", conversation_id: conversationId, init: { cwd: process.cwd(), tools: [] } }) + "\n");

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  const message = JSON.parse(line);
  const rawContent = message?.message?.content;
  const content = typeof rawContent === "string" && rawContent.includes("\n\n[Task]\n")
    ? rawContent.slice(rawContent.lastIndexOf("\n\n[Task]\n") + "\n\n[Task]\n".length)
    : (typeof rawContent === "string" && rawContent.startsWith("[Task]\n") ? rawContent.slice("[Task]\n".length) : rawContent);
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
  if (content === "ARGUMENTS") {
    process.stdout.write(JSON.stringify({ event: "result", result: {
      conversation_id: conversationId, status: "SUCCESS", response: JSON.stringify(args),
      duration_seconds: 0.01, num_turns: turns,
      usage: { input_tokens: 1, output_tokens: 1, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 2 }
    } }) + "\n");
    return;
  }
  if (content === "DUPLICATE_USAGE") {
    const usage = { input_tokens: 3, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 3 };
    for (let i = 0; i < 2; i++) {
      process.stdout.write(JSON.stringify({ event: "step_update", step_update: {
        step_index: 1, state: "DONE", step_type: "agent_response", usage
      } }) + "\n");
    }
    process.stdout.write(JSON.stringify({ event: "step_update", step_update: { step_index: 2, state: "ACTIVE", step_type: "tool" } }) + "\n");
    process.stdout.write(JSON.stringify({ event: "result", result: {
      conversation_id: conversationId, status: "SUCCESS", response: "duplicate handled",
      duration_seconds: 0.01, num_turns: turns, usage
    } }) + "\n");
    return;
  }
  if (content === "ANONYMOUS_STEPS") {
    for (let i = 0; i < 4; i++) {
      process.stdout.write(JSON.stringify({ event: "step_update", step_update: {
        state: "DONE", step_type: "tool", text_delta: "anonymous step"
      } }) + "\n");
    }
    return;
  }
  if (content === "HANG") return;
  if (typeof content === "string" && content.startsWith("GRACEFUL:")) {
    // Simulates a worker that keeps exploring until told to finish, then wraps
    // up with a final summary: the graceful-finish path of the bridge.
    process.stdout.write(JSON.stringify({ event: "step_update", step_update: {
      conversation_id: conversationId, step_index: turns, state: "RUNNING", step_type: "tool_use", text_delta: "exploring"
    } }) + "\n");
    return;
  }
  if (typeof content === "string" && content.includes("FINISH_NOW")) {
    process.stdout.write(JSON.stringify({ event: "result", result: {
      conversation_id: conversationId, status: "SUCCESS", response: "reply:graceful-done",
      duration_seconds: 0.01, num_turns: turns,
      usage: { input_tokens: 1, output_tokens: 1, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 2 }
    } }) + "\n");
    return;
  }
  if (typeof content === "string" && content.startsWith("SPAWN_CHILD_HANG:")) {
    const pidFile = content.slice("SPAWN_CHILD_HANG:".length);
    const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 10_000)"], {
      detached: false,
      stdio: "ignore",
      windowsHide: true
    });
    writeFileSync(pidFile, String(descendant.pid), "utf8");
    return;
  }
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
  if (typeof content === "string" && content.startsWith("DENY_READ:")) {
    // A denied read: the tool step errors, and the cumulative result list grows.
    const target = content.slice("DENY_READ:".length);
    const message = `permission check failed for read_file "${target}": user denied permission for read_file(${target})\nDo not attempt to circumvent this denial.`;
    process.stderr.write('jetski: no output produced - a tool required the "command" permission that headless mode cannot prompt for, so it was auto-denied.\n');
    emitStep({ step_index: 4, state: "ACTIVE", step_type: "tool", tool_name: "view_file", tool_info: { name: "view_file", parameters: { AbsolutePath: target } } });
    emitStep({ step_index: 4, state: "ERROR", step_type: "tool", tool_name: "view_file", tool_info: { name: "view_file", parameters: { AbsolutePath: target }, error: { type: "TOOL_ERROR", message } } });
    cumulativeDenied.push({ action: "read_file", display_name: "ViewFile" });
    emitResult("Let me read the spec first.");
    return;
  }
  if (content === "DENY_CMD") {
    // A denied command shows no step error; only the result list grows.
    emitStep({ step_index: 2, state: "DONE", step_type: "tool", tool_name: "run_command", tool_info: { name: "run_command", parameters: { CommandLine: "node -e \"process.exit(0)\"" } } });
    cumulativeDenied.push({ action: "command", display_name: "RunCommand" });
    emitResult("Running the check.");
    return;
  }
  if (content === "CLEAN") {
    emitStep({ step_index: 1, state: "DONE", step_type: "agent_response", text_delta: "ok" });
    emitResult("clean turn");
    return;
  }
  if (typeof content === "string" && content.startsWith("WRITE_FILE:")) {
    const target = content.slice("WRITE_FILE:".length);
    for (const state of ["ACTIVE", "DONE", "DONE"]) {
      emitStep({ step_index: 2, state, step_type: "tool", tool_name: "write_to_file", tool_info: { name: "write_to_file", parameters: { TargetFile: target } } });
    }
    emitStep({ step_index: 3, state: "DONE", step_type: "tool", tool_name: "run_command", tool_info: { name: "run_command", parameters: { CommandLine: "echo ok" } } });
    emitStep({ step_index: 4, state: "DONE", step_type: "tool", tool_name: "view_file", tool_info: { name: "view_file", parameters: { AbsolutePath: target } } });
    emitResult("wrote the file");
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
  if (typeof content === "string" && !content.startsWith("PROGRESS_DELAY:")) {
    const match = content.match(/(?:^|\n)DELAY:(\d+):(.*)/s);
    if (match) {
      const delayMs = Number(match[1]);
      const actualMsg = match[2];
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
  }
  if (typeof content === "string" && content.startsWith("PROGRESS_DELAY:")) {
    const match = content.match(/^PROGRESS_DELAY:(\d+):(\d+):(.*)$/s);
    const count = match ? Number(match[1]) : 3;
    const intervalMs = match ? Number(match[2]) : 25;
    const actualMsg = match ? match[3] : "progressed";
    let emitted = 0;
    const interval = setInterval(() => {
      emitted += 1;
      process.stdout.write(JSON.stringify({ event: "step_update", step_update: {
        conversation_id: conversationId, step_index: emitted, state: "RUNNING", step_type: "tool_use", text_delta: `progress ${emitted}`
      } }) + "\n");
      if (emitted < count) return;
      clearInterval(interval);
      process.stdout.write(JSON.stringify({ event: "result", result: {
        conversation_id: conversationId, status: "SUCCESS", response: `reply:${actualMsg}:${mode}`,
        duration_seconds: turns * intervalMs / 1_000, num_turns: turns,
        usage: { input_tokens: turns, output_tokens: turns, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: turns * 2 }
      } }) + "\n");
    }, intervalMs);
    return;
  }
  if (typeof content === "string" && content.startsWith("BUDGET_LOOP:")) {
    const match = content.match(/^BUDGET_LOOP:(\d+):(\d+):(\d+)$/);
    const count = match ? Number(match[1]) : 10;
    const intervalMs = match ? Number(match[2]) : 10;
    const tokensPerStep = match ? Number(match[3]) : 3;
    let step = 0;
    const interval = setInterval(() => {
      step += 1;
      const usage = {
        input_tokens: tokensPerStep,
        output_tokens: 0,
        thinking_tokens: 0,
        cache_read_tokens: 0,
        total_tokens: tokensPerStep
      };
      process.stdout.write(JSON.stringify({ event: "step_update", step_update: {
        conversation_id: conversationId, step_index: step, state: "ACTIVE", step_type: "agent_response"
      } }) + "\n");
      process.stdout.write(JSON.stringify({ event: "step_update", step_update: {
        conversation_id: conversationId, step_index: step, state: "DONE", step_type: "agent_response",
        text_delta: `budget step ${step}`, usage
      } }) + "\n");
      if (step < count) return;
      clearInterval(interval);
      process.stdout.write(JSON.stringify({ event: "result", result: {
        conversation_id: conversationId, status: "SUCCESS", response: "budget loop completed",
        duration_seconds: count * intervalMs / 1_000, num_turns: turns,
        usage: { input_tokens: count * tokensPerStep, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: count * tokensPerStep }
      } }) + "\n");
    }, intervalMs);
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
