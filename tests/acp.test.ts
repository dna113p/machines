import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";

import { acpAgent } from "../src/acp.ts";
import type { AgentUpdate } from "../src/index.ts";

const fakeAgent = resolve("tests/fixtures/fake-acp-agent.mjs");

test("an ACP Agent returns one Machines event", async () => {
  const run = acpAgent(process.execPath, [fakeAgent]);

  const event = await run({
    prompt: "Do the work",
    outcomes: ["completed"],
    cwd: process.cwd(),
  });

  assert.deepEqual(event, { type: "completed", source: "fake" });
});

test("an ACP Agent receives environment overrides", async () => {
  const run = acpAgent(process.execPath, [fakeAgent, "environment"], {
    env: { MACHINES_TEST_PROFILE: "/agents/pi-reviewer" },
  });

  const event = await run({
    prompt: "Do the work",
    outcomes: ["completed"],
    cwd: process.cwd(),
  });

  assert.deepEqual(event, {
    type: "completed",
    profile: "/agents/pi-reviewer",
  });
});

test("an ACP Agent can capture its message without streaming protocol text", async () => {
  const run = acpAgent(process.execPath, [fakeAgent], { output: "capture" });

  const event = await run({
    prompt: "Do the work",
    outcomes: ["completed"],
    cwd: process.cwd(),
  });

  assert.deepEqual(event, {
    type: "completed",
    source: "fake",
    message: "fake agent finished",
  });
});

test("an ACP Agent reports displayable activity without exposing protocol JSON", async () => {
  const activity: AgentUpdate[] = [];
  const run = acpAgent(process.execPath, [fakeAgent, "activity"], {
    harness: "fake-acp",
    output: "capture",
  });

  await run(
    {
      prompt: "Do the work",
      outcomes: ["completed"],
      cwd: process.cwd(),
    },
    (item) => activity.push(item),
  );

  assert.deepEqual(activity, [
    { type: "identity", harness: "fake-acp" },
    {
      type: "identity",
      harness: "fake-acp",
      model: "fake/model-1",
      thinking: "high",
    },
    {
      type: "tool",
      id: "tool-1",
      title: "npm test",
      status: "in_progress",
    },
    {
      type: "tool",
      id: "tool-1",
      status: "completed",
    },
    {
      type: "output",
      text: "fake agent finished\nMACHINES_EVENT {\"type\":\"completed\",\"source\":\"fake\"}\n",
    },
  ]);
});

test("an ACP Agent requires a working directory", async () => {
  const run = acpAgent(process.execPath, [fakeAgent]);

  await assert.rejects(
    async () => run({ prompt: "Do the work", outcomes: ["completed"] }),
    /ACP Agent requires a working directory/u,
  );
});

test("an ACP Agent requires an allowed outcome", async () => {
  const run = acpAgent(process.execPath, [fakeAgent]);

  await assert.rejects(
    async () => run({ prompt: "Do the work", outcomes: [], cwd: process.cwd() }),
    /ACP Agent requires at least one allowed outcome/u,
  );
});

test("an ACP Agent fails clearly when no event is returned", async () => {
  const run = acpAgent(process.execPath, [fakeAgent, "missing-event"]);

  await assert.rejects(
    async () => run({ prompt: "Do the work", outcomes: ["completed"], cwd: process.cwd() }),
    /ACP Agent finished without returning a Machines event/u,
  );
});
