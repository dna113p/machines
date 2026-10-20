import "./environment.ts";

import assert from "node:assert/strict";
import { test } from "node:test";

import type { AnyStateMachine } from "xstate";

import * as machines from "../src/index.ts";
import * as graphs from "../src/run-graph.ts";
import type {
  AgentRequest, AgentRunner, AgentUpdate, Event, HumanOptions, HumanRequest, RunGraph, RunOptions,
} from "../src/index.ts";

// Read from the namespaces so that each case fails on its own until the export exists.
const { agent, final, human, machine, machineGraph, operation, requiredAgentNames, run } = machines;
const optionalAgentNames = (machines as unknown as {
  readonly optionalAgentNames: (definition: AnyStateMachine) => readonly string[];
}).optionalAgentNames;
const machineMermaid = (graphs as unknown as {
  readonly machineMermaid: (graph: RunGraph, current: string) => string;
}).machineMermaid;
// The presenter's own module, loaded by name so that this file still loads before it exists.
const presenterModule = "../src/presenter.ts";

/** Human options with `present` and `presentWith`, which HumanOptions gains with the presenter. */
function presenting(options: Record<string, unknown>): HumanOptions {
  return options as HumanOptions;
}

/** Run options with `description`, which RunOptions gains with the presenter. */
function runOptions(options: Record<string, unknown>): RunOptions {
  return options as RunOptions;
}

const prompt = "Review stage org-26 stopped: its report was malformed. What should happen?";
const choices = ["retry", "stop", "discard"] as const;

/** One Human state with a presenter, then done. */
function asking(options: Record<string, unknown> = {}) {
  return machine({
    initial: "ask",
    states: {
      ask: human(prompt, { submitted: "done" }, presenting({ choices, present: "presenter", ...options })),
      done: final(),
    },
  });
}

/** Runs a definition, answering every Human request with `answer`, and records what happened. */
async function observe(definition: AnyStateMachine, presenter: AgentRunner | undefined, answer = "retry") {
  const requests: HumanRequest[] = [];
  const presenterRequests: AgentRequest[] = [];
  const updates: AgentUpdate[] = [];
  const order: string[] = [];
  const snapshot = await run(definition, {
    ...(presenter === undefined ? {} : {
      agents: {
        presenter: (request, report) => {
          order.push("presenter");
          presenterRequests.push(request);
          return presenter(request, report);
        },
      },
    }),
    onAgentUpdate: (update) => updates.push(update),
    human: (request) => {
      order.push("human");
      requests.push(request);
      return answer;
    },
  });
  return { snapshot, requests, presenterRequests, updates, order };
}

function presenterUpdates(updates: readonly AgentUpdate[]): string[] {
  return updates.flatMap((update) => "role" in update && update.role === "presenter" ? [update.text] : []);
}

async function flush(): Promise<void> {
  await new Promise((done) => setImmediate(done));
}

test("a presenter's fields are published with the prompt and choices exactly as the state built them", async () => {
  const presented = {
    headline: "The reviewer approved; only its report left out the criteria list.",
    recommended: "retry",
    effects: { retry: "Asks the reviewer for its report again.", discard: "Deletes the worktree and its branch." },
    discards: ["discard"],
    reason: "Every check passed and the reviewer approved; the report's format failed twice.",
    page: '<h2>Where the run stopped</h2>\n<pre class="mermaid">flowchart LR\n  review --> merge\n</pre>',
  };
  const { snapshot, requests, presenterRequests, updates, order } = await observe(asking(), () => ({
    type: "presented",
    // A presenter cannot change the question.
    prompt: "Merge it now?",
    choices: ["merge"],
    suggestions: ["merge"],
    discussion: true,
    ...presented,
  }));

  assert.equal(snapshot.value, "done");
  assert.deepEqual(order, ["presenter", "human"]);
  assert.deepEqual(requests, [{ prompt, choices: [...choices], ...presented }]);
  assert.equal(presenterRequests.length, 1);
  assert.ok(presenterRequests[0]!.outcomes.includes("presented"), JSON.stringify(presenterRequests[0]!.outcomes));
  // The presenter's attempt shows in the run's Agent updates with its role.
  assert.ok(presenterUpdates(updates).length > 0, JSON.stringify(updates));
});

