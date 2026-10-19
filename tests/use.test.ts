import "./environment.ts";

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, type TestContext } from "node:test";

import type { AnyStateMachine } from "xstate";

import * as machines from "../src/index.ts";
import { prepareMachineRun } from "../src/launcher.ts";
import type { RunGraph } from "../src/run-graph.ts";
import { checkpointPath, machineSourceHash } from "../src/run-checkpoint.ts";

// Read from the namespace so that each case fails on its own until the export exists.
const { final, machine, run } = machines;
const use = (machines as unknown as { readonly use: (selector: string, options: unknown) => Record<string, unknown> }).use;

const fixture = (name: string) => resolve(`tests/fixtures/use/${name}.machine.ts`);

/** A cwd and home with no Machines and no configured Agents, removed after the test. */
function isolated(t: TestContext): { readonly cwd: string; readonly home: string } {
  const directory = mkdtempSync(join(tmpdir(), "machines-use-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { cwd: directory, home: directory };
}

function rejectsNaming(...names: readonly string[]) {
  return (cause: unknown) => {
    assert.ok(cause instanceof Error, String(cause));
    for (const name of names) assert.ok(cause.message.includes(name), `"${cause.message}" does not name ${name}`);
    return true;
  };
}

test("use returns a state that invokes the use actor and handles the given endings", () => {
  const state = use("./child.machine.ts", { input: () => "", on: { success: "fixed", failure: "askedOwner" } });
  assert.equal((state.invoke as { readonly src?: unknown }).src, "use");
  assert.deepEqual(Object.keys(state.on as object).sort(), ["failure", "success"]);
});

test("a parent routes to a different state on each of the child's endings and receives the child's output", async (t) => {
  for (const [input, state, report] of [
    ["succeed", "fixed", "succeed on set at entry"],
    ["fail", "askedOwner", "fail on set at entry"],
  ] as const) {
    const prepared = await prepareMachineRun({ ...isolated(t), machine: fixture("parent"), input });
    const snapshot = await prepared.start();
    assert.equal(snapshot.status, "done");
    assert.equal(snapshot.value, state);
    assert.deepEqual(snapshot.output, { received: { report } });
  }
});

test("the child's input() sees the parent's working data at entry, not at prepare", async (t) => {
  const prepared = await prepareMachineRun({ ...isolated(t), machine: fixture("parent"), input: "succeed" });
  const snapshot = await prepared.start();
  const { received } = snapshot.output as { readonly received: { readonly report: string } };
  assert.match(received.report, /set at entry/u);
  assert.doesNotMatch(received.report, /set at prepare/u);
});

test("an existing Machine with endings is usable as a child unchanged", async (t) => {
  for (const [input, state] of [["", "succeeded"], ["fail", "failed"], ["cancel", "cancelled"]] as const) {
    const prepared = await prepareMachineRun({ ...isolated(t), machine: fixture("uses-matching"), input });
    const snapshot = await prepared.start();
    assert.equal(snapshot.value, state);
  }
});

for (const [name, what, names] of [
  ["wrong-on", "an on that misses one of the child's endings", ["diagnose", "child"]],
  ["extra-on", "an on that adds an ending the child does not declare", ["diagnose", "child"]],
  ["uses-no-endings", "a child that declares no endings", ["delegate", "bare"]],
  ["unknown", "an unknown selector", ["delegate", "no-such-machine"]],
  ["unlisted", "a selector missing from the module's uses", ["diagnose", "child"]],
  ["self", "a Machine that uses itself", ["self"]],
  ["cycle-a", "a cycle through another Machine", ["cycle-a", "cycle-b"]],
  ["depth-1", "nesting of 4", ["depth-5"]],
] as const) {
  test(`${what} fails to load, naming ${names.join(" and ")}`, async (t) => {
    await assert.rejects(prepareMachineRun({ ...isolated(t), machine: fixture(name) }), rejectsNaming(...names));
  });
}

test("nesting of 3 loads and runs each child in turn", async (t) => {
  const prepared = await prepareMachineRun({ ...isolated(t), machine: fixture("depth-2") });
  const snapshot = await prepared.start();
  assert.equal(snapshot.status, "done");
  assert.equal(snapshot.value, "done");
});

test("a child's Agent state using reviewer runs with the parent's reviewer runner", async (t) => {
  const { home } = isolated(t);
  const prepared = await prepareMachineRun({ cwd: resolve("tests/fixtures/use-project"), home, machine: fixture("review-parent") });
  const snapshot = await prepared.start();
  assert.equal(snapshot.status, "done");
  // The fixture's default runner rejects; only its reviewer approves.
  assert.equal(snapshot.value, "accepted");
});

test("a child's reviewer role with no runner fails at prepare, as for a parent", async (t) => {
  await assert.rejects(
    prepareMachineRun({ ...isolated(t), machine: fixture("review-parent") }),
    rejectsNaming("reviewer"),
  );
});

test("a failing child fails the parent's state with the child's error", async (t) => {
  const prepared = await prepareMachineRun({ ...isolated(t), machine: fixture("uses-failing") });
  await assert.rejects(prepared.start(), rejectsNaming("delegate", "the child broke its work"));
});

test("without sleep, a child's Human request goes to the parent's Human runner", async (t) => {
  const prompts: string[] = [];
  const prepared = await prepareMachineRun({ ...isolated(t), machine: fixture("uses-human") });
  const snapshot = await prepared.start({
    human(request) {
      prompts.push(request.prompt);
      return "approve";
    },
  });
  assert.equal(snapshot.value, "accepted");
  assert.deepEqual(prompts, ["Approve the child's work?"]);
});

/** A sleeping checkpoint, read loosely so the test names only what the ticket asks. */
interface SavedLevel {
  readonly schemaVersion?: number;
  readonly machine: { readonly path: string; readonly sourceHash: string };
  readonly state: { readonly value: unknown; readonly kind: string; due?: string };
  readonly children?: readonly SavedLevel[];
}

function savedCheckpoint(directory: string, id: string): SavedLevel {
  return JSON.parse(readFileSync(checkpointPath(directory, id), "utf8")) as SavedLevel;
}

function onlyChild(level: SavedLevel): SavedLevel {
  assert.ok(Array.isArray(level.children), `no children saved: ${JSON.stringify(level)}`);
  assert.equal(level.children.length, 1);
  return level.children[0]!;
}

test("a sleeping run reaching a child's timed wait sleeps, saving the parent at its use state and the child under children", async (t) => {
  const location = isolated(t);
  const prepared = await prepareMachineRun({ ...location, machine: fixture("uses-wait") });
  let slept: string | undefined;
  const snapshot = await prepared.start({
    checkpoint: { directory: location.cwd, id: "resting", sleep: true },
    onSleep(due) { slept = due; },
  });
  assert.equal(typeof slept, "string", "the run did not sleep at its child's wait");
  assert.notEqual(snapshot.status, "done");
  const checkpoint = savedCheckpoint(location.cwd, "resting");
  assert.equal(checkpoint.schemaVersion, 2);
  assert.equal(checkpoint.state.value, "delegate");
  const child = onlyChild(checkpoint);
  assert.equal(child.machine.path, fixture("wait-child"));
  assert.equal(child.machine.sourceHash, machineSourceHash(fixture("wait-child")));
  assert.deepEqual({ value: child.state.value, kind: child.state.kind, due: child.state.due }, { value: "rest", kind: "wait", due: slept });
});

test("a continued run takes its child's timed wait once due and routes on the child's ending", async (t) => {
  const location = isolated(t);
  const prepared = await prepareMachineRun({ ...location, machine: fixture("uses-wait") });
  await prepared.start({ checkpoint: { directory: location.cwd, id: "resting", sleep: true }, onSleep() {} });
  const checkpoint = savedCheckpoint(location.cwd, "resting");
  // The child's hour-long wait is made due now.
  onlyChild(checkpoint).state.due = new Date(Date.now() - 1_000).toISOString();

  const continued = await prepareMachineRun({ ...location, machine: fixture("uses-wait"), continueRun: checkpoint as never });
  const snapshot = await continued.start();
  assert.equal(snapshot.status, "done");
  assert.equal(snapshot.value, "done");
});

test("a sleeping run reaching a child's Human request sleeps with the child's request, and continuation gives the child the answer", async (t) => {
  const location = isolated(t);
  const prepared = await prepareMachineRun({ ...location, machine: fixture("uses-human") });
  const requests: { readonly prompt: string; readonly choices?: readonly string[] }[] = [];
  const snapshot = await prepared.start({
    checkpoint: { directory: location.cwd, id: "asking", sleep: true },
    onHumanSleep(request) { requests.push(request); },
  });
  assert.notEqual(snapshot.status, "done");
  assert.deepEqual(requests.map(({ prompt, choices }) => ({ prompt, choices })), [{ prompt: "Approve the child's work?", choices: ["approve"] }]);
  const checkpoint = savedCheckpoint(location.cwd, "asking");
  assert.equal(checkpoint.schemaVersion, 2);
  assert.equal(checkpoint.state.value, "delegate");
  const child = onlyChild(checkpoint);
  assert.equal(child.machine.path, fixture("human-child"));
  assert.deepEqual({ value: child.state.value, kind: child.state.kind }, { value: "ask", kind: "human" });

  const continued = await prepareMachineRun({ ...location, machine: fixture("uses-human"), continueRun: checkpoint as never });
  const done = await continued.start({ answer: "approve", human() { assert.fail("the child asked again instead of taking the answer"); } });
  assert.equal(done.status, "done");
  assert.equal(done.value, "accepted");
});

test("run() without the launcher fails at a use state, naming prepareMachineRun", async () => {
  const definition = machine({
    initial: "diagnose",
    states: {
      diagnose: use(fixture("child"), { input: () => ({ task: "work", outcome: "succeed" }), on: { success: "fixed", failure: "askedOwner" } }),
      fixed: final(),
      askedOwner: final(),
    },
  } as never) as unknown as AnyStateMachine;
  await assert.rejects(run(definition), rejectsNaming("prepareMachineRun"));
});

/** The launcher's start options with the graph callback this ticket adds. */
type StartWithGraph = Parameters<Awaited<ReturnType<typeof prepareMachineRun>>["start"]>[0] & {
  readonly onGraph?: (graph: RunGraph) => void;
};

const stateOf = (graph: RunGraph | undefined, id: string) => graph?.states.find((state) => state.id === id);

test("while a child runs, the reported state is the parent's use state with the child's state under it", async (t) => {
  const { home } = isolated(t);
  const prepared = await prepareMachineRun({ cwd: resolve("tests/fixtures/use-project"), home, machine: fixture("review-parent") });
  const states: unknown[] = [];
  const snapshot = await prepared.start({ onState: (state) => states.push(state) });
  assert.equal(snapshot.value, "accepted");
  const at = (value: unknown) => states.findIndex((state) => JSON.stringify(state) === JSON.stringify(value));
  // The child's Agent state is named under the parent's use state, in the record's form for nested states.
  assert.ok(at({ review: "review" }) > at("review"), JSON.stringify(states));
  assert.equal(at("review"), 0, JSON.stringify(states));
  assert.equal(states.at(-1), "accepted", JSON.stringify(states));
  // Nothing the child reports stands alone, as if it were the parent's own state.
  for (const state of states) assert.ok(typeof state !== "string" || ["review", "accepted"].includes(state), JSON.stringify(states));
});

test("a use state is drawn as a group whose edges are the child's endings, and the child's states join it as it starts", async (t) => {
  const { home } = isolated(t);
  const prepared = await prepareMachineRun({ cwd: resolve("tests/fixtures/use-project"), home, machine: fixture("review-parent") });
  assert.deepEqual(stateOf(prepared.graph, "review"), { id: "review", kind: "group" });
  assert.deepEqual(prepared.graph?.edges.filter((edge) => edge.from === "review"), [
    { from: "review", to: "accepted", event: "approved" },
    { from: "review", to: "refused", event: "rejected" },
  ]);
  // The child's graph needs its input, so it cannot be drawn before the child starts.
  assert.equal(prepared.graph?.states.some((state) => state.id.startsWith("review.")), false);

  const graphs: RunGraph[] = [];
  await prepared.start({ onGraph: (graph) => graphs.push(graph) } as StartWithGraph);
  const graph = graphs.at(-1);
  assert.ok(graph, "the grown graph was reported");
  assert.equal(graph.initial, "review");
  assert.deepEqual(stateOf(graph, "review"), { id: "review", kind: "group" });
  assert.deepEqual(stateOf(graph, "review.review"), { id: "review.review", parent: "review", kind: "agent", role: "reviewer" });
  for (const id of ["review.approved", "review.rejected"]) {
    assert.deepEqual({ ...stateOf(graph, id), ending: undefined }, { id, parent: "review", kind: "final", ending: undefined });
  }
  for (const id of ["accepted", "refused"]) assert.ok(stateOf(graph, id), `${id} is still drawn`);
  for (const edge of [
    { from: "review", to: "accepted", event: "approved" },
    { from: "review", to: "refused", event: "rejected" },
    { from: "review.review", to: "review.approved", event: "approved" },
    { from: "review.review", to: "review.rejected", event: "rejected" },
  ]) assert.ok(graph.edges.some((found) => JSON.stringify(found) === JSON.stringify(edge)), JSON.stringify(edge));
  assert.equal(graph.edges.some((edge) => edge.from === "review" && edge.event === "done"), false);
});

test("each level of nesting reports its use state's path and nests its graph under it", async (t) => {
  const prepared = await prepareMachineRun({ ...isolated(t), machine: fixture("depth-2") });
  const states: unknown[] = [];
  const graphs: RunGraph[] = [];
  const snapshot = await prepared.start({ onState: (state) => states.push(state), onGraph: (graph) => graphs.push(graph) } as StartWithGraph);
  assert.equal(snapshot.value, "done");
  // depth-2 uses depth-3, which uses depth-4, which uses depth-5 and its work state.
  assert.ok(states.some((state) => JSON.stringify(state) === JSON.stringify({ next: { next: { next: "work" } } })), JSON.stringify(states));
  const graph = graphs.at(-1);
  assert.deepEqual(stateOf(graph, "next"), { id: "next", kind: "group" });
  assert.deepEqual(stateOf(graph, "next.next"), { id: "next.next", parent: "next", kind: "group" });
  assert.deepEqual(stateOf(graph, "next.next.next"), { id: "next.next.next", parent: "next.next", kind: "group" });
  assert.deepEqual(stateOf(graph, "next.next.next.work"), { id: "next.next.next.work", parent: "next.next.next", kind: "operation" });
});

test("a Machine that uses no other reports its states as run() does and never reports a new graph", async (t) => {
  const input = { task: "work", outcome: "succeed" };
  const prepared = await prepareMachineRun({ ...isolated(t), machine: fixture("child"), input });
  const states: unknown[] = [];
  const graphs: RunGraph[] = [];
  await prepared.start({ onState: (state) => states.push(state), onGraph: (graph) => graphs.push(graph) } as StartWithGraph);
  assert.deepEqual(states, ["work", "success"]);
  assert.deepEqual(graphs, []);
});


test("parallel use states keep both child paths and remove each when it finishes", async (t) => {
  const location = isolated(t);
  const path = join(location.cwd, "parallel.machine.ts");
  const selector = JSON.stringify(fixture("human-child"));
  const rightChild = join(location.cwd, "right.machine.ts");
  writeFileSync(rightChild, `
    import { defineEndings } from ${JSON.stringify(resolve("src/index.ts"))};
    export const description = "Asks independently with its own ending.";
    export const endings = defineEndings({ accepted: { kind: "succeeded" } });
    export default (p) => p.machine({ initial: "ask", states: {
      ask: p.human("Approve?", { submitted: "accepted" }), accepted: p.final(endings.accepted),
    } });
  `);
  writeFileSync(path, `
    export const description = "Runs independent children in parallel.";
    export const uses = [${selector}, ${JSON.stringify(rightChild)}];
    export default (p) => {
      const branch = (selector, ending) => ({ initial: "delegate", states: {
        delegate: p.use(selector, { input: () => "", on: { [ending]: "done" } }),
        done: p.final(),
      } });
      return p.machine({ initial: "both", states: {
        both: { type: "parallel", states: { left: branch(${selector}, "approved"), right: branch(${JSON.stringify(rightChild)}, "accepted") }, onDone: "done" },
        done: p.final(),
      } });
    }
  `);
  const prepared = await prepareMachineRun({ ...location, machine: path });
  const states: unknown[] = [];
  const graphs: RunGraph[] = [];
  const replies: (() => void)[] = [];
  const running = prepared.start({
    onState: (state) => states.push(state), onGraph: (graph) => graphs.push(graph),
    human: () => new Promise<string>((resolve) => replies.push(() => resolve("approve"))),
  });
  // Let both child factories and Human invocations start without releasing either.
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(replies.length, 2);
  assert.deepEqual(states.at(-1), { both: { left: { delegate: "ask" }, right: { delegate: "ask" } } });
  replies[0]!();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(states.at(-1), { both: { left: "done", right: { delegate: "ask" } } });
  replies[1]!();
  assert.equal((await running).value, "done");
  assert.equal(states.at(-1), "done");
  for (const side of ["left", "right"]) {
    assert.deepEqual(stateOf(graphs.at(-1), `both.${side}.delegate.ask`), {
      id: `both.${side}.delegate.ask`, parent: `both.${side}.delegate`, kind: "human",
    });
  }
});

test("re-entering a use state reports each child's states without growing the graph twice", async (t) => {
  const location = isolated(t);
  const path = join(location.cwd, "repeat.machine.ts");
  const selector = JSON.stringify(fixture("human-child"));
  writeFileSync(path, `
    export const description = "Uses a child twice.";
    export const uses = [${selector}];
    export default (p) => {
      let count = 0;
      return p.machine({ initial: "delegate", states: {
        delegate: p.use(${selector}, { input: () => "", on: { approved: "again" } }),
        again: p.operation(() => ({ type: ++count < 2 ? "repeat" : "finish" }), { repeat: "delegate", finish: "done" }),
        done: p.final(),
      } });
    }
  `);
  const prepared = await prepareMachineRun({ ...location, machine: path });
  const states: unknown[] = [];
  const graphs: RunGraph[] = [];
  await prepared.start({
    human: () => "approve", onState: (state) => states.push(state), onGraph: (graph) => graphs.push(graph),
  });
  assert.deepEqual(states, [
    "delegate", { delegate: "ask" }, { delegate: "approved" }, "again",
    "delegate", { delegate: "ask" }, { delegate: "approved" }, "again", "done",
  ]);
  assert.equal(graphs.length, 1);
});
