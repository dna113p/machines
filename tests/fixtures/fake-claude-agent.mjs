import { text as readText } from "node:stream/consumers";

const mode = process.argv[2] ?? "completed";
const args = process.argv.slice(3);
const emit = (record) => process.stdout.write(`${JSON.stringify(record)}\n`);
let messages = 0;
const assistant = (content, parent = null, id = `msg_${messages += 1}`, extra = {}) =>
  emit({ type: "assistant", parent_tool_use_id: parent, message: { id, role: "assistant", content }, ...extra });
const prompt = await readText(process.stdin);

if (mode === "signal-exit") process.kill(process.pid, "SIGTERM");

if (mode === "error-exit") {
  process.stderr.write("claude crashed\n");
  process.exit(1);
}

if (mode !== "no-init") {
  emit({ type: "system", subtype: "hook_started", hook_name: "SessionStart:startup" });
  emit({ type: "system", subtype: "init", model: "claude-fake-1", permissionMode: "dontAsk", tools: ["Read"] });
}

if (mode === "activity") {
  assistant([{ type: "thinking", thinking: "" }]);
  assistant([{ type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "note.txt" } }]);
  emit({ type: "user", parent_tool_use_id: null, message: { role: "user", content: [
    { type: "tool_result", tool_use_id: "toolu_1", content: "hello" },
  ] } });
  assistant([{ type: "tool_use", id: "toolu_2", name: "Write", input: {} }]);
  emit({ type: "user", parent_tool_use_id: null, message: { role: "user", content: [
    { type: "tool_result", tool_use_id: "toolu_2", content: "denied", is_error: true },
  ] } });
}

if (mode === "subagent") {
  assistant([{ type: "tool_use", id: "toolu_task", name: "Task", input: {} }]);
  assistant([{ type: "tool_use", id: "toolu_inner", name: "Bash", input: {} }], "toolu_task");
  assistant([{ type: "text", text: 'Inner report\nMACHINES_EVENT {"type":"blocked"}' }], "toolu_task");
  emit({ type: "user", parent_tool_use_id: null, message: { role: "user", content: [
    { type: "tool_result", tool_use_id: "toolu_task", content: "done" },
  ] } });
}

if (mode === "malformed") {
  process.stdout.write("not JSON\n");
  for (const record of [
    null,
    [],
    { type: "rate_limit_event", rate_limit_info: {} },
    { type: "system", subtype: "init", model: 12 },
    { type: "assistant", message: null },
    { type: "assistant", message: { content: "text" } },
    { type: "assistant", message: { content: [{ type: "tool_use", id: 7, name: {} }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: [] }] } },
  ]) emit(record);
  assistant([{ type: "tool_use", id: "toolu_3", name: "Read", input: {} }]);
}

