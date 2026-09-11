import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

import { codexAgent, type CodexAgentOptions } from "../src/codex.ts";
import type { AgentUpdate } from "../src/index.ts";
import { listAgentPresets, prepareMachineRun } from "../src/launcher.ts";

const fake = resolve("tests/fixtures/fake-codex-agent.mjs");
const request = { prompt: "Do the work\nInclude useful details", outcomes: ["completed"], cwd: process.cwd() };
const finalText = 'Codex finished\nMACHINES_EVENT {"type":"completed","source":"fake"}\n';
const runner = (mode = "normal", options: CodexAgentOptions = {}) =>
  codexAgent(process.execPath, [fake, mode], { output: "capture", ...options });

test("Codex returns the final Machines event and cleans its response directory", async () => {
  const event = await runner("arguments")(request);
  assert.equal(event.type, "completed");
  assert.equal(typeof event.finalPath, "string");
  if (typeof event.finalPath !== "string") throw new Error("Missing response path");
  await assert.rejects(access(dirname(event.finalPath)), { code: "ENOENT" });
  assert.deepEqual(await runner()(request), { type: "completed", source: "fake", message: "Codex finished" });
});

test("Codex passes prompts on stdin and uses explicit non-interactive defaults", async () => {
  const event = await runner("arguments")(request);
  assert.equal(event.cwd, process.cwd());
  assert.ok(typeof event.prompt === "string" && event.prompt.startsWith(request.prompt));
  assert.ok(Array.isArray(event.args));
  const args: unknown[] = event.args;
  assert.equal(args[0], "exec");
  assert.equal(args.at(-1), "-");
  assert.equal(args[args.indexOf("--sandbox") + 1], "read-only");
  assert.ok(args.includes('approval_policy="never"'));
  assert.ok(args.includes("--json"));
  assert.ok(args.includes("--ephemeral"));
  assert.ok(!args.includes("--skip-git-repo-check"));
  assert.ok(!args.includes("--dangerously-bypass-approvals-and-sandbox"));
  assert.ok(!args.includes(request.prompt));
  const configured = await runner("arguments", { sandbox: "workspace-write", skipGitRepoCheck: true, ephemeral: false })(request);
  assert.ok(Array.isArray(configured.args));
  const configuredArgs: unknown[] = configured.args;
  assert.equal(configuredArgs[configuredArgs.indexOf("--sandbox") + 1], "workspace-write");
  assert.ok(configuredArgs.includes("--skip-git-repo-check"));
  assert.ok(!configuredArgs.includes("--ephemeral"));
});

test("Codex option identity and arguments honor merged environment precedence", async () => {
  const updates: AgentUpdate[] = [];
  const env = { CODEX_MODEL: "runner-model", CODEX_EFFORT: "high" };
  const event = await runner("arguments", { env })(request, item => updates.push(item));
  assert.equal(event.envModel, "runner-model");
  assert.ok(Array.isArray(event.args) && event.args.includes("runner-model"));
  assert.deepEqual(updates[0], { type: "identity", harness: process.execPath, model: "runner-model", thinking: "high" });
  const explicit: AgentUpdate[] = [];
  const overridden = await runner("arguments", { env, model: "explicit-model", effort: "low", harness: "reviewer" })(request, item => explicit.push(item));
  assert.ok(Array.isArray(overridden.args) && overridden.args.includes("explicit-model") && overridden.args.includes('model_reasoning_effort="low"'));
  assert.deepEqual(explicit[0], { type: "identity", harness: "reviewer", model: "explicit-model", thinking: "low" });
});

test("Codex final output owns the outcome and reaches observers without duplicates", async () => {
  for (const mode of ["normal", "progress", "final-only", "retry", "malformed"]) {
    const updates: AgentUpdate[] = [];
    const event = await runner(mode)(request, item => updates.push(item));
    assert.deepEqual(event, { type: "completed", source: "fake", message: "Codex finished" });
    const outputs = updates.filter(item => item.type === "output").map(item => item.text);
    assert.equal(outputs.filter(text => text === finalText).length, 1);
  }
});