test("a state's own presentation fields win, and a presenter field that would break a rule with them is dropped", async () => {
  const definition = asking({ headline: "The state's own headline.", recommended: "stop" });
  const { requests } = await observe(definition, () => ({
    type: "presented",
    headline: "The presenter's headline.",
    recommended: "retry",
    effects: { stop: "Ends the run where it is." },
    // Would discard the state's recommended choice.
    discards: ["stop"],
  }), "stop");

  assert.deepEqual(requests, [{
    prompt,
    choices: [...choices],
    headline: "The state's own headline.",
    recommended: "stop",
    effects: { stop: "Ends the run where it is." },
  }]);
});

test("the presenter's input holds the description, the graph with the current state marked, the trail, Agent summaries and the presentWith text", async () => {
  let checks = 0;
  const definition = machine({
    initial: "tidyDocs",
    states: {
      shipGate: human("Ship the release now?", { submitted: "done" }, presenting({
        choices: ["ship", "hold"],
        present: "presenter",
        presentWith: () => "Evidence: /runs/42/diff.txt changes 3 files.",
      })),
      tidyDocs: operation(() => ({ type: "tidied" }), { tidied: "lintPass" }),
      lintPass: operation(() => ({ type: checks++ === 0 ? "again" : "passed" }), { again: "tidyDocs", passed: "writeNotes" }),
      writeNotes: agent("Write the release notes.", { completed: "shipGate" }, { using: "writer" }),
      done: final(),
    },
  });
  const inputs: AgentRequest[] = [];
  const requests: HumanRequest[] = [];
  const snapshot = await run(definition, runOptions({
    description: "Releases the weekly build after its checks pass.",
    agents: {
      writer: () => ({ type: "completed", summary: "Wrote notes naming three fixes (summary-7f3)." }),
      presenter: (request: AgentRequest) => {
        inputs.push(request);
        return { type: "presented" };
      },
    },
    human: (request: HumanRequest) => {
      requests.push(request);
      return "ship";
    },
  }));

  assert.equal(snapshot.value, "done");
  assert.equal(inputs.length, 1);
  const input = inputs[0]!.prompt;
  assert.ok(input.includes("Releases the weekly build after its checks pass."), input);
  assert.ok(input.includes("Ship the release now?"), input);
  assert.ok(input.includes("Evidence: /runs/42/diff.txt changes 3 files."), input);
  assert.ok(input.includes("summary-7f3"), input);
  const graph = machineMermaid(machineGraph(definition)!, "shipGate");
  assert.ok(input.includes(graph), `the graph with shipGate marked is not in the input:\n${input}`);
  // The trail is the states entered in order, the loop included; the graph lists each state only once.
  assert.match(input.replace(graph, ""), /tidyDocs[\s\S]*lintPass[\s\S]*tidyDocs[\s\S]*lintPass/u);
  // presentWith adds to the presenter's input, never to the request.
  assert.deepEqual(requests, [{ prompt: "Ship the release now?", choices: ["ship", "hold"] }]);
});

test("machineMermaid draws every state and transition and marks only the current state", () => {
  const definition = machine({
    initial: "lintPass",
    states: {
      lintPass: operation(() => ({ type: "passed" }), { passed: "shipGate", failed: "lintPass" }),
      shipGate: human("Ship?", { submitted: "done" }, { choices: ["ship", "hold"] }),
      done: final(),
    },
  });
  const graph = machineGraph(definition)!;
  const atGate = machineMermaid(graph, "shipGate");
  const atLint = machineMermaid(graph, "lintPass");

  assert.match(atGate, /^flowchart\b/u);
  for (const text of ["lintPass", "shipGate", "done", "passed", "failed", "submitted"]) {
    assert.ok(atGate.includes(text), `"${text}" is not drawn:\n${atGate}`);
  }
  const marks = (drawn: string, state: string) => drawn.split("\n").some((line) => line.includes(state) && /current/u.test(line));
  assert.ok(marks(atGate, "shipGate"), atGate);
  assert.ok(!marks(atGate, "lintPass"), atGate);
  assert.ok(marks(atLint, "lintPass"), atLint);
  assert.ok(!marks(atLint, "shipGate"), atLint);
});

