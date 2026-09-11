import { writeFile } from "node:fs/promises";

const mode = process.argv[2];
const args = process.argv.slice(3);
const finalPath = args[args.indexOf("--output-last-message") + 1];
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
const emit = (value) => console.log(JSON.stringify(value));
const message = (text, id = "message") => emit({ type: "item.completed", item: { type: "agent_message", id, text } });
if (process.env.MACHINES_CODEX_PATH_RECORD) await writeFile(process.env.MACHINES_CODEX_PATH_RECORD, finalPath);
if (mode === "exit-error") {
  process.stderr.write("codex diagnostic\n");
  process.exit(3);
}
if (mode === "signal") process.kill(process.pid, "SIGTERM");
if (mode === "stderr") process.stderr.write("codex diagnostic\n");
if (mode === "malformed") {
  console.log("not json");
  for (const value of [null, [], { type: "turn.failed", error: [] },
    { type: "item.completed", item: { type: "agent_message", id: "bad", text: {} } },
    { type: "item.started", item: { type: "command_execution", id: [], command: "bad" } },
    { type: "item.started", item: { type: "mcp_tool_call", id: "bad", server: {}, tool: "bad" } },
  ]) emit(value);
}
if (mode === "activity") {
  emit({ type: "item.completed", item: { type: "reasoning", id: "reason", text: "private reasoning" } });
  for (const [type, item] of [
    ["item.started", { type: "command_execution", id: "cmd", command: "ls", status: "in_progress" }],
    ["item.completed", { type: "command_execution", id: "cmd", command: "ls", status: "completed", aggregated_output: "raw tool output" }],
    ["item.completed", { type: "file_change", id: "file", status: "declined" }],
    ["item.started", { type: "mcp_tool_call", id: "mcp", server: "docs", tool: "search" }],
    ["item.completed", { type: "web_search", id: "web", query: "documentation" }],
  ]) emit({ type, item });
}
const event = mode === "arguments"
  ? { type: "completed", args, prompt, cwd: process.cwd(), envModel: process.env.CODEX_MODEL, finalPath }
  : { type: "completed", source: "fake" };
const response = mode === "empty-final" ? ""
  : mode === "no-event" ? "No event here."
  : `Codex finished\nMACHINES_EVENT ${JSON.stringify(event)}\n`;
if (["progress", "empty-final", "no-final", "failed", "incomplete"].includes(mode)) {
  message('Preliminary\nMACHINES_EVENT {"type":"blocked"}', "progress");
}
if (mode === "retry") emit({ type: "error", message: "Reconnecting" });
if (mode !== "final-only") message(response);
if (mode !== "no-final") await writeFile(finalPath, response);
if (mode === "failed" || mode === "exit-failed") {
  emit({ type: "turn.failed", error: { message: "Model request failed" } });
  if (mode === "exit-failed") process.exitCode = 1;
}
else if (mode !== "incomplete") emit({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } });
