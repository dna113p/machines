import assert from "node:assert/strict";
import { test } from "node:test";
import { agentPrompt, readAgentEvent } from "../src/agent-protocol.ts";

test("Machine workers execute their assigned state rather than recursively delegating", () => {
  const prompt = agentPrompt({ prompt: "Review the parser", outcomes: ["completed", "blocked"] });
  assert.match(prompt, /already executing one Agent state/u);
  assert.match(prompt, /Do not re-delegate.*unless.*explicitly/u);
  assert.match(prompt, /Allowed outcome types: completed, blocked/u);
  assert.match(prompt, /MACHINES_EVENT/u);
});

test("worker guidance preserves outcome and message decoding", () => {
  assert.deepEqual(readAgentEvent('Reviewed.\nMACHINES_EVENT {"type":"blocked","reason":"missing input"}', {
    adapter: "test", includeMessage: true,
  }), { type: "blocked", reason: "missing input", message: "Reviewed." });
});
