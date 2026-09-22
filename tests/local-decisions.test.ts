import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { decisionAgent, type DecisionEvent, type DecisionRequest } from "../src/decision.ts";
import { agent, final, machine, operation, run, type AgentUpdate, type Event } from "../src/index.ts";
import { layaAgent, layaProvider } from "../src/laya.ts";
import { listAgentPresets, prepareMachineRun } from "../src/launcher.ts";
import { vonAgent, vonProvider } from "../src/von.ts";

const request = { prompt: "Synthetic test evidence", outcomes: ["code", "environment"], cwd: "/never/read/or/sent" };
const answer = { type: "choice", choice: "code", probabilities: { code: 0.9, environment: 0.1 }, confidence: 0.8 };
const response = { model: "server-reported-fixture", answers: { decision: answer } };
const jsonFetch = (body: unknown = response): typeof globalThis.fetch => async () => Response.json(body);
const services = [
  { name: "laya", label: "Laya", prefix: "LAYA", port: 8001, model: "laya", min: 2, provider: layaProvider, agent: layaAgent },
  { name: "von", label: "Von", prefix: "VON", port: 8000, model: "von-1.0.0", min: 1, provider: vonProvider, agent: vonAgent },
] as const;
const environmentKeys = ["TYPESAFE_API_KEY", "TYPESAFE_BASE_URL", "JEV_MODEL", "OPENROUTER_API_KEY",
  ...services.flatMap(({ prefix }) => ["BASE_URL", "API_KEY", "MODEL"].map(suffix => `${prefix}_${suffix}`))];
