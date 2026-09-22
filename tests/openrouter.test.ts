import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { decisionAgent, type DecisionEvent } from "../src/decision.ts";
import { agent, final, machine, operation, run, type AgentUpdate, type Event } from "../src/index.ts";
import { listAgentPresets, prepareMachineRun } from "../src/launcher.ts";
import { openRouterDecisionAgent, openRouterDecisionProvider } from "../src/openrouter.ts";

const request = { prompt: "private test-failure evidence", outcomes: ["code", "environment"], cwd: "/not/read/or/sent" };
const answer = { type: "choice", choice: "code", probabilities: { code: 0.9, environment: 0.1 }, confidence: 0.75 };
// Matches OpenRouter's Decisions envelope, not a chat-completion response.
const response = {
  id: "decision-fixture", model: "typesafe/jev-fixture", provider: "TypeSafe",
  answers: { decision: answer }, usage: { input_tokens: 10, output_tokens: 0, cost: 0 },
};
const jsonFetch = (body: unknown): typeof globalThis.fetch => async () => Response.json(body);
const fixtureAgent = (body: unknown = response) => openRouterDecisionAgent({ apiKey: "fixture-key", fetch: jsonFetch(body) });

// All transports are injected; even the subprocess examples cannot make model calls.
test("OpenRouter sends a Decisions Choice request with string criteria and only explicit evidence", async () => {
  let calls = 0;
  const fetch: typeof globalThis.fetch = async (url, init) => {
    calls++;
    assert.equal(url, "https://openrouter.ai/api/alpha/decisions");
    assert.equal(init?.method, "POST");
    assert.equal(init?.redirect, "error");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer fixture-key");
    assert.equal(new Headers(init?.headers).get("content-type"), "application/json");
    assert.ok(init?.signal instanceof AbortSignal);
    assert.deepEqual(JSON.parse(String(init?.body)), {
      model: "pinned-test-model", state: request.prompt,
      questions: { decision: { type: "choice", instructions: "What failed?", criteria: {
        code: "A code defect", environment: "environment",
      } } },
    });
    return Response.json(response);
  };
  const updates: AgentUpdate[] = [];
  const classify = decisionAgent(openRouterDecisionProvider({ apiKey: "fixture-key", model: "pinned-test-model", fetch }), {
    question: "What failed?", descriptions: { code: "A code defect" },
  });
  assert.deepEqual(await classify(request, update => updates.push(update)), {
    type: "code", decision: {
      choice: "code", probabilities: answer.probabilities, confidence: 0.75,
      model: response.model, provider: "openrouter-decision",
    },
  });
  assert.deepEqual(updates, [
    { type: "identity", harness: "openrouter-decision" },
    { type: "identity", harness: "openrouter-decision", model: response.model },
    { type: "output", text: 'Decision: "code"\n' },
  ]);
  assert.equal(calls, 1);
});

test("OpenRouter keeps optional probabilities and confidence absent, including with other models", async () => {
  for (const metadata of [{}, { confidence: 0 }, { probabilities: answer.probabilities }, { probabilities: answer.probabilities, confidence: 0 }]) {
    const body = { ...response, model: "other/decision-fixture", answers: { decision: { type: "choice", choice: "code", ...metadata } } };
    const event = await fixtureAgent(body)(request);
    assert.deepEqual(event.decision, { choice: "code", ...metadata, model: body.model, provider: "openrouter-decision" });
    assert.equal(Object.hasOwn(event.decision, "confidence"), Object.hasOwn(metadata, "confidence"));
    assert.equal(Object.hasOwn(event.decision, "probabilities"), Object.hasOwn(metadata, "probabilities"));
  }
});

test("OpenRouter ignores unrelated response fields instead of forwarding them to events", async () => {
  const body = {
    ...response, diagnostics: request.prompt,
    answers: { decision: { ...answer, message: "private provider output", target: "bypass", provider: "spoofed" }, other: { type: "choice", choice: "environment" } },
  };
  assert.deepEqual(await fixtureAgent(body)(request), await fixtureAgent()(request));
});