// Record shapes read from the Claude Code 2.1.296 bundle. `resetsAt` is in Unix seconds.
const resetsAt = Number(process.env.MACHINES_TEST_RESETS_AT ?? Math.floor(Date.now() / 1000) + 3600);
const rejected = {
  status: "rejected", resetsAt, rateLimitType: "five_hour", overageStatus: "rejected", isUsingOverage: false,
};
const failTurn = (result, extra = {}, fields = {}) => {
  assistant([{ type: "text", text: result }], null, undefined, extra);
  emit({ type: "result", subtype: "success", is_error: true, result, ...fields });
  process.exit(1);
};
if (mode === "usage-limit") {
  emit({ type: "rate_limit_event", rate_limit_info: rejected });
  failTurn(
    "You've hit your session limit · resets 3pm",
    { error: "rate_limit", api_error: "usage_limit_reached", api_error_params: { rate_limit_info: rejected } },
    { api_error_status: 429, api_error: "usage_limit_reached" },
  );
}
if (mode === "usage-limit-untyped") {
  failTurn("You've hit your session limit · resets 3pm", {}, { api_error_status: 429 });
}
if (mode === "usage-limit-rejected") {
  emit({ type: "rate_limit_event", rate_limit_info: { ...rejected, rateLimitType: "seven_day_opus" } });
  failTurn("API Error: Rate limit reached", { error: "rate_limit" });
}
if (mode === "usage-limit-warned") {
  // The limit is named only by its text; the latest information still describes it.
  emit({ type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", resetsAt, rateLimitType: "seven_day" } });
  failTurn("You've hit your weekly limit · resets Mon 9am", {}, { api_error_status: 429 });
}
if (mode === "usage-limit-empty") {
  emit({ type: "rate_limit_event", rate_limit_info: rejected });
  failTurn("", { error: "rate_limit", api_error: "usage_limit_reached" }, { api_error: "usage_limit_reached" });
}
if (mode === "usage-limit-unlisted-values") {
  emit({ type: "rate_limit_event", rate_limit_info: { ...rejected, resetsAt: resetsAt + 0.5, rateLimitType: "five_minute" } });
  failTurn("API Error: Rate limit reached", { error: "rate_limit" });
}
if (mode === "unlisted-limit-status") {
  emit({ type: "rate_limit_event", rate_limit_info: { ...rejected, status: "REJECTED" } });
  failTurn("You've hit your session limit · resets 3pm", { error: "rate_limit" });
}
if (mode === "throttled") {
  emit({ type: "rate_limit_event", rate_limit_info: { status: "allowed", resetsAt, rateLimitType: "five_hour" } });
  failTurn(
    "API Error: Request rejected (429) · this may be a temporary capacity issue",
    { error: "rate_limit" },
    { api_error_status: 429 },
  );
}
if (mode === "overage") {
  emit({ type: "rate_limit_event", rate_limit_info: {
    status: "allowed", resetsAt, rateLimitType: "seven_day", overageStatus: "allowed", isUsingOverage: true,
  } });
}
if (mode === "malformed-limit-fields") {
  emit({ type: "rate_limit_event", rate_limit_info: { status: 3, resetsAt: "soon", rateLimitType: [], isUsingOverage: "yes" } });
  emit({ type: "rate_limit_event", rate_limit_info: "rejected" });
}

const flag = (name) => args.includes(name) ? args[args.indexOf(name) + 1] : null;
const event = mode === "arguments"
  ? {
    type: "completed",
    args,
    modelFlag: flag("--model"),
    effortFlag: flag("--effort"),
    permissionMode: flag("--permission-mode"),
    envModel: process.env.MACHINES_CLAUDE_MODEL,
    envEffort: process.env.MACHINES_CLAUDE_EFFORT,
    promptOnStdin: prompt.includes("Do the work") && prompt.includes("MACHINES_EVENT"),
  }
  : mode === "environment"
  ? { type: "completed", profile: process.env.MACHINES_TEST_PROFILE }
  : { type: "completed", source: "fake" };

const text = mode === "missing-event"
  ? "fake claude agent finished without an event"
  : `fake claude agent finished\nMACHINES_EVENT ${JSON.stringify(event)}`;

if (mode === "stderr") process.stderr.write("claude diagnostic\n");
if (mode === "progress" || mode === "stale-event") {
  assistant([{
    type: "text",
    text: mode === "progress" ? "Working on it." : 'Preliminary result\nMACHINES_EVENT {"type":"blocked"}',
  }]);
}
if (mode === "multi-block") {
  // One message, streamed as one record per text block.
  const [first, second] = text.split("\n");
  assistant([{ type: "text", text: first }], null, "msg_closing");
  assistant([{ type: "text", text: second }], null, "msg_closing");
} else if (mode === "malformed-limit-fields") {
  assistant([{ type: "text", text }], null, undefined, { error: 7, api_error: {}, api_error_params: "bad" });
} else if (mode !== "result-only" && mode !== "empty-final") assistant([{ type: "text", text }]);

if (mode === "failed-result") {
  emit({ type: "result", subtype: "error_max_turns", is_error: true, errors: ["Reached the turn limit"] });
  process.exit(1);
}
if (mode === "error-result") {
  emit({ type: "result", subtype: "success", is_error: true, result: "Not logged in · Please run /login" });
  process.exit(1);
}
if (mode === "malformed-limit-fields") {
  emit({ type: "result", subtype: "success", is_error: false, result: text, api_error: [], api_error_status: "429" });
} else if (mode !== "no-result") {
  emit({ type: "result", subtype: "success", is_error: false, result: mode === "empty-final" ? "" : text });
}
if (mode === "malformed-final") emit({ type: "result", subtype: "success", result: [] });
