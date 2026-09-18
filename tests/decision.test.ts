import assert from "node:assert/strict";
import { test } from "node:test";

import {
  decisionAgent,
  type DecisionEvent,
  type DecisionProvider,
  type DecisionRequest,
  type DecisionResult,
} from "../src/decision.ts";
import { agent, final, machine, run, type AgentUpdate, type Event } from "../src/index.ts";

const request = { prompt: "private failure evidence", outcomes: ["code", "environment", "unknown"], cwd: "/never-read" };
const answer = { choice: "code", probabilities: { code: 0.8, environment: 0.1, unknown: 0.1 }, confidence: 0.7, model: "fixture-1" };
const provider = (result: unknown = answer): DecisionProvider => ({
  name: "fixture", decide: () => result as DecisionResult,
});

test("decision runner separates the question, evidence, and declared choices", async () => {
  let received: DecisionRequest | undefined;
  const updates: AgentUpdate[] = [];
  const runner = decisionAgent({ name: "fixture", decide: input => { received = input; return answer; } }, {
    question: "What failed?", descriptions: { code: "Application code", unknown: "Insufficient evidence" },
  });
  assert.deepEqual(await runner(request, update => updates.push(update)), {
    type: "code", decision: { ...answer, provider: "fixture" },
  });
  assert.deepEqual(received, {
    question: "What failed?", input: request.prompt,
    choices: { code: "Application code", environment: null, unknown: "Insufficient evidence" },
  });
  assert.deepEqual(updates, [
    { type: "identity", harness: "fixture" },
    { type: "identity", harness: "fixture", model: "fixture-1" },
    { type: "output", text: 'Decision: "code"\n' },
  ]);
  assert.ok(!JSON.stringify(updates).includes(request.prompt));
});

test("providers are replaceable and absent confidence/probabilities are not fabricated", async () => {
  for (const name of ["local-classifier", "future-provider"]) {
    const event = await decisionAgent({ name, decide: () => ({ choice: "unknown" }) })(request);
    assert.deepEqual(event, { type: "unknown", decision: { choice: "unknown", provider: name } });
  }
});

test("only normalized result fields can reach workflow events", async () => {
  const result = { ...answer, type: "bypass", provider: "spoofed", raw: request.prompt, instructions: "private" };
  assert.deepEqual(await decisionAgent(provider(result))(request), {
    type: "code", decision: { ...answer, provider: "fixture" },
  });
});

test("decision configuration and requests fail before invoking a provider", async () => {
  let calls = 0;
  const unused = { name: "fixture", decide: () => { calls++; return answer; } };
  assert.throws(() => decisionAgent({ ...unused, name: " " }), /provider/);
  assert.throws(() => decisionAgent(unused, { question: " " }), /question/);
  assert.throws(() => decisionAgent(unused, { descriptions: { code: " " } }), /descriptions/);
  const runner = decisionAgent(unused);
  for (const outcomes of [[], ["code", "code"], [""], [" code"]]) {
    await assert.rejects(runner({ ...request, outcomes }), /outcomes/);
  }
  await assert.rejects(runner({ ...request, prompt: " " }), /evidence/);
  await assert.rejects(decisionAgent(unused, { descriptions: { typo: "Wrong outcome" } })(request), /allowed outcomes/);
  assert.equal(calls, 0);
});

test("decision runner rejects undeclared choices and malformed result metadata", async () => {
  for (const result of [
    null, {}, { choice: 1 }, { choice: " " },
    { ...answer, choice: "approve-everything" },
    { ...answer, confidence: Number.NaN }, { ...answer, confidence: Infinity },
    { ...answer, confidence: -0.1 }, { ...answer, confidence: 1.1 },
    { ...answer, confidence: "0.9" }, { ...answer, model: " " },
    { ...answer, probabilities: { code: 0.8, environment: 0.2 } },
    { ...answer, probabilities: { code: 0.8, environment: 0.1, other: 0.1 } },
    { ...answer, probabilities: { code: 0.8, environment: 0.1, unknown: 0.1, extra: 0 } },
    { ...answer, probabilities: { code: 0.8, environment: 0.1, unknown: 0.8 } },
    { ...answer, probabilities: { code: 1.2, environment: -0.2, unknown: 0 } },
    { ...answer, probabilities: { code: Number.NaN, environment: 0.1, unknown: 0.1 } },
    { ...answer, probabilities: { code: "0.8", environment: 0.1, unknown: 0.1 } },
  ]) {
    await assert.rejects(decisionAgent(provider(result))(request), /Decision/);
  }
});

test("small distribution rounding differences are preserved rather than normalized", async () => {
  const probabilities = { code: 0.3334, environment: 0.3333, unknown: 0.3333 };
  const result = await decisionAgent(provider({ ...answer, probabilities }))(request);
  assert.deepEqual(result.decision.probabilities, probabilities);
});

test("each invocation uses its own outcomes with no stale choices", async () => {
  const runner = decisionAgent({ name: "fixture", decide: ({ choices }) => ({ choice: Object.keys(choices)[0]! }) });
  assert.equal((await runner({ prompt: "First", outcomes: ["first"] })).type, "first");
  assert.equal((await runner({ prompt: "Second", outcomes: ["second"] })).type, "second");
});

test("the Machine, not the decision runner, owns low-confidence routing", async () => {
  for (const confidence of [0.2, 0.95]) {
    const workflow = machine({ initial: "triage", states: {
      triage: agent(request.prompt, {
        code: [
          { guard: ({ event }: { event: Event }) => ((event as DecisionEvent).decision.confidence ?? 0) >= 0.8, target: "repair" },
          { target: "review" },
        ],
        environment: "diagnose", unknown: "review",
      }, { using: "classifier" }),
      repair: final(), diagnose: final(), review: final(),
    } });
    const result = await run(workflow, { agents: { classifier: decisionAgent(provider({ ...answer, confidence })) } });
    assert.equal(result.value, confidence >= 0.8 ? "repair" : "review");
  }
});

test("provider failures and unexpected choices cannot advance a Machine", async () => {
  const workflow = machine({ initial: "triage", states: {
    triage: agent("Evidence", { code: "done" }), done: final(),
  } });
  const states: unknown[] = [];
  await assert.rejects(run(workflow, {
    agents: { default: decisionAgent(provider({ choice: "unhandled" })) },
    onState: state => states.push(state),
  }), /undeclared outcome/);
  assert.deepEqual(states, ["triage"]);
  await assert.rejects(run(workflow, {
    agents: { default: decisionAgent({ name: "offline", decide: () => { throw new Error("Provider unavailable"); } }) },
  }), /Provider unavailable/);
});