test("OpenRouter credentials and model are lazy, explicit options win, and TypeSafe settings are ignored", async () => {
  await withEnvironment({ OPENROUTER_API_KEY: undefined, OPENROUTER_DECISION_MODEL: undefined,
    TYPESAFE_API_KEY: "not-an-openrouter-key", JEV_MODEL: "not-an-openrouter-model", OPENROUTER_MODEL: "not-a-decision-setting",
  }, async () => {
    let calls = 0;
    let model: string | undefined;
    let authorization: string | null = null;
    const fetch: typeof globalThis.fetch = async (_url, init) => {
      calls++;
      model = JSON.parse(String(init?.body)).model;
      authorization = new Headers(init?.headers).get("authorization");
      return Response.json(response);
    };
    const lazy = openRouterDecisionAgent({ fetch });
    await assert.rejects(lazy(request), /OPENROUTER_API_KEY/);
    assert.equal(calls, 0);
    process.env.OPENROUTER_API_KEY = "environment-fixture";
    await lazy(request);
    assert.equal(authorization, "Bearer environment-fixture");
    assert.equal(model, "typesafe/jev-1.13");
    process.env.OPENROUTER_DECISION_MODEL = "other/environment-model";
    await lazy(request);
    assert.equal(model, "other/environment-model");
    await openRouterDecisionAgent({ apiKey: "explicit-fixture", model: "other/explicit-model", fetch })(request);
    assert.equal(authorization, "Bearer explicit-fixture");
    assert.equal(model, "other/explicit-model");
    const successfulCalls = calls;
    for (const apiKey of ["", " \n "]) await assert.rejects(openRouterDecisionAgent({ apiKey, fetch })(request), /OPENROUTER_API_KEY/);
    for (const model of ["", " \n "]) await assert.rejects(openRouterDecisionAgent({ model, fetch })(request), /model/);
    assert.equal(calls, successfulCalls);
  });
});

test("OpenRouter rejects malformed Choice envelopes and invalid numeric metadata", async () => {
  for (const body of [
    null, {}, { error: { message: "private upstream error" } },
    { choices: [{ message: { content: '{"choice":"code"}' } }] },
    { ...response, model: "" }, { ...response, model: null },
    { ...response, answers: {} }, { ...response, answers: { other: answer } },
    ...[
      null, { type: "noul", noul: 0.9 }, { type: "score", score: 0.9 },
      { ...answer, type: "text" }, { ...answer, choice: "" }, { ...answer, choice: null },
      { ...answer, confidence: null }, { ...answer, confidence: "0.9" },
      { ...answer, confidence: -0.01 }, { ...answer, confidence: 1.01 },
      { ...answer, probabilities: null }, { ...answer, probabilities: [0.9, 0.1] },
      { ...answer, probabilities: { code: "0.9", environment: 0.1 } },
      { ...answer, probabilities: { code: 1.01, environment: -0.01 } },
    ].map(decision => ({ ...response, answers: { decision } })),
  ]) {
    await assert.rejects(fixtureAgent(body)(request), { message: "OpenRouter Decisions returned an invalid Choice response" });
  }
});

test("OpenRouter results still obey the neutral allowed-outcome and distribution checks", async () => {
  for (const decision of [
    { type: "choice", choice: "not-declared" },
    { ...answer, probabilities: { code: 1 } },
    { ...answer, probabilities: { code: 0.9, environment: 0.1, unexpected: 0 } },
    { ...answer, probabilities: { code: 0.2, environment: 0.1 } },
  ]) {
    await assert.rejects(fixtureAgent({ ...response, answers: { decision } })(request), /Decision provider selected|Decision probabilities/);
  }
  const rounded = { ...answer, probabilities: { code: 0.8999, environment: 0.1 } };
  const event = await fixtureAgent({ ...response, answers: { decision: rounded } })(request);
  assert.deepEqual(event.decision.probabilities, rounded.probabilities);
});

