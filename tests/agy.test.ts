import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import { agyAgent } from "../src/agy.ts";
import type { AgentUpdate } from "../src/index.ts";

const fakeAgent = resolve("tests/fixtures/fake-agy-agent.mjs");
const request = { prompt: "Do the work", outcomes: ["completed"], cwd: process.cwd() };
const finalText = 'fake agy agent finished\nMACHINES_EVENT {"type":"completed","source":"fake"}\n';

function outputProbe(mode: string, output?: "capture" | "stream") {
  const source = `
    import { agyAgent } from ${JSON.stringify(pathToFileURL(resolve("src/agy.ts")).href)};
    await agyAgent(process.execPath, ${JSON.stringify([fakeAgent, mode])}, ${JSON.stringify({ output })})(${JSON.stringify(request)});
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
    encoding: "utf8", timeout: 5_000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  return result;
}

test("an agy Agent returns one Machines event", async () => {
  const run = agyAgent(process.execPath, [fakeAgent]);

  const event = await run({
    prompt: "Do the work",
    outcomes: ["completed"],
    cwd: process.cwd(),
  });

  assert.deepEqual(event, { type: "completed", source: "fake" });
});

test("an agy Agent receives environment overrides", async () => {
  const run = agyAgent(process.execPath, [fakeAgent, "environment"], {
    env: { MACHINES_TEST_PROFILE: "/agents/custom-reviewer" },
  });

  const event = await run({
    prompt: "Do the work",
    outcomes: ["completed"],
    cwd: process.cwd(),
  });

  assert.deepEqual(event, {
    type: "completed",
    profile: "/agents/custom-reviewer",
  });
});

test("an agy Agent reports model and thinking identity", async () => {
  const updates: AgentUpdate[] = [];
  const run = agyAgent(process.execPath, [fakeAgent], {
    harness: "agy-custom",
    model: "gemini-3.8-flash-high",
    effort: "high",
  });

  await run(
    {
      prompt: "Do the work",
      outcomes: ["completed"],
      cwd: process.cwd(),
    },
    (item) => updates.push(item),
  );

  assert.deepEqual(updates[0], {
    type: "identity",
    harness: "agy-custom",
    model: "gemini-3.8-flash-high",
    thinking: "high",
  });
});

test("an agy Agent can capture its message without streaming text", async () => {
  const run = agyAgent(process.execPath, [fakeAgent], { output: "capture" });

  const event = await run({
    prompt: "Do the work",
    outcomes: ["completed"],
    cwd: process.cwd(),
  });

  assert.deepEqual(event, {
    type: "completed",
    source: "fake",
    message: "fake agy agent finished",
  });
});

test("an agy Agent reports displayable activity", async () => {
  const activity: AgentUpdate[] = [];
  const run = agyAgent(process.execPath, [fakeAgent, "activity"], {
    harness: "fake-agy",
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
    { type: "identity", harness: "fake-agy" },
    {
      type: "tool",
      id: "1",
      title: "write_to_file",
      status: "in_progress",
    },
    {
      type: "tool",
      id: "1",
      title: "write_to_file",
      status: "completed",
    },
    {
      type: "output",
      text: "fake agy agent finished\nMACHINES_EVENT {\"type\":\"completed\",\"source\":\"fake\"}\n",
    },
  ]);
});

test("an agy Agent requires a working directory", async () => {
  const run = agyAgent(process.execPath, [fakeAgent]);

  await assert.rejects(
    async () => run({ prompt: "Do the work", outcomes: ["completed"] }),
    /agy Agent requires a working directory/u,
  );
});

test("an agy Agent requires an allowed outcome", async () => {
  const run = agyAgent(process.execPath, [fakeAgent]);

  await assert.rejects(
    async () => run({ prompt: "Do the work", outcomes: [], cwd: process.cwd() }),
    /agy Agent requires at least one allowed outcome/u,
  );
});

test("an agy Agent fails clearly when no event is returned", async () => {
  const run = agyAgent(process.execPath, [fakeAgent, "missing-event"]);

  await assert.rejects(
    async () => run({ prompt: "Do the work", outcomes: ["completed"], cwd: process.cwd() }),
    /agy Agent finished without returning a Machines event/u,
  );
});

test("an agy Agent fails clearly when the process exits with an error", async () => {
  const run = agyAgent(process.execPath, [fakeAgent, "error-exit"]);

  await assert.rejects(
    async () => run({ prompt: "Do the work", outcomes: ["completed"], cwd: process.cwd() }),
    /agy Agent .* failed in .* Process exited with code 1/u,
  );
});

test("AGY permission bypass requires an explicit opt-in", async () => {
  for (const dangerouslySkipPermissions of [undefined, false, true]) {
    const event = await agyAgent(process.execPath, [fakeAgent, "arguments"], {
      dangerouslySkipPermissions, output: "capture",
    })(request);
    assert.equal(event.skipPermissions, dangerouslySkipPermissions === true);
  }
});

test("AGY arguments and identity use the merged environment, with explicit options winning", async () => {
  const previousModel = process.env.AGY_MODEL;
  const previousEffort = process.env.AGY_EFFORT;
  process.env.AGY_MODEL = "parent-model";
  process.env.AGY_EFFORT = "low";
  try {
    for (const explicit of [false, true]) {
      const updates: AgentUpdate[] = [];
      const expectedModel = explicit ? "explicit-model" : "runner-model";
      const expectedEffort = explicit ? "medium" : "high";
      const event = await agyAgent(process.execPath, [fakeAgent, "arguments"], {
        env: { AGY_MODEL: "runner-model", AGY_EFFORT: "high" },
        ...(explicit ? { model: "explicit-model", effort: "medium" as const } : {}),
        output: "capture",
      })(request, (update) => updates.push(update));
      assert.equal(event.modelFlag, expectedModel);
      assert.equal(event.effortFlag, expectedEffort);
      assert.equal(event.envModel, "runner-model");
      assert.equal(event.envEffort, "high");
      assert.deepEqual(updates[0], {
        type: "identity", harness: process.execPath, model: expectedModel, thinking: expectedEffort,
      });
    }
  } finally {
    if (previousModel === undefined) delete process.env.AGY_MODEL;
    else process.env.AGY_MODEL = previousModel;
    if (previousEffort === undefined) delete process.env.AGY_EFFORT;
    else process.env.AGY_EFFORT = previousEffort;
  }
});

test("a final AGY response supplies the outcome even after streamed progress or a preliminary event", async () => {
  for (const mode of ["progress", "stale-event", "progress-and-final"]) {
    const event = await agyAgent(process.execPath, [fakeAgent, mode], { output: "capture" })(request);
    assert.deepEqual(event, { type: "completed", source: "fake", message: "fake agy agent finished" });
  }
});

test("result-only AGY responses reach observers and default streaming output", async () => {
  const updates: AgentUpdate[] = [];
  await agyAgent(process.execPath, [fakeAgent, "result-only"], { output: "capture" })(
    request, (update) => updates.push(update),
  );
  assert.deepEqual(updates.filter((update) => update.type === "output"), [{ type: "output", text: finalText }]);
  assert.equal(outputProbe("result-only").stdout, finalText);
});

test("AGY final responses complete partial output without duplicating streamed text", () => {
  assert.equal(outputProbe("partial").stdout, finalText);
  assert.equal(outputProbe("completed").stdout, finalText);
  assert.equal(outputProbe("progress-and-final").stdout, `Working on it.\n${finalText}`);
  assert.equal(outputProbe("progress").stdout, `Working on it.\n${finalText}`);
});

test("AGY capture mode is silent and the default stream mode includes stderr", () => {
  for (const output of [undefined, "stream"] as const) {
    const result = outputProbe("stderr", output);
    assert.equal(result.stdout, finalText);
    assert.equal(result.stderr, "agy diagnostic\n");
  }
  const captured = outputProbe("stderr", "capture");
  assert.equal(captured.stdout, "");
  assert.equal(captured.stderr, "");
});

test("AGY ignores malformed records and emits only validated tool fields", async () => {
  const updates: AgentUpdate[] = [];
  const event = await agyAgent(process.execPath, [fakeAgent, "malformed"], { output: "capture" })(
    request, (update) => updates.push(update),
  );
  assert.equal(event.type, "completed");
  assert.deepEqual(updates.filter((update) => update.type === "tool"), [
    { type: "tool", id: "3", title: "write_to_file", status: "in_progress" },
  ]);
  assert.deepEqual(updates.filter((update) => update.type === "output"), [{ type: "output", text: finalText }]);
});

test("AGY accepts delta-only output but an empty final response cannot reuse an earlier event", async () => {
  const event = await agyAgent(process.execPath, [fakeAgent, "delta-only"], { output: "capture" })(request);
  assert.equal(event.type, "completed");
  await assert.rejects(
    async () => agyAgent(process.execPath, [fakeAgent, "empty-final"], { output: "capture" })(request),
    /finished without returning a Machines event/u,
  );
});

test("AGY reports signal termination instead of an exit code of null", { skip: process.platform === "win32" }, async () => {
  await assert.rejects(
    async () => agyAgent(process.execPath, [fakeAgent, "signal-exit"], { output: "capture" })(request),
    /Process terminated by SIGTERM/u,
  );
});
