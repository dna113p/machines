import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { decisionAgent } from "../src/decision.ts";
import { jevAgent, jevProvider } from "../src/jev.ts";
import { listAgentPresets, prepareMachineRun } from "../src/launcher.ts";

const request = { prompt: "private test failure", outcomes: ["code", "environment"] };
const answer = { type: "choice", choice: "code", probabilities: { code: 0.9, environment: 0.1 }, confidence: 0.75 };
const response = { model: "jev-fixture-1", answers: { decision: answer }, usage: { input_tokens: 10, output_tokens: 5 } };
const jsonFetch = (body: unknown): typeof globalThis.fetch => async () => Response.json(body);

// Every test injects its transport: no model calls, credentials, or network required.
test("Jev maps the neutral request to the documented HTTP Choice contract", async () => {
  let calls = 0;
  const fetch: typeof globalThis.fetch = async (url, init) => {
    calls++;
    assert.equal(url, "https://api.typesafe.ai/v1/systemone");
    assert.equal(init?.method, "POST");
    assert.equal(init?.redirect, "error");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer fixture-key");
    assert.equal(new Headers(init?.headers).get("content-type"), "application/json");
    assert.ok(init?.signal instanceof AbortSignal);
    assert.deepEqual(JSON.parse(String(init?.body)), {
      model: "pinned-test-model", state: request.prompt,
      questions: { decision: { type: "choice", instructions: "What failed?", criteria: { code: "Code defect", environment: null } } },
    });
    return Response.json(response);
  };
  const options = { question: "What failed?", descriptions: { code: "Code defect" } };
  const event = await decisionAgent(jevProvider({ apiKey: "fixture-key", model: "pinned-test-model", fetch }), options)(request);
  assert.deepEqual(event, {
    type: "code", decision: { choice: "code", probabilities: answer.probabilities, confidence: 0.75, model: response.model, provider: "jev" },
  });
  assert.equal(calls, 1);
});

test("Jev credentials are lazy; options override environment and default model is pinned", async () => {
  const oldKey = process.env.TYPESAFE_API_KEY;
  const oldModel = process.env.JEV_MODEL;
  try {
    delete process.env.TYPESAFE_API_KEY;
    delete process.env.JEV_MODEL;
    let calls = 0;
    let body: { model: string } | undefined;
    let authorization: string | null = null;
    const fetch: typeof globalThis.fetch = async (_url, init) => {
      calls++; body = JSON.parse(String(init?.body));
      authorization = new Headers(init?.headers).get("authorization");
      return Response.json(response);
    };
    const lazy = jevAgent({ fetch });
    await assert.rejects(lazy(request), /TYPESAFE_API_KEY/);
    assert.equal(calls, 0);
    process.env.TYPESAFE_API_KEY = "environment-fixture";
    await lazy(request);
    assert.equal(body?.model, "jev-1.13.0");
    assert.equal(authorization, "Bearer environment-fixture");
    process.env.JEV_MODEL = "environment-model";
    await lazy(request);
    assert.equal(body?.model, "environment-model");
    await jevAgent({ apiKey: "explicit-fixture", model: "explicit-model", fetch })(request);
    assert.equal(body?.model, "explicit-model");
    assert.equal(authorization, "Bearer explicit-fixture");
    await assert.rejects(jevAgent({ apiKey: "", fetch })(request), /TYPESAFE_API_KEY/);
    await assert.rejects(jevAgent({ model: "", fetch })(request), /model/);
  } finally {
    if (oldKey === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = oldKey;
    if (oldModel === undefined) delete process.env.JEV_MODEL; else process.env.JEV_MODEL = oldModel;
  }
});

test("Jev rejects wrong answer shapes, wrong choices, and incomplete distributions", async () => {
  for (const body of [
    null, {}, { ...response, model: "" }, { ...response, answers: {} },
    { ...response, answers: { other: answer } },
    { ...response, answers: { decision: { ...answer, type: "score" } } },
    { ...response, answers: { decision: { ...answer, confidence: undefined } } },
    { ...response, answers: { decision: { ...answer, confidence: 1.01 } } },
    { ...response, answers: { decision: { ...answer, choice: "environment" } } },
    { ...response, answers: { decision: { ...answer, choice: "unhandled" } } },
    { ...response, answers: { decision: { ...answer, probabilities: { code: 1 } } } },
    { ...response, answers: { decision: { ...answer, probabilities: { code: 0.6, environment: 0.1 } } } },
  ]) {
    await assert.rejects(jevAgent({ apiKey: "fixture", fetch: jsonFetch(body) })(request), /Jev|Decision/);
  }
});

test("Jev accepts tied highest probabilities without inventing extra confidence", async () => {
  const tied = { ...response, answers: { decision: { ...answer, probabilities: { code: 0.5, environment: 0.5 }, confidence: 0 } } };
  const event = await jevAgent({ apiKey: "fixture", fetch: jsonFetch(tied) })(request);
  assert.equal(event.type, "code");
  assert.equal(event.decision.confidence, 0);
});

test("Jev surfaces HTTP status without retries or leaking response bodies", async () => {
  for (const status of [401, 422, 429, 500, 529]) {
    let calls = 0;
    const fetch: typeof globalThis.fetch = async () => {
      calls++;
      return new Response("private server diagnostics and fixture-key", { status });
    };
    await assert.rejects(jevAgent({ apiKey: "fixture-key", fetch })(request), {
      message: `Jev request failed (HTTP ${status}); no automatic retry`,
    });
    assert.equal(calls, 1);
  }
});

test("Jev does not expose network errors or invalid JSON contents", async () => {
  const failed: typeof globalThis.fetch = async () => { throw new Error("private credentials"); };
  await assert.rejects(jevAgent({ apiKey: "fixture", fetch: failed })(request), { message: "Jev network request failed" });
  const invalid: typeof globalThis.fetch = async () => new Response("private invalid JSON");
  await assert.rejects(jevAgent({ apiKey: "fixture", fetch: invalid })(request), { message: "Jev returned invalid JSON" });
});

test("Jev bounds the request with an abortable timeout", async () => {
  let signal: AbortSignal | undefined;
  const stalled: typeof globalThis.fetch = async (_url, init) => {
    signal = init?.signal ?? undefined;
    return new Promise((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new Error("Aborted")), { once: true });
    });
  };
  await assert.rejects(jevAgent({ apiKey: "fixture", timeoutMs: 15, fetch: stalled })(request), /timed out after 15ms/);
  assert.equal(signal?.aborted, true);
});

