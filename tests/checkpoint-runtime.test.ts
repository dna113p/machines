import "./environment.ts";

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { agent, final, human, machine, operation, run } from "../src/index.ts";
import * as primitives from "../src/index.ts";
import type { MachinePrimitives } from "../src/index.ts";
import { jsonProblem } from "../src/json.ts";
import { prepareMachineRun } from "../src/launcher.ts";
import { checkpointPath, claimContinuation, type RunCheckpoint } from "../src/run-checkpoint.ts";
import { createRunStatusPublisher, readRunStatuses } from "../src/run-status.ts";

test("the public module supplies all factory primitives, including validated data", () => {
  const factoryPrimitives: MachinePrimitives = primitives;
  const initial = { count: 0 };
  assert.equal(factoryPrimitives.data(initial), initial);
  assert.throws(() => factoryPrimitives.data([]), /plain object/u);
  assert.throws(() => factoryPrimitives.data({ badKey: () => 1 }), /data.badKey/u);
});

for (const kind of ["operation", "agent", "human"] as const) {
  test(`continuation restarts a nested ${kind} without entry actions`, async () => {
    let calls = 0;
    let entries = 0;
    const step = kind === "operation" ? operation(() => { calls += 1; return { type: "done" }; }, { done: "finished" })
      : kind === "agent" ? agent("Again", { done: "finished" }) : human("Again?", { submitted: "finished" });
    const definition = machine({
      context: { count: 0 },
      initial: "unused",
      states: {
        unused: operation(() => { throw new Error("initial state ran again"); }, {}),
        group: { initial: "work", states: {
          work: { ...step, entry: () => { entries += 1; } },
          finished: final(),
        }, onDone: "finished" },
        finished: final(),
      },
    });
    let waiting = false;
    const snapshot = await run(definition, {
      continueAt: { value: { group: "work" }, context: { count: 7 } },
      agents: { default: () => { calls += 1; return { type: "done" }; } },
      human: () => { calls += 1; return "yes"; },
      onHumanInput: (active) => { if (active) waiting = true; },
    });
    assert.equal(calls, 1);
    assert.equal(entries, 0);
    assert.equal(snapshot.value, "finished");
    assert.deepEqual(snapshot.context, { count: 7 });
    assert.equal(waiting, kind === "human");
  });
}

test("entry checkpoints retain transient states and reject before starting an unsaveable step", async () => {
  const entries: unknown[] = [];
  const definition = machine({ initial: "first", states: {
    first: operation(() => ({ type: "done" }), { done: "bridge" }),
    bridge: { always: "work" },
    work: operation(() => ({ type: "done" }), { done: "finished" }),
    finished: final(),
  } });
  await run(definition, { onEnter: (entry) => { entries.push(entry.value); } });
  assert.deepEqual(entries, ["first", "bridge", "work", "finished"]);
  let called = false;
  const invalid = machine({ initial: "work", states: {
    work: operation(() => { called = true; return { type: "done" }; }, { done: "finished" }), finished: final(),
  } });
  await assert.rejects(run(invalid, { onEnter: () => { throw new Error("data.badKey is a function"); } }), /data.badKey/u);
  assert.equal(called, false);
});

test("continuation advances a transient plain state without external wildcard events", async () => {
  let entries = 0;
  const definition = machine({ initial: "unused", states: {
    unused: operation(() => { throw new Error("initial state reran"); }, {}),
    bridge: { entry: () => { entries += 1; }, always: "finished", on: { "*": "wrong" } },
    wrong: final(), finished: final(),
  } });
  const result = await run(definition, { continueAt: { value: "bridge", context: {} } });
  assert.equal(result.value, "finished");
  assert.equal(entries, 0);
});

test("JSON diagnostics name losses, class instances, sparse arrays, and cycles", () => {
  const cycle: { self?: unknown } = {};
  cycle.self = cycle;
  for (const value of [() => 1, [undefined], new (class Point { x = 1; })(), cycle, [Number.NaN], [BigInt(1)], Array(1), { [Symbol()]: 1 }]) {
    assert.match(jsonProblem({ badKey: value }, "data") ?? "", /data.badKey/u);
  }
  assert.equal(jsonProblem({ a: [1, null, "yes"], b: { ok: true } }), undefined);
});

