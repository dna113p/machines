import { createInterface } from "node:readline";

// DSH ACP shapes checked against deepseek-ai/deepseek-harness at c291e7961a51.
const mode = process.argv[2] ?? "normal";
const args = process.argv.slice(3);
const input = createInterface({ input: process.stdin });
let workspace;
let prompt;
let promptId;
let mcpServers;

if (mode === "stderr") process.stderr.write("dsh diagnostic\n");

for await (const line of input) {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    respond(message.id, { protocolVersion: 1, agentCapabilities: { loadSession: false } });
  } else if (message.method === "session/new") {
    workspace = message.params.cwd;
    mcpServers = message.params.mcpServers;
    respond(message.id, {
      sessionId: "dsh-test-session",
      configOptions: [
        {
          id: "model", name: "Model", category: "model", type: "select",
          currentValue: '["test-provider","test-model"]',
          options: [{ group: "test-provider", name: "Test Provider", options: [
            { value: '["test-provider","test-model"]', name: "Test Model" },
          ] }],
        },
        {
          id: "reasoning_effort", name: "Reasoning effort", category: "thought_level", type: "select",
          currentValue: "high", options: [{ value: "high", name: "High" }],
        },
      ],
    });
  } else if (message.method === "session/prompt") {
    promptId = message.id;
    prompt = message.params.prompt;
    if (mode === "rpc-error") {
      send({ id: promptId, error: { code: -32603, message: "DSH provider is not configured" } });
    } else if (mode === "permission") {
      send({ id: "permission", method: "session/request_permission", params: {
        sessionId: "dsh-test-session",
        toolCall: { toolCallId: "write-1", title: "Write outside workspace", status: "pending" },
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "reject", name: "Reject", kind: "reject_once" },
        ],
      } });
    } else {
      finish();
    }
  } else if (message.id === "permission") {
    if (message.result?.outcome?.optionId !== "reject") {
      process.stderr.write("Permission was not rejected\n");
      process.exit(2);
    }
    // Even an apparently successful final event must not override the denial.
    finish();
  }
}

function finish() {
  if (mode === "activity") {
    update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "private reasoning" } });
    update({ sessionUpdate: "tool_call", toolCallId: "tool-1", title: "Read file", kind: "read", status: "in_progress" });
    update({ sessionUpdate: "tool_call_update", toolCallId: "tool-1", status: "completed" });
  }
  const event = mode === "inspect" ? {
    type: "completed", args, workspace, cwd: process.cwd(), prompt, mcpServers,
    home: process.env.DSH_HOME, pid: process.pid,
  } : { type: mode === "wrong-outcome" ? "undeclared" : "completed", source: "fake" };
  const text = mode === "no-event" ? "No event returned\n"
    : mode === "invalid-event" ? "MACHINES_EVENT {invalid}\n"
    : `DeepSeek finished\nMACHINES_EVENT ${JSON.stringify(event)}\n`;
  update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
  respond(promptId, { stopReason: mode === "cancelled" ? "cancelled" : mode === "max-tokens" ? "max_tokens" : "end_turn" });
}

function update(update) {
  send({ method: "session/update", params: { sessionId: "dsh-test-session", update } });
}
function respond(id, result) { send({ id, result }); }
function send(message) { process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`); }