test("Jev timeout also bounds reading a stalled response body", async () => {
  const stalledBody: typeof globalThis.fetch = async (_url, init) => new Response(new ReadableStream({
    start(controller) {
      init?.signal?.addEventListener("abort", () => controller.error(new Error("Body aborted")), { once: true });
    },
  }));
  await assert.rejects(jevAgent({ apiKey: "fixture", timeoutMs: 15, fetch: stalledBody })(request), /timed out after 15ms/);
});

test("Jev enforces transport limits before making requests", async () => {
  for (const timeoutMs of [0, -1, 0.5, Number.NaN, Infinity, 2_147_483_648]) {
    assert.throws(() => jevProvider({ timeoutMs }), /timeoutMs/);
  }
  let calls = 0;
  const fetch: typeof globalThis.fetch = async () => { calls++; return Response.json(response); };
  const outcomes = Array.from({ length: 256 }, (_, i) => `choice-${i}`);
  await assert.rejects(jevAgent({ apiKey: "fixture", fetch })({ ...request, outcomes }), /255 outcomes/);
  assert.equal(calls, 0);
});

test("launcher discovers Jev and injects both provider-neutral and Jev factories", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "machines-decision-catalog-"));
  try {
    const project = join(temporary, "project");
    await mkdir(join(project, ".machines"), { recursive: true });
    const location = { cwd: project, home: join(temporary, "empty-home") };
    const builtin = (await listAgentPresets(location)).find(preset => preset.name === "jev");
    assert.equal(builtin?.harness, "jev");
    assert.equal(builtin?.source, "built in");
    await writeFile(join(project, ".machines/agents.ts"), `
      export default ({decisionAgent, jevProvider, jevAgent}) => {
        if (typeof jevAgent !== 'function') throw new Error('Missing convenience factory');
        return { classifier: { description: 'Classifies using a fake Jev response', runner:
          decisionAgent(jevProvider({apiKey:'fixture', fetch:async () => Response.json(${JSON.stringify(response)})}))
        }};
      };
    `);
    await writeFile(join(project, ".machines/triage.ts"), `
      export const description = 'Routes a failure with a classifier';
      export const agentRoles = { classifier: 'Classifies supplied evidence' };
      export default ({machine,agent,final}, input) => machine({initial:'classify',states:{
        classify:agent(input,{code:'repair',environment:'diagnose'},{using:'classifier'}),
        repair:final(),diagnose:final()
      }});
    `);
    const prepared = await prepareMachineRun({ ...location, machine: "triage", input: request.prompt });
    assert.equal((await prepared.start()).value, "repair");
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