test("saved data and context restore before a Human step reruns", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "checkpoint-runtime-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "saved.ts");
  writeFileSync(path, `export const description = "Checks saved data and context.";
export default (p, input) => {
  const data = p.data({ count: 0 });
  return p.machine({ context: { answer: 0 }, initial: "first", states: {
    first: p.operation(() => { data.count = 7; if (input.bad) data.badKey = () => 1; return { type: "done" }; }, {
      done: { target: "ask", actions: ({ context }) => { context.answer = 42; } }
    }),
    ask: p.human(() => { data.count += 1; return "Continue?"; }, { submitted: "second" }),
    second: p.operation(() => { if (data.count !== 8) throw new Error("wrong saved data " + data.count); return { type: "done" }; }, { done: "finished" }),
    finished: p.final()
  } });
};`);
  const options = { machine: path, cwd: directory, home: directory, input: { bad: false } };
  const prepared = await prepareMachineRun(options);
  await assert.rejects(prepared.start({ checkpoint: { directory, id: "saved" }, human: () => { throw new Error("interrupted"); } }), /interrupted/u);
  const saved = JSON.parse(readFileSync(checkpointPath(directory, "saved"), "utf8")) as RunCheckpoint;
  assert.equal(statSync(checkpointPath(directory, "saved")).mode & 0o777, 0o600);
  assert.deepEqual(saved.data, { count: 7 });
  assert.deepEqual(saved.context, { answer: 42 });
  await assert.rejects(prepareMachineRun({ ...options, continueRun: { ...saved, state: { ...saved.state, value: "renamed" } } }), /renamed/u);
  const resumed = await prepareMachineRun({ ...options, continueRun: saved });
  const result = await resumed.start({ checkpoint: { directory, id: "saved" }, human: () => "yes" });
  assert.deepEqual(result.context, { answer: 42 });
  assert.equal(result.value, "finished");
  assert.equal(existsSync(checkpointPath(directory, "saved")), false);
  const bad = await prepareMachineRun({ ...options, input: { bad: true } });
  await assert.rejects(bad.start({ checkpoint: { directory, id: "bad" }, human: () => { throw new Error("Human should not start"); } }), /data.badKey/u);
  assert.equal(existsSync(checkpointPath(directory, "bad")), false);
});

test("failed runs can be claimed even with a live host pid, claims are exclusive, and parallel continuation is refused", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "checkpoint-claim-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "machine.ts");
  writeFileSync(path, "source");
  const publisher = createRunStatusPublisher({ id: "failed", machine: "machine", path, cwd: directory }, { MACHINES_RUN_STATUS_DIR: directory });

  const saved = {
    schemaVersion: 1, id: "failed", machine: { name: "machine", path, sourceHash: "old" },
    input: "", agents: {}, cwd: directory, home: directory,
    state: { value: "work", path: "work", kind: "operation", enteredAt: new Date().toISOString() },
    data: {}, context: {}, writtenAt: new Date().toISOString(),
  };
  writeFileSync(checkpointPath(directory, "failed"), JSON.stringify(saved));
  assert.throws(() => claimContinuation("failed", directory), /still alive/u);
  assert.throws(() => claimContinuation("unknown", directory), /unknown.*no status record/u);
  publisher.finish({ error: "interrupted" });
  const first = claimContinuation("failed", directory);
  assert.equal(first.machineChanged, true);
  assert.throws(() => claimContinuation("failed", directory), /claimed/u);
  first.release();
  const staleClaim = join(directory, ".failed.claim");
  mkdirSync(staleClaim);
  writeFileSync(join(staleClaim, "2147483647.00000000-0000-0000-0000-000000000000"), "");
  const next = claimContinuation("failed", directory);
  first.release(); // An old owner cannot release a later claim.
  assert.throws(() => claimContinuation("failed", directory), /claimed/u);
  const resumed = createRunStatusPublisher({ id: "failed", machine: "machine", path, cwd: directory, continueRun: next }, { MACHINES_RUN_STATUS_DIR: directory });
  assert.equal(readRunStatuses(directory)[0]?.status, "running");
  assert.equal(readRunStatuses(directory)[0]?.error, undefined);
  resumed.finish({ error: "interrupted again" });
  next.release();
  saved.state.value = { left: "work", right: "work" } as unknown as string;
  writeFileSync(checkpointPath(directory, "failed"), JSON.stringify(saved));
  assert.throws(() => claimContinuation("failed", directory), /parallel/u);
});