test("a presenter that throws, returns no presented event, or returns a field that breaks a rule leaves that field out, says so in the Agent updates, and the person is still asked", async () => {
  const cases: Array<{
    readonly name: string;
    readonly presenter: AgentRunner;
    readonly expected: Partial<HumanRequest>;
    readonly fault?: RegExp;
  }> = [
    { name: "throws", presenter: () => { throw new Error("presenter crashed"); }, expected: {}, fault: /presenter crashed/u },
    { name: "rejects", presenter: async () => { throw new Error("presenter rejected"); }, expected: {}, fault: /presenter rejected/u },
    { name: "returns nothing", presenter: (() => undefined) as unknown as AgentRunner, expected: {} },
    { name: "returns another event", presenter: () => ({ type: "completed", headline: "Not a presented event." }), expected: {} },
    {
      name: "recommends a choice that is not a choice",
      presenter: () => ({ type: "presented", headline: "Only the report failed.", recommended: "merge", reason: "Because it passed." }),
      expected: { headline: "Only the report failed." },
      fault: /recommended/u,
    },
    {
      name: "returns a page the page check refuses",
      presenter: () => ({ type: "presented", headline: "Only the report failed.", page: "<img src=x onerror=alert(1) <>" }),
      expected: { headline: "Only the report failed." },
      fault: /page/u,
    },
    {
      name: "returns a multiline headline",
      presenter: () => ({ type: "presented", headline: "Two\nlines", recommended: "retry" }),
      expected: { recommended: "retry" },
      fault: /headline/u,
    },
  ];
  for (const { name, presenter, expected, fault } of cases) {
    let calls = 0;
    const { snapshot, requests, updates } = await observe(asking(), (request, report) => {
      calls += 1;
      return presenter(request, report);
    });
    assert.equal(snapshot.value, "done", name);
    // No re-ask and no fallback.
    assert.equal(calls, 1, name);
    assert.deepEqual(requests, [{ prompt, choices: [...choices], ...expected }], name);
    const said = presenterUpdates(updates);
    assert.ok(said.length > 0, `${name}: the presenter is not in the Agent updates: ${JSON.stringify(updates)}`);
    if (fault !== undefined) assert.ok(said.some((text) => fault.test(text)), `${name}: the fault is not shown: ${JSON.stringify(said)}`);
  }
});

test("a presenter that does not answer within the time limit is passed over, and its late result changes nothing", async (context) => {
  const { presenterTimeoutMs } = await import(presenterModule) as { readonly presenterTimeoutMs: number };
  assert.equal(presenterTimeoutMs, 120_000);
  // Mocks the global setTimeout only: node:timers/promises is not mocked, so the presenter's limit uses the global timer.
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  let release: ((event: Event) => void) | undefined;
  const requests: HumanRequest[] = [];
  const updates: AgentUpdate[] = [];
  const finished = run(asking(), {
    agents: {
      presenter: () => {
        calls += 1;
        return new Promise<Event>((done) => { release = done; });
      },
    },
    onAgentUpdate: (update) => updates.push(update),
    human: (request) => {
      requests.push(request);
      return "retry";
    },
  });

  for (let turn = 0; turn < 100 && calls === 0; turn += 1) await flush();
  assert.equal(calls, 1);
  for (let turn = 0; turn < 10; turn += 1) await flush();
  assert.deepEqual(requests, [], "the request went out before the presenter's time was up");

  context.mock.timers.tick(presenterTimeoutMs);
  const snapshot = await finished;
  assert.equal(snapshot.value, "done");
  assert.deepEqual(requests, [{ prompt, choices: [...choices] }]);
  assert.ok(presenterUpdates(updates).some((text) => /time/iu.test(text)), JSON.stringify(updates));

  release!({ type: "presented", headline: "Too late to matter." });
  for (let turn = 0; turn < 10; turn += 1) await flush();
  assert.equal(calls, 1);
  assert.deepEqual(requests, [{ prompt, choices: [...choices] }]);
});

