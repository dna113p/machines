import "./environment.ts";

import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";

import { prepareMachineRun } from "../src/launcher.ts";
import { checkpointPath, claimContinuation, type ChildCheckpoint, type RunCheckpoint } from "../src/run-checkpoint.ts";
import type { RunGraph } from "../src/run-graph.ts";
import { respondToRun } from "../src/run-inbox.ts";
import { createRunStatusPublisher, readRunStatuses } from "../src/run-status.ts";
import { approverSource, composerSource, napperSource, relaySource } from "./sleep-machines.ts";

function project(t: TestContext, source: string) {
  const directory = mkdtempSync(join(tmpdir(), "use-checkpoint-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const child = join(directory, "child.ts");
  const middle = join(directory, "middle.ts");
  const machine = join(directory, "parent.ts");
  const log = join(directory, "log");
  writeFileSync(join(directory, "package.json"), '{"type":"module"}');
  writeFileSync(child, source);
  writeFileSync(middle, relaySource("./child.ts", "rested", "restless"));
  writeFileSync(machine, composerSource("./middle.ts", "passed", "stopped"));
  const options = { cwd: directory, home: directory, machine, input: { log, every: "1h", outcome: "rested" } };
  const checkpoint = { directory, id: "nested", sleep: true };
  const read = () => JSON.parse(readFileSync(checkpointPath(directory, checkpoint.id), "utf8")) as RunCheckpoint;
  return { directory, child, middle, machine, log, options, checkpoint, read };
}

function deepest(level: ChildCheckpoint): ChildCheckpoint {
  return level.children ? deepest(level.children[0]) : level;
}

const dueNow = (saved: RunCheckpoint): RunCheckpoint => {
  const copy = structuredClone(saved);
  Object.assign(deepest(copy).state, { due: new Date(Date.now() - 1_000).toISOString() });
  return copy;
};

test("two child levels resume their saved wait and separate data through the public launcher", async (t) => {
  const p = project(t, napperSource);
  const prepared = await prepareMachineRun(p.options);
  await prepared.start({ checkpoint: p.checkpoint, onSleep() {} });
  const saved = p.read();
  assert.equal(saved.children?.[0].state.value, "inner");
  assert.equal(deepest(saved).state.value, "rest");
  const resumed = await prepareMachineRun({ ...p.options, continueRun: dueNow(saved) });
  assert.equal((await resumed.start({ checkpoint: p.checkpoint, onSleep() { assert.fail("the saved wait was already due"); } })).value, "finished");
  assert.deepEqual(readFileSync(p.log, "utf8").trim().split("\n"), [
    "parent start", "middle start", "child start",
    'child wake {"naps":1,"note":"child before"}',
    'middle after {"relays":1,"outcome":"passed"}',
    'parent after {"steps":["before"],"received":null}',
  ]);
  assert.equal(existsSync(checkpointPath(p.directory, p.checkpoint.id)), false);
});

test("two child levels restore a Human answer once and report a changed deepest source", async (t) => {
  const p = project(t, approverSource);
  writeFileSync(p.middle, relaySource("./child.ts", "approved", "denied"));
  const prepared = await prepareMachineRun(p.options);
  const publisher = createRunStatusPublisher({ id: p.checkpoint.id, machine: "parent", path: p.machine, cwd: p.directory }, { MACHINES_RUN_STATUS_DIR: p.directory });
  await prepared.start({
    checkpoint: p.checkpoint,
    onHumanSleep(request) { publisher.sleepForAnswer({ ...request, requestId: "child-question" }); },
    onHumanInput(active) { publisher.update(active ? { status: "waiting" } : { status: "running", human: undefined }); },
  });
  const record = readRunStatuses(p.directory)[0]!;
  assert.equal(record.status, "sleeping");
  assert.deepEqual(record.human?.choices, ["approve", "deny"]);
  assert.equal(await respondToRun({ directory: p.directory, runId: p.checkpoint.id, requestId: "child-question", response: "deny" }), "recorded");
  const unchanged = claimContinuation(p.checkpoint.id, p.directory);
  assert.equal(unchanged.machineChanged, false);
  unchanged.release();
  appendFileSync(p.child, "\n// Changed while asleep.\n");
  const changed = claimContinuation(p.checkpoint.id, p.directory);
  assert.equal(changed.machineChanged, true);
  changed.release();
  const resumed = await prepareMachineRun({ ...p.options, continueRun: changed.checkpoint });
  assert.equal((await resumed.start({ checkpoint: p.checkpoint, answer: changed.answer, human() { assert.fail("answer must reach the child"); } })).value, "stopped");
  assert.ok(readFileSync(p.log, "utf8").includes('child answer {"answer":"deny","note":"child before"}'));
});

const runtime = pathToFileURL(resolve("src/index.ts")).href;
const retrySource = `import { defineEndings } from ${JSON.stringify(runtime)};
export const description = "Retries before asking twice.";
export const endings = defineEndings({ rested: { kind: "succeeded" }, restless: { kind: "failed" } });
export default function(p, input) {
  const data = p.data({ attempts: 0, answers: [] });
  return p.machine({ initial: "work", context: { marker: input.outcome },
    output: ({ context }) => ({ ...data, context, input }),
    states: {
      work: p.operation(() => { data.attempts += 1; return { type: data.attempts < 2 ? "again" : "ready" }; },
        { again: "restless", ready: "ask" }, { retry: { on: "again", times: 1, wait: "1h" } }),
      ask: p.human("First?", { submitted: { target: "askAgain", actions: ({ event }) => data.answers.push(event.value) } }),
      askAgain: p.human("Second?", { submitted: { target: "rested", actions: ({ event }) => data.answers.push(event.value) } }),
      rested: p.final(endings.rested), restless: p.final(endings.restless),
    },
  });
}`;

test("a nested retry restores its attempt, input and context, then can sleep at successive Human requests", async (t) => {
  const p = project(t, retrySource);
  const prepared = await prepareMachineRun(p.options);
  await prepared.start({ checkpoint: p.checkpoint, onSleep() {} });
  const saved = p.read();
  assert.deepEqual(deepest(saved).state.retry, { attempt: 2, of: 2 });
  assert.deepEqual(deepest(saved).data, { attempts: 1, answers: [] });
  // The saved input/context must win over the regenerated use input and factory context.
  Object.assign(deepest(saved), { input: { outcome: "saved input" }, context: { marker: "saved context" } });
  const retry = await prepareMachineRun({ ...p.options, continueRun: dueNow(saved) });
  await retry.start({ checkpoint: p.checkpoint, onHumanSleep(request) { assert.equal(request.prompt, "First?"); } });
  assert.equal(deepest(p.read()).state.value, "ask");
  assert.deepEqual(deepest(p.read()).data, { attempts: 2, answers: [] });
  const first = await prepareMachineRun({ ...p.options, continueRun: p.read() });
  await first.start({ checkpoint: p.checkpoint, answer: "one", onHumanSleep(request) { assert.equal(request.prompt, "Second?"); } });
  assert.equal(deepest(p.read()).state.value, "askAgain");
  assert.deepEqual(deepest(p.read()).data, { attempts: 2, answers: ["one"] });
  assert.deepEqual(deepest(p.read()).input, { outcome: "saved input" });
  assert.deepEqual(deepest(p.read()).context, { marker: "saved context" });
  const second = await prepareMachineRun({ ...p.options, continueRun: p.read() });
  assert.equal((await second.start({ checkpoint: p.checkpoint, answer: "two", human() { assert.fail("unexpected prompt"); } })).value, "finished");
});

test("invalid nested checkpoints are refused before continuation and release their claim", async (t) => {
  const p = project(t, napperSource);
  const prepared = await prepareMachineRun(p.options);
  await prepared.start({ checkpoint: p.checkpoint, onSleep() {} });
  const saved = p.read();
  const publisher = createRunStatusPublisher({ id: p.checkpoint.id, machine: "parent", path: p.machine, cwd: p.directory }, { MACHINES_RUN_STATUS_DIR: p.directory });
  publisher.finish({ error: "interrupted" });
  const child = saved.children![0];
  for (const malformed of [
    { ...saved, schemaVersion: 1 },
    { ...saved, children: [] },
    { ...saved, children: [child, child] },
    { ...saved, state: { ...saved.state, kind: "human" } },
    { ...saved, children: [{ ...child, state: { ...child.state, kind: "final" } }] },
    { ...saved, children: [{ ...child, children: [null] }] },
    { ...saved, children: [{ ...child, children: [{ ...deepest(child), state: { ...deepest(child).state, due: "invalid" } }] }] },
  ]) {
    writeFileSync(checkpointPath(p.directory, p.checkpoint.id), JSON.stringify(malformed));
    assert.throws(() => claimContinuation(p.checkpoint.id, p.directory), /invalid checkpoint/u);
    assert.equal(existsSync(join(p.directory, `.${p.checkpoint.id}.claim`)), false);
  }
});

test("preparation refuses a saved child whose parent use or child state no longer matches", async (t) => {
  const p = project(t, napperSource);
  const prepared = await prepareMachineRun(p.options);
  await prepared.start({ checkpoint: p.checkpoint, onSleep() {} });
  const saved = p.read();
  const wrongPath = structuredClone(saved);
  Object.assign(deepest(wrongPath).machine, { path: p.machine });
  await assert.rejects(prepareMachineRun({ ...p.options, continueRun: wrongPath }), /no longer matches/u);
  const missingState = structuredClone(saved);
  Object.assign(deepest(missingState).state, { value: "missing" });
  await assert.rejects(prepareMachineRun({ ...p.options, continueRun: missingState }), /saved state "missing" is missing/u);
  const notUse = { ...saved, state: { ...saved.state, value: "finished" } };
  await assert.rejects(prepareMachineRun({ ...p.options, continueRun: notUse }), /no longer matches/u);
});

test("an unserializable child context invalidates the whole checkpoint before sleeping", async (t) => {
  const p = project(t, napperSource.replace("return p.machine({", "return p.machine({ context: { invalid: 1n },"));
  const prepared = await prepareMachineRun(p.options);
  await assert.rejects(prepared.start({ checkpoint: p.checkpoint, onSleep() { assert.fail("cannot sleep without a checkpoint"); } }), /Cannot sleep without a saved checkpoint/u);
  assert.equal(existsSync(checkpointPath(p.directory, p.checkpoint.id)), false);
});

test("nested state and graph observations survive sleeping and continuation without entering the checkpoint state", async (t) => {
  const p = project(t, approverSource);
  writeFileSync(p.middle, relaySource("./child.ts", "approved", "denied"));
  const states: unknown[] = [];
  const graphs: RunGraph[] = [];
  const observers = {
    onState(state: unknown) { states.push(state); },
    onGraph(graph: RunGraph) { graphs.push(graph); },
  };
  const prepared = await prepareMachineRun(p.options);
  await prepared.start({ ...observers, checkpoint: p.checkpoint, onHumanSleep() {} });
  assert.deepEqual(states.at(-1), { delegate: { inner: "ask" } });
  const saved = p.read();
  assert.equal(saved.state.value, "delegate");
  assert.equal(saved.children?.[0].state.value, "inner");
  assert.equal(deepest(saved).state.value, "ask");
  assert.ok(graphs.at(-1)?.states.some((state) => state.id === "delegate.inner.ask" && state.kind === "human"));

  states.length = 0;
  graphs.length = 0;
  const resumed = await prepareMachineRun({ ...p.options, continueRun: saved });
  const snapshot = await resumed.start({ ...observers, checkpoint: p.checkpoint, answer: "approve",
    human() { assert.fail("the saved answer must reach the child"); } });
  assert.equal(snapshot.value, "finished");
  assert.ok(states.some((state) => JSON.stringify(state) === JSON.stringify({ delegate: { inner: "ask" } })));
  assert.equal(states.at(-1), "finished");
  assert.ok(graphs.at(-1)?.states.some((state) => state.id === "delegate.inner.ask" && state.kind === "human"));
  assert.equal(existsSync(checkpointPath(p.directory, p.checkpoint.id)), false);
});