let previous: Record<string, string | undefined>;
beforeEach(() => {
  previous = Object.fromEntries(environmentKeys.map(key => [key, process.env[key]]));
  for (const key of environmentKeys) delete process.env[key];
});
afterEach(() => {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

// Protocol fixtures only. No test in this file loads models or contacts a cloud API.
for (const service of services) {
  const { name, label, prefix, port, model, provider, agent: makeAgent } = service;
  test(`${label}: Choice wire contract, null criteria, normalized event and observations`, async () => {
    let calls = 0;
    const fetch: typeof globalThis.fetch = async (url, init) => {
      calls++;
      assert.equal(url, `http://127.0.0.1:${port}/v1/systemone`);
      assert.equal(init?.method, "POST");
      assert.equal(init?.redirect, "error");
      assert.ok(init?.signal instanceof AbortSignal);
      assert.equal(new Headers(init?.headers).get("authorization"), null);
      assert.equal(new Headers(init?.headers).get("content-type"), "application/json");
      assert.deepEqual(JSON.parse(String(init?.body)), {
        model, state: request.prompt,
        questions: { decision: { type: "choice", instructions: "What failed?", criteria: {
          code: "A code defect", environment: null,
        } } },
      });
      return Response.json({ ...response, usage: { private: "diagnostics" }, routing: { model: "untrusted" },
        answers: { decision: { ...answer, action: { act_probability: 0.99 }, target: "bypass", provider: "spoofed" } } });
    };
    const updates: AgentUpdate[] = [];
    const classify = decisionAgent(provider({ fetch }), { question: "What failed?", descriptions: { code: "A code defect" } });
    assert.deepEqual(await classify(request, update => updates.push(update)), {
      type: "code", decision: { choice: "code", probabilities: answer.probabilities, confidence: 0.8,
        model: response.model, provider: name },
    });
    assert.deepEqual(updates, [
      { type: "identity", harness: name }, { type: "identity", harness: name, model: response.model },
      { type: "output", text: 'Decision: "code"\n' },
    ]);
    assert.equal(calls, 1);
  });

  test(`${label}: lazy independent configuration, proxy paths, explicit options win`, async () => {
    const observed: { url: string; key: string | null; model: string }[] = [];
    const fetch: typeof globalThis.fetch = async (url, init) => {
      observed.push({ url: String(url), key: new Headers(init?.headers).get("authorization"), model: JSON.parse(String(init?.body)).model });
      return Response.json(response);
    };
    const classify = makeAgent({ fetch });
    const other = name === "laya" ? "VON" : "LAYA";
    process.env[`${other}_API_KEY`] = "other-provider-secret";
    process.env[`${other}_BASE_URL`] = "https://wrong.invalid";
    process.env[`${other}_MODEL`] = "wrong-model";
    process.env.TYPESAFE_API_KEY = "never-reuse-typesafe";
    process.env.TYPESAFE_BASE_URL = "https://wrong.invalid";
    process.env.OPENROUTER_API_KEY = "never-reuse-openrouter";
    process.env.JEV_MODEL = "never-use-jev";
    await classify(request);
    assert.deepEqual(observed[0], { url: `http://127.0.0.1:${port}/v1/systemone`, key: null, model });
    process.env[`${prefix}_BASE_URL`] = "https://service.invalid/proxy///";
    process.env[`${prefix}_API_KEY`] = "provider-fixture";
    process.env[`${prefix}_MODEL`] = "configured-model";
    await classify(request);
    assert.deepEqual(observed[1], { url: "https://service.invalid/proxy/v1/systemone", key: "Bearer provider-fixture", model: "configured-model" });
    await makeAgent({ baseUrl: "http://[::1]:9000/", apiKey: "explicit-fixture", model: "explicit-model", fetch })(request);
    assert.deepEqual(observed[2], { url: "http://[::1]:9000/v1/systemone", key: "Bearer explicit-fixture", model: "explicit-model" });
  });

  test(`${label}: invalid configuration and input fail before HTTP`, async () => {
    let calls = 0;
    const fetch: typeof globalThis.fetch = async () => { calls++; return Response.json(response); };
    for (const timeoutMs of [0, -1, 0.5, NaN, Infinity, 2_147_483_648]) {
      assert.throws(() => provider({ timeoutMs }), /timeoutMs/);
    }
    for (const baseUrl of ["", " ", "not-a-url", "file:///tmp/socket", "ftp://service.invalid", "https://user:secret@service.invalid", "https://service.invalid?key=secret", "https://service.invalid/#secret"]) {
      await assert.rejects(makeAgent({ baseUrl, fetch })(request), /baseUrl must be/);
    }
    for (const apiKey of ["", " ", "bad\r\ntoken", "non-ascii-☃"]) {
      await assert.rejects(makeAgent({ apiKey, fetch })(request), /apiKey/);
    }
    for (const model of ["", " \n"]) await assert.rejects(makeAgent({ model, fetch })(request), /model/);
    const invalidRequests: readonly DecisionRequest[] = [
      { question: "Which?", input: "Evidence", choices: {} },
      { question: " ", input: "Evidence", choices: { a: null, b: null } },
      { question: "Which?", input: " ", choices: { a: null, b: null } },
      { question: "Which?", input: "Evidence", choices: { " a": null, b: "" } },
    ];
    for (const input of invalidRequests) await assert.rejects(async () => provider({ fetch }).decide(input));
    assert.equal(calls, 0);
  });

  test(`${label}: minimum choices reflect the actual engine`, async () => {
    const classify = makeAgent({ fetch: jsonFetch({ model, answers: { decision: {
      type: "choice", choice: "only", probabilities: { only: 1 }, confidence: 1,
    } } }) });
    if (service.min === 2) await assert.rejects(classify({ prompt: "Evidence", outcomes: ["only"] }), /at least 2/);
    else assert.equal((await classify({ prompt: "Evidence", outcomes: ["only"] })).type, "only");
  });

  test(`${label}: malformed or incomplete envelopes are rejected, never inferred`, async () => {
    const malformed = [
      null, {}, { error: "secret" }, { ...response, model: "" }, { ...response, model: null },
      { ...response, answers: {} },
      ...[
        null, { type: "noul", noul: 0.9 }, { type: "score", score: 1 },
        { ...answer, type: "text" }, { ...answer, choice: "" }, { ...answer, choice: null },
        { ...answer, probabilities: undefined }, { ...answer, probabilities: null },
        { ...answer, probabilities: [0.9, 0.1] }, { ...answer, probabilities: { code: "0.9", environment: 0.1 } },
        { ...answer, probabilities: { code: 1.1, environment: -0.1 } },
        { ...answer, confidence: undefined }, { ...answer, confidence: null },
        { ...answer, confidence: "0.8" }, { ...answer, confidence: 1.1 },
      ].map(decision => ({ ...response, answers: { decision } })),
    ];
    for (const body of malformed) {
      await assert.rejects(makeAgent({ fetch: jsonFetch(body) })(request), { message: `${label} returned an invalid Choice response` });
    }
  });

  test(`${label}: exact declared outcomes, full distributions and highest-probability selection`, async () => {
    for (const decision of [
      { ...answer, choice: "undeclared", probabilities: { undeclared: 1 } },
      { ...answer, probabilities: { code: 1 } },
      { ...answer, probabilities: { code: 0.9, environment: 0.1, extra: 0 } },
      { ...answer, probabilities: { code: 0.5, environment: 0.1 } },
      { ...answer, choice: "environment" },
    ]) await assert.rejects(makeAgent({ fetch: jsonFetch({ ...response, answers: { decision } }) })(request));
    for (const probabilities of [{ code: 0.5, environment: 0.5 }, { code: 0.8999, environment: 0.1 }]) {
      const result = await makeAgent({ fetch: jsonFetch({ ...response, answers: { decision: { ...answer, probabilities, confidence: 0 } } }) })(request);
      assert.deepEqual(result.decision.probabilities, probabilities);
      assert.equal(result.decision.confidence, 0);
    }
  });

  test(`${label}: bounded HTTP errors, no retries, no body or credential leaks`, async () => {
    for (const status of [302, 401, 404, 413, 422, 429, 500, 503]) {
      let calls = 0;
      let cancelled = false;
      const fetch: typeof globalThis.fetch = async () => {
        calls++;
        return new Response(new ReadableStream({
          cancel() { cancelled = true; return new Promise(() => {}); },
        }), { status });
      };
      await assert.rejects(makeAgent({ apiKey: "fixture-secret", timeoutMs: 100, fetch })(request), {
        message: `${label} request failed (HTTP ${status}); no automatic retry`,
      });
      assert.equal(calls, 1);
      assert.equal(cancelled, true);
    }
    for (const [fetch, message] of [
      [async () => { throw new Error("private credential details"); }, `${label} network request failed`],
      [async () => new Response("private invalid JSON"), `${label} returned invalid JSON`],
      [async () => new Response("x".repeat(1_048_577)), `${label} response exceeds 1 MiB`],
    ] as const) {
      await assert.rejects(makeAgent({ fetch })(request), error => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, message);
        assert.equal(error.cause, undefined);
        return true;
      });
    }
  });

  test(`${label}: deadlines include connection and body reads, even with non-cooperative fixtures`, { timeout: 5000 }, async () => {
    for (const bodyStarted of [false, true]) {
      let signal: AbortSignal | undefined;
      let cancelled = false;
      const fetch: typeof globalThis.fetch = async (_url, init) => {
        signal = init?.signal ?? undefined;
        return bodyStarted ? new Response(new ReadableStream({ cancel() { cancelled = true; } })) : new Promise(() => {});
      };
      await assert.rejects(makeAgent({ fetch, timeoutMs: 15 })(request), /timed out after 15ms/);
      assert.equal(signal?.aborted, true);
      assert.equal(cancelled, bodyStarted);
    }
  });

  test(`${label}: Machine owns confidence routing; failures cannot reach action states`, async () => {
    let effects = 0;
    const workflow = machine({ initial: "classify", states: {
      classify: agent(request.prompt, { code: [
        { guard: ({ event }: { event: Event }) => ((event as DecisionEvent).decision.probabilities?.code ?? 0) >= 0.95, target: "act" },
        { target: "review" },
      ], environment: "review" }),
      act: operation(() => { effects++; return { type: "done" }; }, { done: "done" }),
      review: final(), done: final(),
    } });
    assert.equal((await run(workflow, { agents: { default: makeAgent({ fetch: jsonFetch() }) } })).value, "review");
    await assert.rejects(run(workflow, { agents: { default: makeAgent({ fetch: async () => new Response("private failure", { status: 503 }) }) } }), /Agent failed/);
    assert.equal(effects, 0);
  });

  test(`${label}: real loopback HTTP transport works and refuses redirects`, async () => {
    let redirectTargetCalls = 0;
    const server = createServer(async (req, res) => {
      if (req.url === "/redirect/v1/systemone") { res.writeHead(302, { Location: "/target" }); res.end(); return; }
      if (req.url === "/target") redirectTargetCalls++;
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const payload = JSON.parse(Buffer.concat(chunks).toString());
      assert.equal(req.url, "/v1/systemone");
      assert.equal(payload.state, request.prompt);
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(response));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      assert.equal((await makeAgent({ baseUrl })(request)).type, "code");
      await assert.rejects(makeAgent({ baseUrl: `${baseUrl}/redirect` })(request), /network request failed/);
      assert.equal(redirectTargetCalls, 0);
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });

  test(`${label}: discovery is offline and factory injection supports role overrides`, async () => {
    const temporary = await mkdtemp(join(tmpdir(), `machines-${name}-`));
    try {
      const project = join(temporary, "project");
      await mkdir(join(project, ".machines"), { recursive: true });
      const location = { cwd: project, home: join(temporary, "empty-home") };
      process.env[`${prefix}_BASE_URL`] = "invalid-until-invoked";
      process.env[`${prefix}_API_KEY`] = " ";
      const builtin = (await listAgentPresets(location)).find(preset => preset.name === name);
      assert.equal(builtin?.harness, name);
      assert.equal(builtin?.source, "built in");
      delete process.env[`${prefix}_BASE_URL`];
      delete process.env[`${prefix}_API_KEY`];
      await writeFile(join(project, ".machines/agents.ts"), `
        export default ({ decisionAgent, ${name}Provider, ${name}Agent }) => {
          if (typeof ${name}Agent !== 'function') throw new Error('Missing factory');
          return { '${name}': { description:'Protocol fixture, not inference', runner:
            decisionAgent(${name}Provider({ fetch:async () => Response.json(${JSON.stringify(response)}) }))
          } };
        };
      `);
      await writeFile(join(project, ".machines/triage.ts"), `
        export const description = 'Routes supplied evidence';
        export const agentRoles = { classifier:'Classifies evidence' };
        export default ({machine,agent,final}, input) => machine({ initial:'classify', states:{
          classify:agent(input,{code:'repair',environment:'diagnose'},{using:'classifier'}),
          repair:final(),diagnose:final()
        } });
      `);
      const prepared = await prepareMachineRun({ ...location, machine: "triage", input: request.prompt, agents: { classifier: name } });
      assert.equal((await prepared.start()).value, "repair");
    } finally { await rm(temporary, { recursive: true, force: true }); }
  });

  test(`${label}: example requires explicit live opt-in (injected transport, not model inference)`, () => {
    for (const live of [false, true]) {
      const preload = `globalThis.fetch = async (url, init) => {
        if (!${live}) throw new Error('Offline must never fetch');
        if (url !== 'http://127.0.0.1:${port}/v1/systemone') throw new Error('Wrong endpoint');
        return Response.json({model:'fixture-not-inference',answers:{decision:{
          type:'choice',choice:'environment',probabilities:{code:0.01,environment:0.98,unknown:0.01},confidence:0.8
        }}});
      };`;
      const result = spawnSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(preload)}`,
        resolve("examples/decision.ts"), "--provider", name, ...(live ? ["--live"] : []), "Synthetic evidence"],
      { encoding: "utf8", timeout: 5000, env: process.env });
      assert.equal(result.status, 0, result.stderr);
      assert.ok(result.stdout.includes(`"provider": "${live ? name : "offline-fixture"}"`), result.stdout);
      assert.match(result.stdout, /classify --> diagnostics/);
    }
  });
}
