import { createInterface } from "node:readline";

const mode = process.argv[2] ?? "completed";
const input = createInterface({ input: process.stdin });

for await (const line of input) {
  const message = JSON.parse(line);

  if (message.method === "initialize") {
    respond(message.id, {
      protocolVersion: 1,
      agentCapabilities: { loadSession: false },
    });
  } else if (message.method === "session/new") {
    respond(message.id, {
      sessionId: "fake-session",
      configOptions: [
        {
          type: "select",
          id: "model",
          category: "model",
          name: "Model",
          currentValue: "fake/model-1",
          options: [{ value: "fake/model-1", name: "Fake Model 1" }],
        },
        {
          type: "select",
          id: "thought_level",
          category: "thought_level",
          name: "Thinking",
          currentValue: "high",
          options: [{ value: "high", name: "Thinking: high" }],
        },
      ],
    });
  } else if (message.method === "session/prompt") {
    if (mode === "activity") {
      update({
        sessionUpdate: "tool_call",
        toolCallId: "tool-1",
        title: "npm test",
        kind: "execute",
        status: "in_progress",
      });
      update({
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-1",
        status: "completed",
      });
    }
    const event = mode === "environment"
      ? { type: "completed", profile: process.env.MACHINES_TEST_PROFILE }
      : { type: "completed", source: "fake" };
    const text = mode === "missing-event"
      ? "fake agent finished without an event\n"
      : `fake agent finished\nMACHINES_EVENT ${JSON.stringify(event)}\n`;
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "fake-session",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text },
        },
      },
    });
    respond(message.id, { stopReason: "end_turn" });
  }
}

function update(update) {
  send({
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId: "fake-session", update },
  });
}

function respond(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
