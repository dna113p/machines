import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { smokeMcp } from "./mcp-smoke.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), "machines-package-"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const userHome = join(temporary, "empty-home");
await mkdir(userHome);
const childEnvironment = { ...process.env, MACHINES_USER_HOME: userHome };
// Runs publish run status unless told not to. With no directory named they publish under the Machines home
// above, so a developer's own directory, named or standard, receives none of these.
for (const name of ["MACHINES_RUN_STATUS_DIR", "MACHINES_RUN_OWNER", "MACHINES_RUN_PARENT", "MACHINES_RUN_LABEL"]) {
  delete childEnvironment[name];
}
try {
  const packed = JSON.parse(execFileSync(npm, ["pack", "--ignore-scripts", "--json", "--pack-destination", temporary], {
    cwd: root, encoding: "utf8",
  }));
  assert.ok(packed[0].files.some(({ path }) => path === "dist/src/index.d.ts"));
  for (const required of [
    "skills/machine-delegation/SKILL.md",
    "skills/machine-delegation/references/delegation-machine.md",
    "skills/machine-builder/SKILL.md",
    "skills/machine-project-setup/SKILL.md",
    "skills/machine-project-setup/references/project-workflows.md",
    "docs/authoring.md",
    "docs/integrations.md",
    "docs/local-decisions.md",
    "services/laya/server.py",
    "claude/statusline.mjs",
  ]) {
    assert.ok(packed[0].files.some(({ path }) => path === required), `Missing ${required}`);
  }
  assert.equal(packed[0].name, "@dna113p/machines");
  assert.ok(packed[0].files.every(({ path }) => !path.startsWith("src/") && !path.startsWith("tests/")));
  assert.ok(packed[0].files.every(({ path }) => !path.startsWith("docs/history/") && path !== "AGENTS.md"));
  await writeFile(join(temporary, "package.json"), '{"private":true,"type":"module"}\n');
  await writeFile(join(temporary, "fake-deepseek-agent.mjs"), await readFile(join(root, "tests/fixtures/fake-deepseek-agent.mjs")));
  execFileSync(npm, ["install", "--ignore-scripts", "--no-audit", "--no-fund", join(temporary, packed[0].filename)], {
    cwd: temporary, stdio: "inherit",
  });
  const code = `
    import assert from "node:assert/strict";
    import { machine, operation, final, run } from "@dna113p/machines";
    import { acpAgent } from "@dna113p/machines/acp";
    import { agyAgent } from "@dna113p/machines/agy";
    import { claudeAgent } from "@dna113p/machines/claude";
    import { codexAgent } from "@dna113p/machines/codex";
    import { chatGptWebAgent, chatGptWebContinue, chatGptWebPrompt, rigBridgeHandoffOperation } from "@dna113p/machines/chatgpt-web";
    import { deepseekAgent } from "@dna113p/machines/deepseek";
    import { decisionAgent } from "@dna113p/machines/decision";
    import { jevAgent, jevProvider } from "@dna113p/machines/jev";
    import { openRouterDecisionAgent, openRouterDecisionProvider } from "@dna113p/machines/openrouter";
    import { layaAgent, layaProvider } from "@dna113p/machines/laya";
    import { vonAgent, vonProvider } from "@dna113p/machines/von";
    import { listAgentPresets, listMachines } from "@dna113p/machines/launcher";
    import { startMachineHost } from "@dna113p/machines/host";
    import { createMachinesMcpServer } from "@dna113p/machines/mcp";
    import extension from "@dna113p/machines/pi-extension";
    import { readRunStatuses, readRunWatches, runSessionId, runStatusDirectory, runsForViewer } from "@dna113p/machines/run-status";
    assert.equal(typeof acpAgent, "function");
    assert.equal(typeof agyAgent, "function");
    assert.equal(typeof claudeAgent, "function");
    assert.equal(typeof codexAgent, "function");
    assert.equal(typeof rigBridgeHandoffOperation, "function");
    assert.ok((await listAgentPresets()).some(preset => preset.name === "chatgpt-web" && preset.harness === "chatgpt-web"));
    assert.ok(chatGptWebPrompt({ prompt: "Task", outcomes: ["completed"], cwd: "/work" }, "rig-bridge").includes('workspace_open with cwd "/work"'));
    await assert.rejects(
      async () => chatGptWebAgent({ cdpUrl: "http://127.0.0.1:9", launch: false })({ prompt: "Task", outcomes: ["completed"], cwd: process.cwd() }),
      /No browser DevTools endpoint/,
    );
    await assert.rejects(
      async () => chatGptWebContinue({ cdpUrl: "http://127.0.0.1:9", launch: false })({ conversation: "https://chatgpt.com/", text: "Reply", cwd: process.cwd() }),
      /conversation URL without credentials/,
    );
    assert.equal(typeof deepseekAgent, "function");
    assert.ok((await listAgentPresets()).some(preset => preset.name === "deepseek" && preset.harness === "dsh"));
    const deepseekEvent = await deepseekAgent(process.execPath, ["fake-deepseek-agent.mjs", "normal"], { output: "capture" })({
      prompt: "Do the task", outcomes: ["completed"], cwd: process.cwd(),
    });
    assert.equal(deepseekEvent.type, "completed");
    assert.equal(typeof jevAgent, "function");
    assert.ok((await listAgentPresets()).some(preset => preset.name === "jev"));
    const classify = decisionAgent(jevProvider({ apiKey: "offline-fixture", fetch: async () => Response.json({
      model: "fixture", answers: { decision: {
        type: "choice", choice: "completed", probabilities: { completed: 1 }, confidence: 1,
      } },
    }) }));
    const classified = await classify({ prompt: "Synthetic evidence", outcomes: ["completed"] });
    assert.equal(classified.type, "completed");
    assert.equal(classified.decision.provider, "jev");
    assert.equal(typeof openRouterDecisionAgent, "function");
    assert.ok((await listAgentPresets()).some(preset => preset.name === "openrouter-decision"));
    const routed = await decisionAgent(openRouterDecisionProvider({ apiKey: "offline-fixture", fetch: async (url, init) => {
      assert.equal(url, "https://openrouter.ai/api/alpha/decisions");
      assert.equal(JSON.parse(init.body).questions.decision.criteria.completed, "completed");
      return Response.json({ model: "fixture", usage: { input_tokens: 1, output_tokens: 0 },
        answers: { decision: { type: "choice", choice: "completed" } } });
    } }))({ prompt: "Synthetic evidence", outcomes: ["completed"] });
    assert.deepEqual(routed.decision, { choice: "completed", model: "fixture", provider: "openrouter-decision" });
    for (const [name, factory, makeAgent, port] of [
      ["laya", layaProvider, layaAgent, 8001], ["von", vonProvider, vonAgent, 8000],
    ]) {
      assert.equal(typeof makeAgent, "function");
      assert.ok((await listAgentPresets()).some(preset => preset.name === name));
      const event = await decisionAgent(factory({ baseUrl: "http://127.0.0.1:" + port,
        apiKey: "fixture-only", model: "fixture-request", fetch: async (url) => {
          assert.equal(url, "http://127.0.0.1:" + port + "/v1/systemone");
          return Response.json({ model: "fixture-response", answers: { decision: {
            type: "choice", choice: "completed", probabilities: { completed: 1, review: 0 }, confidence: 1,
          } } });
        },
      }))({ prompt: "Synthetic evidence", outcomes: ["completed", "review"] });
      assert.equal(event.type, "completed");
      assert.equal(event.decision.provider, name);
      assert.equal(event.decision.model, "fixture-response");
    }
    assert.equal(typeof listMachines, "function");
    assert.equal(typeof createMachinesMcpServer, "function");
    assert.equal(typeof extension, "function");
    // Nothing has published under the empty home: the readers find no runs and no watch list there.
    const published = runStatusDirectory();
    assert.equal(published, process.env.MACHINES_USER_HOME + "/.local/state/machines/runs");
    assert.deepEqual([readRunStatuses(published), readRunWatches(published, "viewer")], [[], []]);
    assert.equal(runSessionId({ MACHINES_RUN_OWNER: "viewer" }), "viewer");
    const at = "2026-03-04T05:06:07.000Z";
    const shown = runsForViewer([
      { schemaVersion: 2, id: "mine", pid: process.pid, owner: "viewer", machine: "release", path: "/work/release.ts",
        cwd: "/work", status: "waiting", human: { prompt: "Publish?", requestId: "request" }, startedAt: at, updatedAt: at },
      { schemaVersion: 2, id: "theirs", pid: process.pid, owner: "another", machine: "release", path: "/work/release.ts",
        cwd: "/work", status: "running", startedAt: at, updatedAt: at },
    ], { sessionId: "viewer", projectDir: "/work" }, { now: Date.parse(at) });
    assert.deepEqual(shown.map((run) => [run.id, run.status, run.shown, run.answer]), [
      ["mine", "waiting", "owned", { via: "respond", runId: "mine", requestId: "request" }],
    ]);
    const definition = machine({ initial: "work", states: {
      work: operation(() => ({ type: "completed" }), { completed: "done" }), done: final(),
    }});
    assert.equal((await run(definition)).value, "done");
    const host = await startMachineHost({ machine: "./structured.mjs", cwd: process.cwd(), input: { task: "packed", enabled: false } });
    assert.deepEqual((await host.result).output, { task: "packed", enabled: false });
  `;
  await writeFile(join(temporary, "structured.mjs"), `export const description = "Returns packaged input"; export default ({machine,final},input) => machine({ initial:"done", output:()=>input, states:{done:final()} });`);
  await writeFile(join(temporary, "consumer.mjs"), code);
  execFileSync(process.execPath, ["consumer.mjs"], { cwd: temporary, stdio: "inherit", env: childEnvironment });
  const installed = join(temporary, "node_modules/@dna113p/machines");
  const metadata = JSON.parse(await readFile(join(installed, "package.json"), "utf8"));
  assert.equal(metadata.bin.machine, "./dist/src/cli.js");
  for (const command of ["machine", "@dna113p/machines"]) {
    const cli = execFileSync(npm, ["exec", "--offline", "--", command, "list"], {
      cwd: temporary, encoding: "utf8", env: childEnvironment,
    });
    assert.equal(typeof cli, "string");
  }
  await writeFile(join(temporary, "consumer.mts"), `
    import { machine, operation, final, type MachinePrimitives } from "@dna113p/machines";
    import { claudeAgent, type ClaudeAgentOptions } from "@dna113p/machines/claude";
    import { codexAgent, type CodexAgentOptions } from "@dna113p/machines/codex";
    import { chatGptWebAgent, rigBridgeHandoffOperation, type ChatGptWebAgentOptions, type RigBridgeHandoff } from "@dna113p/machines/chatgpt-web";
    import { deepseekAgent, type DeepSeekAgentOptions } from "@dna113p/machines/deepseek";
    import { decisionAgent, type DecisionProvider, type DecisionEvent } from "@dna113p/machines/decision";
    import { jevProvider, type JevProviderOptions } from "@dna113p/machines/jev";
    import { openRouterDecisionAgent, openRouterDecisionProvider, type OpenRouterDecisionAgentOptions, type OpenRouterDecisionProviderOptions } from "@dna113p/machines/openrouter";
    import { layaAgent, layaProvider, type LayaAgentOptions, type LayaProviderOptions } from "@dna113p/machines/laya";
    import { vonAgent, vonProvider, type VonAgentOptions, type VonProviderOptions } from "@dna113p/machines/von";
    import { readRunStatuses, readRunWatches, runStatusDirectory, runsForViewer, type RunStatusRecord, type RunViewer, type RunWatch, type ViewerRun } from "@dna113p/machines/run-status";
    const runsDirectory: string | undefined = runStatusDirectory();
    const runRecords: RunStatusRecord[] = runsDirectory === undefined ? [] : readRunStatuses(runsDirectory);
    const runWatches: RunWatch[] = runsDirectory === undefined ? [] : readRunWatches(runsDirectory, "viewer");
    const runViewer: RunViewer = { sessionId: "viewer", projectDir: "/work", watches: runWatches };
    const viewerRuns: ViewerRun[] = runsForViewer(runRecords, runViewer, { now: Date.now(), all: true });
    const answered: string[] = viewerRuns.map((run) => run.answer?.via === "respond" ? run.answer.requestId : run.status);
    const layaOptions: LayaProviderOptions = { baseUrl: "http://127.0.0.1:8001", timeoutMs: 5000 };
    const vonOptions: VonProviderOptions = { baseUrl: "http://127.0.0.1:8000", timeoutMs: 5000 };
    const laya: DecisionProvider = layaProvider(layaOptions);
    const von: DecisionProvider = vonProvider(vonOptions);
    const layaAgentOptions: LayaAgentOptions = { ...layaOptions, question: "Which outcome?" };
    const vonAgentOptions: VonAgentOptions = { ...vonOptions, question: "Which outcome?" };
    const localEvaluate = (): Promise<DecisionEvent> => layaAgent(layaAgentOptions)({ prompt:"Evidence", outcomes:["yes","no"] });
    const vonEvaluate = (): Promise<DecisionEvent> => vonAgent(vonAgentOptions)({ prompt:"Evidence", outcomes:["yes","no"] });
    const routerOptions: OpenRouterDecisionProviderOptions = { model: "typesafe/jev-1.13", timeoutMs: 5000 };
    const routerProvider: DecisionProvider = openRouterDecisionProvider(routerOptions);
    const routerAgentOptions: OpenRouterDecisionAgentOptions = { ...routerOptions, question: "Which outcome?" };
    const routerAgent = openRouterDecisionAgent(routerAgentOptions);
    const classifyViaRouter = (): Promise<DecisionEvent> => routerAgent({ prompt: "Evidence", outcomes: ["completed"] });
    const jevOptions: JevProviderOptions = { model: "jev-1.13.0", timeoutMs: 5000 };
    const provider: DecisionProvider = jevProvider(jevOptions);
    const classify = decisionAgent(provider, { question: "Which outcome?" });
    const evaluate = (): Promise<DecisionEvent> => classify({ prompt: "Evidence", outcomes: ["completed"] });
    const codexOptions: CodexAgentOptions = { sandbox: "workspace-write", output: "capture" };
    codexAgent("codex", [], codexOptions);
    const claudeOptions: ClaudeAgentOptions = { model: "sonnet", permissionMode: "acceptEdits", output: "capture" };
    claudeAgent("claude", [], claudeOptions);
    const chatGptOptions: ChatGptWebAgentOptions = { connector: "rig-bridge", launch: { headless: false }, output: "capture" };
    chatGptWebAgent(chatGptOptions);
    const deepseekOptions: DeepSeekAgentOptions = { profile: "acp", output: "capture" };
    deepseekAgent("dsh", [], deepseekOptions);
    const make = ({ machine, operation, final }: MachinePrimitives) => machine({
      initial: "work", states: {
        work: operation(() => ({ type: "completed" }), { completed: "done" }), done: final(),
      },
    });
    make(await import("@dna113p/machines"));
  `);
  execFileSync(process.execPath, [
    join(root, "node_modules/typescript/bin/tsc"), "--noEmit", "--strict",
    "--types", "node", "--typeRoots", join(root, "node_modules/@types"),
    "--module", "NodeNext", "--target", "ES2024", "consumer.mts",
  ], {
    cwd: temporary, stdio: "inherit",
  });
  await smokeMcp({ args: [join(installed, "dist/mcp/server.js")], cwd: temporary, project: join(temporary, "project") });
  await writeFile(join(temporary, "consumer-pi.mjs"), `
    import assert from "node:assert/strict";
    import { setTimeout } from "node:timers/promises";
    import { resolve } from "node:path";
    import extension from "@dna113p/machines/pi-extension";
    import { startMachineHost } from "@dna113p/machines/host";
    const tools = new Map();
    const commands = new Map();
    const handlers = new Map();
    let external;
    let externalRequest;
    let widget;
    extension({
      registerTool: (tool) => tools.set(tool.name, tool),
      registerCommand: (name, command) => commands.set(name, command),
      on: (event, handler) => handlers.set(event, handler),
    });
    const context = { cwd: resolve("project"), sessionManager: { getSessionId: () => "pi-smoke" }, ui: {
      select: async () => undefined, input: async () => undefined,
      notify: () => {}, setWidget: (_key, content) => {
        widget = typeof content === "function"
          ? content(undefined, { fg: (_color, text) => text, bold: text => text }).render(120).join("\\n")
          : content;
      },
    }};
    const execute = (name, params = {}) => tools.get(name).execute("smoke", params, undefined, undefined, context);
    try {
      assert.ok((await execute("machine_list")).details.machines.some((item) => item.name === "review" && !item.error));
      const runId = (await execute("machine_start", { machine: "review" })).details.run.id;
      const waiting = await waitFor("waiting");
      await execute("machine_respond", { runId, requestId: waiting.human.requestId, response: "yes" });
      assert.equal((await waitFor("completed")).state, "done");
      await commands.get("machine-watch").handler("smoke-ticket", context);
      external = await startMachineHost({
        machine: "review", cwd: context.cwd, label: "smoke-ticket Published ticket",
        owner: "dispatch-smoke", publishRunStatus: true,
        onHumanRequest: request => { externalRequest = request; },
      });
      const deadline = Date.now() + 10_000;
      while (!widget?.includes("smoke-ticket Published ticket") || !widget?.includes("Watching only")) {
        assert.ok(Date.now() < deadline, "Published ticket did not appear in the installed Pi widget");
        await setTimeout(20);
      }
      const watched = (await execute("machine_watch")).details.runs.find(run => run.id === external.id);
      assert.equal(watched.status, "waiting");
      await handlers.get("session_shutdown")({}, context);
      // Pi's shutdown must not terminate an external host: its owner can still answer.
      assert.equal(watched.answer.via, "host");
      await external.respond("yes", externalRequest.requestId);
      await external.result;
      async function waitFor(status) {
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          const run = (await execute("machine_status", { runId })).details.runs[0];
          assert.notEqual(run.status, "failed", JSON.stringify(run));
          if (run.status === status) return run;
          await setTimeout(20);
        }
        throw new Error("Built Pi run did not become " + status);
      }
    } finally {
      await handlers.get("session_shutdown")({}, context);
      external?.terminate();
    }
  `);
  execFileSync(process.execPath, ["consumer-pi.mjs"], { cwd: temporary, stdio: "inherit", env: childEnvironment });
  console.log("Packed installation: imports, declarations, CLI, MCP widget, and MCP/Pi hosted Human round trips passed.");
} finally {
  await rm(temporary, { recursive: true, force: true });
}