test("Codex reports validated activity without reasoning or raw tool output", async () => {
  const updates: AgentUpdate[] = [];
  await runner("activity")(request, item => updates.push(item));
  assert.deepEqual(updates.filter(item => item.type === "tool"), [
    { type: "tool", id: "cmd", title: "ls", status: "in_progress" },
    { type: "tool", id: "cmd", title: "ls", status: "completed" },
    { type: "tool", id: "file", title: "File changes", status: "failed" },
    { type: "tool", id: "mcp", title: "docs/search", status: "in_progress" },
    { type: "tool", id: "web", title: "documentation", status: "completed" },
  ]);
  assert.ok(!JSON.stringify(updates).includes("private reasoning"));
  assert.ok(!JSON.stringify(updates).includes("raw tool output"));
});

test("Codex default streaming includes text and stderr; capture keeps both off the terminal", () => {
  for (const output of [undefined, "stream", "capture"]) {
    const code = `
      import {codexAgent} from ${JSON.stringify(pathToFileURL(resolve("src/codex.ts")).href)};
      await codexAgent(process.execPath, ${JSON.stringify([fake, "stderr"])}, ${JSON.stringify({ output })})(${JSON.stringify(request)});
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8", timeout: 5000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, output === "capture" ? "" : finalText);
    assert.equal(result.stderr, output === "capture" ? "" : "codex diagnostic\n");
  }
});

test("Codex rejects missing results, failed turns, and truncated turns despite prior events", async () => {
  for (const [mode, error] of [
    ["empty-final", /without returning a Machines event/],
    ["no-event", /without returning a Machines event/],
    ["no-final", /ENOENT/],
    ["failed", /Model request failed/],
    ["exit-failed", /Process exited with code 1: Model request failed/],
    ["incomplete", /without completing its turn/],
    ["exit-error", /Process exited with code 3.*\ncodex diagnostic/s],
  ] as const) {
    await assert.rejects(async () => runner(mode)(request), error);
  }
});

test("Codex cleans temporary results after failure and reports process startup errors", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "machines-codex-test-"));
  try {
    const pathRecord = join(temporary, "result-path");
    await assert.rejects(async () => runner("failed", { env: { MACHINES_CODEX_PATH_RECORD: pathRecord } })(request));
    const resultPath = await readFile(pathRecord, "utf8");
    await assert.rejects(access(dirname(resultPath)), { code: "ENOENT" });
    await assert.rejects(async () => codexAgent(join(temporary, "missing-command"))(request), /ENOENT/);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test("Codex reports signal termination", { skip: process.platform === "win32" }, async () => {
  await assert.rejects(async () => runner("signal")(request), /SIGTERM/);
});

test("Codex requires a working directory and at least one outcome", async () => {
  await assert.rejects(async () => runner()({ prompt: "Task", outcomes: ["completed"] }), /working directory/);
  await assert.rejects(async () => runner()({ ...request, outcomes: [] }), /at least one allowed outcome/);
});

test("the launcher discovers Codex and injects its factory into custom presets", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "machines-codex-catalog-"));
  try {
    const project = join(temporary, "project");
    await mkdir(join(project, ".machines"), { recursive: true });
    const location = { cwd: project, home: join(temporary, "empty-home") };
    const builtin = (await listAgentPresets(location)).find(preset => preset.name === "codex");
    assert.equal(builtin?.harness, "codex");
    assert.equal(builtin.source, "built in");
    await writeFile(join(project, ".machines/agents.ts"), `
      export default ({codexAgent}) => ({
        codex: { description: 'Custom Codex', runner: codexAgent(${JSON.stringify(process.execPath)}, ${JSON.stringify([fake, "normal"])}, {output:'capture'}) }
      });
    `);
    await writeFile(join(project, ".machines/task.ts"), `
      export const description = 'Runs the configured Codex preset';
      export default ({machine,agent,final}) => machine({ initial:'work', states:{
        work:agent('Do the task',{completed:'done'},{cwd:${JSON.stringify(project)}}), done:final()
      }});
    `);
    const prepared = await prepareMachineRun({ ...location, machine: "task", agents: { default: "codex" } });
    const updates: AgentUpdate[] = [];
    assert.equal((await prepared.start({ onAgentUpdate: item => updates.push(item) })).value, "done");
    assert.ok(updates.some(item => item.type === "identity" && item.harness === process.execPath));
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