test("missing OpenRouter probabilities route to review rather than being inferred from confidence", async () => {
  const classify = fixtureAgent({ ...response, answers: { decision: { type: "choice", choice: "code", confidence: 1 } } });
  const workflow = machine({ initial: "classify", states: {
    classify: agent(request.prompt, { code: [
      { guard: ({ event }: { event: Event }) => ((event as DecisionEvent).decision.probabilities?.code ?? 0) >= 0.8, target: "repair" },
      { target: "review" },
    ], environment: "review" }), repair: final(), review: final(),
  } });
  assert.equal((await run(workflow, { agents: { default: classify } })).value, "review");
});

test("OpenRouter cannot advance a Machine on an undeclared outcome or HTTP failure", async () => {
  let effects = 0;
  const workflow = machine({ initial: "classify", states: {
    classify: agent(request.prompt, { code: "act", environment: "act" }),
    act: operation(() => { effects++; return { type: "completed" }; }, { completed: "done" }), done: final(),
  } });
  for (const classify of [
    fixtureAgent({ ...response, answers: { decision: { type: "choice", choice: "act" } } }),
    openRouterDecisionAgent({ apiKey: "fixture", fetch: async () => new Response("private error", { status: 503 }) }),
  ]) await assert.rejects(run(workflow, { agents: { default: classify } }), /Agent failed/);
  assert.equal(effects, 0);
});

test("OpenRouter errors expose only HTTP status, cancel bodies, and never retry or fall back", async () => {
  for (const status of [302, 400, 401, 402, 403, 404, 413, 429, 500, 502, 503, 524, 529]) {
    let calls = 0;
    let cancelled = false;
    const fetch: typeof globalThis.fetch = async () => {
      calls++;
      return new Response(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode("private response and fixture-key")); },
        cancel() { cancelled = true; },
      }), { status });
    };
    await assert.rejects(openRouterDecisionAgent({ apiKey: "fixture-key", fetch })(request), {
      message: `OpenRouter Decisions request failed (HTTP ${status}); no automatic retry`,
    });
    assert.equal(calls, 1);
    assert.equal(cancelled, true);
  }
});

test("OpenRouter reports errors even when an injected error-body cancellation stalls", async () => {
  const fetch: typeof globalThis.fetch = async () => new Response(new ReadableStream({
    cancel: () => new Promise(() => {}),
  }), { status: 502 });
  await assert.rejects(openRouterDecisionAgent({ apiKey: "fixture", timeoutMs: 15, fetch })(request), /HTTP 502/);
});

test("OpenRouter network and JSON errors do not expose credentials, body contents, or causes", async () => {
  for (const [fetch, message] of [
    [async () => { throw new Error("private credential or redirect details"); }, "OpenRouter Decisions network request failed"],
    [async () => new Response("private malformed JSON"), "OpenRouter Decisions returned invalid JSON"],
  ] as const) {
    await assert.rejects(openRouterDecisionAgent({ apiKey: "fixture", fetch })(request), error => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, message);
      assert.equal(error.cause, undefined);
      return true;
    });
  }
});

test("OpenRouter times out both stalled requests and stalled response bodies", { timeout: 5000 }, async () => {
  for (const bodyStarted of [false, true]) {
    let signal: AbortSignal | undefined;
    const fetch: typeof globalThis.fetch = async (_url, init) => {
      signal = init?.signal ?? undefined;
      if (bodyStarted) return new Response(new ReadableStream({
        start(controller) { signal?.addEventListener("abort", () => controller.error(new Error("private body error")), { once: true }); },
      }));
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("private transport error")), { once: true });
      });
    };
    await assert.rejects(openRouterDecisionAgent({ apiKey: "fixture", timeoutMs: 15, fetch })(request), /timed out after 15ms/);
    assert.equal(signal?.aborted, true);
  }
});

test("OpenRouter validates timeouts and empty choices before contacting the service", async () => {
  for (const timeoutMs of [0, -1, 0.5, NaN, Infinity, 2_147_483_648]) {
    assert.throws(() => openRouterDecisionProvider({ timeoutMs }), /timeoutMs/);
  }
  let calls = 0;
  const provider = openRouterDecisionProvider({ apiKey: "fixture", fetch: async () => { calls++; return Response.json(response); } });
  await assert.rejects(async () => provider.decide({ question: "What failed?", input: "Evidence", choices: {} }), /at least one outcome/);
  assert.equal(calls, 0);
});

