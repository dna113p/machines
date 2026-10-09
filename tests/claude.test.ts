import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import { claudeAgent } from "../src/claude.ts";
import type { AgentUpdate } from "../src/index.ts";

const fakeAgent = resolve("tests/fixtures/fake-claude-agent.mjs");
const request = { prompt: "Do the work", outcomes: ["completed"], cwd: process.cwd() };
const finalText = 'fake claude agent finished\nMACHINES_EVENT {"type":"completed","source":"fake"}\n';

function outputProbe(mode: string, output?: "capture" | "stream") {
  const source = `
    import { claudeAgent } from ${JSON.stringify(pathToFileURL(resolve("src/claude.ts")).href)};
    await claudeAgent(process.execPath, ${JSON.stringify([fakeAgent, mode])}, ${JSON.stringify({ output })})(${JSON.stringify(request)});
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
    encoding: "utf8", timeout: 5_000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  return result;
}

test("a Claude Agent returns one Machines event and can capture its message", async () => {
  assert.deepEqual(
    await claudeAgent(process.execPath, [fakeAgent])(request),
    { type: "completed", source: "fake" },
  );
  assert.deepEqual(
    await claudeAgent(process.execPath, [fakeAgent], { output: "capture" })(request),
    { type: "completed", source: "fake", message: "fake claude agent finished" },
  );
});

test("a Claude Agent receives environment overrides", async () => {
  const event = await claudeAgent(process.execPath, [fakeAgent, "environment"], {
    env: { MACHINES_TEST_PROFILE: "/agents/custom-reviewer" },
  })(request);

  assert.deepEqual(event, { type: "completed", profile: "/agents/custom-reviewer" });
});

test("a Claude Agent sends the prompt on stdin with conservative default arguments", async () => {
  const event = await claudeAgent(process.execPath, [fakeAgent, "arguments"], { output: "capture" })(request);

  assert.equal(event.promptOnStdin, true);
  assert.deepEqual(event.args, [
    "--print", "--output-format", "stream-json", "--verbose",
    "--permission-mode", "dontAsk", "--no-session-persistence",
  ]);
});

test("Claude permission, tool, and session options require explicit choices", async () => {
  const event = await claudeAgent(process.execPath, [fakeAgent, "arguments"], {
    permissionMode: "acceptEdits",
    tools: ["Read", "Edit"],
    allowedTools: ["Bash(npm test)", "Bash(git diff *)"],
    disallowedTools: ["WebFetch"],
    sessionPersistence: true,
    output: "capture",
  })(request);

  assert.deepEqual(event.args, [
    "--print", "--output-format", "stream-json", "--verbose",
    "--permission-mode", "acceptEdits",
    "--tools", "Read,Edit",
    "--allowed-tools", "Bash(npm test),Bash(git diff *)",
    "--disallowed-tools", "WebFetch",
  ]);
});

test("Claude arguments and identity use the merged environment, with explicit options winning", async () => {
  const previousModel = process.env.MACHINES_CLAUDE_MODEL;
  const previousEffort = process.env.MACHINES_CLAUDE_EFFORT;
  process.env.MACHINES_CLAUDE_MODEL = "parent-model";
  process.env.MACHINES_CLAUDE_EFFORT = "low";
  try {
    for (const explicit of [false, true]) {
      const updates: AgentUpdate[] = [];
      const expectedModel = explicit ? "explicit-model" : "runner-model";
      const expectedEffort = explicit ? "medium" : "high";
      const event = await claudeAgent(process.execPath, [fakeAgent, "arguments"], {
        env: { MACHINES_CLAUDE_MODEL: "runner-model", MACHINES_CLAUDE_EFFORT: "high" },
        ...(explicit ? { model: "explicit-model", effort: "medium" } : {}),
        harness: "claude",
        output: "capture",
      })(request, (update) => updates.push(update));
      assert.equal(event.modelFlag, expectedModel);
      assert.equal(event.effortFlag, expectedEffort);
      assert.equal(event.envModel, "runner-model");
      assert.equal(event.envEffort, "high");
      assert.deepEqual(updates.filter((update) => update.type === "identity"), [
        { type: "identity", harness: "claude", model: expectedModel, thinking: expectedEffort },
        // The CLI's own report of the resolved model replaces the requested alias.
        { type: "identity", harness: "claude", model: "claude-fake-1", thinking: expectedEffort },
      ]);
    }
  } finally {
    if (previousModel === undefined) delete process.env.MACHINES_CLAUDE_MODEL;
    else process.env.MACHINES_CLAUDE_MODEL = previousModel;
    if (previousEffort === undefined) delete process.env.MACHINES_CLAUDE_EFFORT;
    else process.env.MACHINES_CLAUDE_EFFORT = previousEffort;
  }
});

test("a Claude Agent reports displayable activity", async () => {
  const activity: AgentUpdate[] = [];
  await claudeAgent(process.execPath, [fakeAgent, "activity"], { harness: "fake-claude", output: "capture" })(
    request, (item) => activity.push(item),
  );

  assert.deepEqual(activity, [
    { type: "identity", harness: "fake-claude" },
    { type: "identity", harness: "fake-claude", model: "claude-fake-1" },
    { type: "tool", id: "toolu_1", title: "Read", status: "in_progress" },
    { type: "tool", id: "toolu_1", title: "Read", status: "completed" },
    { type: "tool", id: "toolu_2", title: "Write", status: "in_progress" },
    { type: "tool", id: "toolu_2", title: "Write", status: "failed" },
    { type: "output", text: finalText },
  ]);
});

test("Claude subagent messages are neither output nor the outcome", async () => {
  const activity: AgentUpdate[] = [];
  const event = await claudeAgent(process.execPath, [fakeAgent, "subagent"], { output: "capture" })(
    request, (item) => activity.push(item),
  );

  assert.deepEqual(event, { type: "completed", source: "fake", message: "fake claude agent finished" });
  assert.deepEqual(activity.filter((update) => update.type !== "identity"), [
    { type: "tool", id: "toolu_task", title: "Task", status: "in_progress" },
    { type: "tool", id: "toolu_task", title: "Task", status: "completed" },
    { type: "output", text: finalText },
  ]);
});

test("a Claude Agent requires a working directory and an allowed outcome", async () => {
  const run = claudeAgent(process.execPath, [fakeAgent]);

  await assert.rejects(
    async () => run({ prompt: "Do the work", outcomes: ["completed"] }),
    /Claude Agent requires a working directory/u,
  );
  await assert.rejects(
    async () => run({ prompt: "Do the work", outcomes: [], cwd: process.cwd() }),
    /Claude Agent requires at least one allowed outcome/u,
  );
});

test("a Claude Agent fails clearly without an event or a final result", async () => {
  await assert.rejects(
    async () => claudeAgent(process.execPath, [fakeAgent, "missing-event"])(request),
    /Claude Agent finished without returning a Machines event/u,
  );
  await assert.rejects(
    async () => claudeAgent(process.execPath, [fakeAgent, "no-result"], { output: "capture" })(request),
    /Claude exited without a final result/u,
  );
});

test("a Claude Agent reports process and result failures with their detail", async () => {
  await assert.rejects(
    async () => claudeAgent(process.execPath, [fakeAgent, "error-exit"], { output: "capture" })(request),
    /Claude Agent .* failed in .* Process exited with code 1\nclaude crashed/u,
  );
  await assert.rejects(
    async () => claudeAgent(process.execPath, [fakeAgent, "error-result"], { output: "capture" })(request),
    /Process exited with code 1: Not logged in/u,
  );
  // A failed turn cannot succeed through an event in an earlier message.
  await assert.rejects(
    async () => claudeAgent(process.execPath, [fakeAgent, "failed-result"], { output: "capture" })(request),
    /Process exited with code 1: Reached the turn limit/u,
  );
});

test("the final Claude result supplies the outcome even after progress or a preliminary event", async () => {
  for (const mode of ["progress", "stale-event", "result-only", "no-init"]) {
    const event = await claudeAgent(process.execPath, [fakeAgent, mode], { output: "capture" })(request);
    assert.deepEqual(event, { type: "completed", source: "fake", message: "fake claude agent finished" });
  }
  await assert.rejects(
    async () => claudeAgent(process.execPath, [fakeAgent, "empty-final"], { output: "capture" })(request),
    /finished without returning a Machines event/u,
  );
});

test("Claude output reaches observers and the terminal once", async () => {
  const updates: AgentUpdate[] = [];
  await claudeAgent(process.execPath, [fakeAgent, "result-only"], { output: "capture" })(
    request, (update) => updates.push(update),
  );
  assert.deepEqual(updates.filter((update) => update.type === "output"), [{ type: "output", text: finalText }]);
  assert.equal(outputProbe("result-only").stdout, finalText);
  assert.equal(outputProbe("completed").stdout, finalText);
  assert.equal(outputProbe("progress").stdout, `Working on it.\n${finalText}`);
});

test("a closing message streamed as several text blocks is not repeated from the final result", async () => {
  const updates: AgentUpdate[] = [];
  const event = await claudeAgent(process.execPath, [fakeAgent, "multi-block"], { output: "capture" })(
    request, (update) => updates.push(update),
  );
  assert.deepEqual(event, { type: "completed", source: "fake", message: "fake claude agent finished" });
  assert.deepEqual(updates.filter((update) => update.type === "output"), [
    { type: "output", text: "fake claude agent finished\n" },
    { type: "output", text: 'MACHINES_EVENT {"type":"completed","source":"fake"}\n' },
  ]);
  assert.equal(outputProbe("multi-block").stdout, finalText);
});

test("a malformed final result fails instead of reusing an earlier result", async () => {
  await assert.rejects(
    async () => claudeAgent(process.execPath, [fakeAgent, "malformed-final"], { output: "capture" })(request),
    /Claude returned a malformed final result/u,
  );
});

test("Claude capture mode is silent and the default stream mode includes stderr", () => {
  for (const output of [undefined, "stream"] as const) {
    const result = outputProbe("stderr", output);
    assert.equal(result.stdout, finalText);
    assert.equal(result.stderr, "claude diagnostic\n");
  }
  const captured = outputProbe("stderr", "capture");
  assert.equal(captured.stdout, "");
  assert.equal(captured.stderr, "");
});

test("Claude ignores malformed records and emits only validated tool fields", async () => {
  const updates: AgentUpdate[] = [];
  const event = await claudeAgent(process.execPath, [fakeAgent, "malformed"], { output: "capture" })(
    request, (update) => updates.push(update),
  );
  assert.equal(event.type, "completed");
  assert.deepEqual(updates.filter((update) => update.type === "tool"), [
    { type: "tool", id: "toolu_3", title: "Read", status: "in_progress" },
  ]);
  assert.deepEqual(updates.filter((update) => update.type === "output"), [{ type: "output", text: finalText }]);
});

test("Claude reports signal termination instead of an exit code of null", { skip: process.platform === "win32" }, async () => {
  await assert.rejects(
    async () => claudeAgent(process.execPath, [fakeAgent, "signal-exit"], { output: "capture" })(request),
    /Process terminated by SIGTERM/u,
  );
});
