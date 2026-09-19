import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import { deepseekAgent, type DeepSeekAgentOptions } from "../src/deepseek.ts";
import { agent, final, machine, run, type AgentUpdate } from "../src/index.ts";
import { listAgentPresets, prepareMachineRun } from "../src/launcher.ts";

const fake = resolve("tests/fixtures/fake-deepseek-agent.mjs");
const request = { prompt: "Do the work\nInclude details", outcomes: ["completed"], cwd: process.cwd() };
const finalText = 'DeepSeek finished\nMACHINES_EVENT {"type":"completed","source":"fake"}\n';
const runner = (mode = "normal", options: DeepSeekAgentOptions = {}) =>
  deepseekAgent(process.execPath, [fake, mode], { output: "capture", ...options });

test("DeepSeek launches the ACP profile and sends the bounded request over stdin", async () => {
  const event = await runner("inspect")(request);
  assert.deepEqual(event.args, ["--profile", "acp"]);
  assert.equal(event.cwd, request.cwd);
  assert.equal(event.workspace, request.cwd);
  assert.deepEqual(event.mcpServers, []);
  assert.ok(Array.isArray(event.prompt));
  const text = (event.prompt[0] as { text: string }).text;
  assert.ok(text.startsWith(request.prompt));
  assert.match(text, /Allowed outcome types: completed\./);
  assert.match(text, /MACHINES_EVENT/);
  assert.deepEqual(await runner()(request), { type: "completed", source: "fake", message: "DeepSeek finished" });
});

test("DeepSeek preserves launcher overlays, custom profiles, and per-runner environment", async () => {
  const updates: AgentUpdate[] = [];
  const event = await deepseekAgent(process.execPath, [fake, "inspect", "--patch", "config with spaces.yml"], {
    profile: "machines-acp", env: { DSH_HOME: "/test/dsh-home" }, harness: "reviewer", output: "capture",
  })(request, update => updates.push(update));
  assert.deepEqual(event.args, ["--patch", "config with spaces.yml", "--profile", "machines-acp"]);
  assert.equal(event.home, "/test/dsh-home");
  assert.deepEqual(updates[0], { type: "identity", harness: "reviewer" });
});

test("DeepSeek normalizes grouped model identity and tool activity without thought output", async () => {
  const updates: AgentUpdate[] = [];
  await runner("activity")(request, update => updates.push(update));
  assert.deepEqual(updates, [
    { type: "identity", harness: "dsh" },
    { type: "identity", harness: "dsh", model: '["test-provider","test-model"]', thinking: "high" },
    { type: "tool", id: "tool-1", title: "Read file", status: "in_progress" },
    { type: "tool", id: "tool-1", status: "completed" },
    { type: "output", text: finalText },
  ]);
});

test("DeepSeek creates a fresh process and session for each invocation", async () => {
  const execute = runner("inspect");
  const first = await execute({ ...request, prompt: "First task" });
  const second = await execute({ ...request, prompt: "Second task" });
  assert.notEqual(first.pid, second.pid);
  assert.ok(JSON.stringify(second.prompt).includes("Second task"));
  assert.ok(!JSON.stringify(second.prompt).includes("First task"));
});

test("DeepSeek rejects failed turns, missing events, malformed events, and permission requests", { timeout: 10_000 }, async () => {
  for (const [mode, error] of [
    ["no-event", /without returning a Machines event/],
    ["invalid-event", /invalid event JSON/],
    ["cancelled", /stopped with "cancelled"/],
    ["max-tokens", /stopped with "max_tokens"/],
    ["rpc-error", /DSH provider is not configured/],
    ["permission", /permission.*not implemented/s],
  ] as const) {
    await assert.rejects(async () => runner(mode)(request), error);
  }
});

test("DeepSeek fails clearly for invalid setup and missing executables", async () => {
  assert.throws(() => deepseekAgent("dsh", [], { profile: " " }), /profile name/);
  assert.throws(() => deepseekAgent("dsh", [], { profile: " acp" }), /profile name/);
  await assert.rejects(async () => runner()({ prompt: "Task", outcomes: ["completed"] }), /working directory/);
  await assert.rejects(async () => runner()({ ...request, outcomes: [] }), /allowed outcome/);
  const temporary = await mkdtemp(join(tmpdir(), "machines-dsh-missing-"));
  try {
    await assert.rejects(async () => deepseekAgent(join(temporary, "missing-dsh"))(request), /ENOENT/);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test("DeepSeek streams text by default and keeps stdout and stderr quiet in capture mode", () => {
  for (const output of [undefined, "stream", "capture"]) {
    const code = `
      import { deepseekAgent } from ${JSON.stringify(pathToFileURL(resolve("src/deepseek.ts")).href)};
      await deepseekAgent(process.execPath, ${JSON.stringify([fake, "stderr"])}, ${JSON.stringify({ output })})(${JSON.stringify(request)});
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8", timeout: 5000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, output === "capture" ? "" : finalText);
    assert.equal(result.stderr, output === "capture" ? "" : "dsh diagnostic\n");
  }
});

test("DeepSeek cannot advance a Machine with an undeclared outcome", async () => {
  const workflow = machine({ initial: "work", states: {
    work: agent("Task", { completed: "done" }, { cwd: request.cwd }), done: final(),
  } });
  await assert.rejects(() => run(workflow, { agents: { default: runner("wrong-outcome") } }), /undeclared/);
});

test("the launcher discovers DeepSeek and injects its factory into overriding presets", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "machines-dsh-catalog-"));
  try {
    const project = join(temporary, "project");
    await mkdir(join(project, ".machines"), { recursive: true });
    const location = { cwd: project, home: join(temporary, "empty-home") };
    const builtin = (await listAgentPresets(location)).find(preset => preset.name === "deepseek");
    assert.equal(builtin?.harness, "dsh");
    assert.equal(builtin.source, "built in");
    await writeFile(join(project, ".machines/agents.ts"), `
      export default ({deepseekAgent}) => ({
        deepseek: { description: 'Custom DeepSeek', runner: deepseekAgent(${JSON.stringify(process.execPath)}, ${JSON.stringify([fake, "normal"])}, {output:'capture'}) }
      });
    `);
    await writeFile(join(project, ".machines/task.ts"), `
      export const description = 'Runs the configured DeepSeek preset';
      export const agentRoles = { implementer: 'Implements the task' };
      export default ({machine,agent,final}) => machine({ initial:'work', states:{
        work:agent('Do the task',{completed:'done'},{using:'implementer',cwd:${JSON.stringify(project)}}), done:final()
      }});
    `);
    const custom = (await listAgentPresets(location)).find(preset => preset.name === "deepseek");
    assert.equal(custom?.description, "Custom DeepSeek");
    assert.equal(custom.source, join(project, ".machines/agents.ts"));
    const prepared = await prepareMachineRun({ ...location, machine: "task", agents: { implementer: "deepseek" } });
    const updates: AgentUpdate[] = [];
    assert.equal((await prepared.start({ onAgentUpdate: update => updates.push(update) })).value, "done");
    assert.ok(updates.some(update => update.type === "identity" && update.harness === "dsh"));
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
