import { text as readText } from "node:stream/consumers";

const mode = process.argv[2] ?? "completed";
const args = process.argv.slice(3);
const emit = (record) => process.stdout.write(`${JSON.stringify(record)}\n`);
let messages = 0;
const assistant = (content, parent = null, id = `msg_${messages += 1}`) =>
  emit({ type: "assistant", parent_tool_use_id: parent, message: { id, role: "assistant", content } });
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
} else if (mode !== "result-only" && mode !== "empty-final") assistant([{ type: "text", text }]);

if (mode === "failed-result") {
  emit({ type: "result", subtype: "error_max_turns", is_error: true, errors: ["Reached the turn limit"] });
  process.exit(1);
}
if (mode === "error-result") {
  emit({ type: "result", subtype: "success", is_error: true, result: "Not logged in · Please run /login" });
  process.exit(1);
}
if (mode !== "no-result") {
  emit({ type: "result", subtype: "success", is_error: false, result: mode === "empty-final" ? "" : text });
}
if (mode === "malformed-final") emit({ type: "result", subtype: "success", result: [] });