test("a present role with no runner bound is optional: the request goes out plain and the run is not refused", async () => {
  const definition = machine({
    initial: "notes",
    states: {
      notes: agent("Write the release notes.", { completed: "ask" }, { using: "writer" }),
      ask: human(prompt, { submitted: "done" }, presenting({ choices, present: "presenter" })),
      done: final(),
    },
  });
  assert.deepEqual(requiredAgentNames(definition), ["writer"]);
  assert.deepEqual(optionalAgentNames(definition), ["presenter"]);

  const requests: HumanRequest[] = [];
  const snapshot = await run(definition, {
    agents: { writer: () => ({ type: "completed" }) },
    human: (request) => { requests.push(request); return "stop"; },
  });
  assert.equal(snapshot.value, "done");
  assert.deepEqual(requests, [{ prompt, choices: [...choices] }]);

  // With no Agent runners at all.
  const alone = await observe(asking(), undefined);
  assert.equal(alone.snapshot.value, "done");
  assert.deepEqual(alone.requests, [{ prompt, choices: [...choices] }]);
});

test("a Human state without present calls no presenter and builds its request exactly as before", async () => {
  const definition = machine({
    initial: "ask",
    states: {
      ask: human(prompt, { submitted: "done", question: "ask" }, { choices, recommended: "retry", discussion: true }),
      done: final(),
    },
  });
  assert.deepEqual(optionalAgentNames(definition), []);
  let calls = 0;
  const { requests, updates } = await observe(definition, () => { calls += 1; return { type: "presented", headline: "Unused." }; });
  assert.equal(calls, 0);
  assert.deepEqual(requests, [{ prompt, discussion: true, choices: [...choices], recommended: "retry" }]);
  assert.deepEqual(Object.keys(requests[0]!).sort(), ["choices", "discussion", "prompt", "recommended"]);
  assert.deepEqual(updates, []);
});

test("a Human state entered again presents once per entry", async () => {
  const answers = ["again", "stop"];
  let rounds = 0;
  const definition = machine({
    initial: "ask",
    states: {
      ask: human("Another round?", { submitted: "tally" }, presenting({ choices: ["again", "stop"], present: "presenter" })),
      tally: operation(() => ({ type: (rounds += 1) < 2 ? "more" : "enough" }), { more: "ask", enough: "done" }),
      done: final(),
    },
  });
  const order: string[] = [];
  const snapshot = await run(definition, {
    agents: {
      presenter: () => {
        order.push("presenter");
        return { type: "presented", headline: `Round ${order.filter((step) => step === "presenter").length}.` };
      },
    },
    human: (request) => {
      order.push(`human: ${request.headline}`);
      return answers.shift()!;
    },
  });
  assert.equal(snapshot.value, "done");
  assert.deepEqual(order, ["presenter", "human: Round 1.", "presenter", "human: Round 2."]);
});

test("human() refuses a present role that is not a non-empty trimmed name, and presentWith without present or not a function", () => {
  for (const options of [
    { present: "" },
    { present: " presenter" },
    { present: 7 },
    { presentWith: () => "Evidence." },
    { present: "presenter", presentWith: "Evidence." },
  ]) {
    assert.throws(() => human("Choose", { submitted: "done" }, presenting(options)), /present/u, JSON.stringify(options));
  }
  human("Choose", { submitted: "done" }, presenting({ present: "presenter", presentWith: () => "Evidence." }));
});

test("presentWith failure is reported without blocking, and presenters request report-only usage limits", async () => {
  const updates: AgentUpdate[] = [];
  let calls = 0;
  const definition = asking({ presentWith: () => { throw new Error("evidence unavailable"); } });
  const requests: HumanRequest[] = [];
  await run(definition, {
    agents: { presenter: (request) => {
      calls += 1;
      assert.equal(request.limits, "report");
      return { type: "presented", headline: "A question still needs an answer." };
    } },
    human: (request) => { requests.push(request); return "retry"; },
    onAgentUpdate: (update) => updates.push(update),
  });
  assert.equal(calls, 1);
  assert.equal(requests[0]!.headline, "A question still needs an answer.");
  assert.ok(presenterUpdates(updates).some((text) => text.includes("evidence unavailable")));
});