test("launcher discovers OpenRouter without credentials and injects both factories for role overrides", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "machines-openrouter-catalog-"));
  try {
    const project = join(temporary, "project");
    await mkdir(join(project, ".machines"), { recursive: true });
    const location = { cwd: project, home: join(temporary, "empty-home") };
    await withEnvironment({ OPENROUTER_API_KEY: undefined }, async () => {
      const builtin = (await listAgentPresets(location)).find(preset => preset.name === "openrouter-decision");
      assert.equal(builtin?.harness, "openrouter-decision");
      assert.equal(builtin?.source, "built in");
    });
    await writeFile(join(project, ".machines/agents.ts"), `
      export default ({decisionAgent, openRouterDecisionProvider, openRouterDecisionAgent}) => {
        if (typeof openRouterDecisionAgent !== 'function') throw new Error('Missing convenience factory');
        return { 'openrouter-decision': { description: 'Classifies with a fake OpenRouter response', runner:
          decisionAgent(openRouterDecisionProvider({apiKey:'fixture', fetch:async () => Response.json(${JSON.stringify(response)})}))
        }};
      };
    `);
    await writeFile(join(project, ".machines/triage.ts"), `
      export const description = 'Routes supplied failure evidence';
      export const agentRoles = { classifier: 'Classifies evidence' };
      export default ({machine,agent,final}, input) => machine({initial:'classify',states:{
        classify:agent(input,{code:'repair',environment:'diagnose'},{using:'classifier'}),
        repair:final(),diagnose:final()
      }});
    `);
    const prepared = await prepareMachineRun({ ...location, machine: "triage", input: request.prompt, agents: { classifier: "openrouter-decision" } });
    assert.equal((await prepared.start()).value, "repair");
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test("failure-triage example stays offline by default and supports explicit OpenRouter or TypeSafe live opt-in", () => {
  for (const [args, expectedProvider] of [
    [[], "offline-fixture"],
    [["--provider", "openrouter"], "offline-fixture"],
    [["--live", "--provider", "openrouter"], "openrouter-decision"],
    [["--live"], "jev"],
  ] as const) {
    const endpoint = expectedProvider === "openrouter-decision"
      ? "https://openrouter.ai/api/alpha/decisions" : "https://api.typesafe.ai/v1/systemone";
    const key = expectedProvider === "openrouter-decision" ? "openrouter-fixture" : "typesafe-fixture";
    const preload = `
      import assert from 'node:assert/strict';
      globalThis.fetch = async (url, init) => {
        assert.notEqual(${JSON.stringify(expectedProvider)}, 'offline-fixture', 'Offline must never fetch');
        assert.equal(url, ${JSON.stringify(endpoint)});
        assert.equal(new Headers(init.headers).get('authorization'), ${JSON.stringify(`Bearer ${key}`)});
        const body = JSON.parse(init.body);
        assert.equal(body.state, 'Synthetic failure');
        return Response.json({ model: body.model, usage: {input_tokens:1,output_tokens:0}, answers: {decision: {
          type:'choice',choice:'environment',probabilities:{code:0.01,environment:0.98,unknown:0.01},confidence:0.8
        }} });
      };
    `;
    const result = spawnSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(preload)}`,
      resolve("examples/decision.ts"), ...args, "Synthetic failure"], {
      encoding: "utf8", timeout: 5000, env: { ...process.env, OPENROUTER_API_KEY: "openrouter-fixture", TYPESAFE_API_KEY: "typesafe-fixture" },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes(`"provider": "${expectedProvider}"`), result.stdout);
    assert.match(result.stdout, /classify --> diagnostics/);
  }
  const noNetwork = "globalThis.fetch = async () => { throw new Error('Network disabled in example tests'); };";
  const invalid = spawnSync(process.execPath, [
    "--import", `data:text/javascript,${encodeURIComponent(noNetwork)}`,
    resolve("examples/decision.ts"), "--live", "--provider", "typo",
  ], { encoding: "utf8", timeout: 5000 });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /provider must be jev, openrouter, laya, or von/);
});

async function withEnvironment(values: Record<string, string | undefined>, action: () => Promise<void>): Promise<void> {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await action();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}
