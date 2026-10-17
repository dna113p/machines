import "./environment.ts";

import assert from "node:assert/strict";
import { test } from "node:test";
import { createMachine } from "xstate";

import { final, machine, machineGraph, operation, run, type Event, type RunOptions, type StateEntry } from "../src/index.ts";

/** An Operation's retry option, read loosely so the test names only what the ticket asks. */
interface Retry {
  readonly on: string;
  readonly times: number;
  readonly wait: string | number;
}

/** `operation()` with the ticket's third argument. */
const retrying = operation as unknown as <const TTransitions extends Readonly<Record<string, unknown>>>(
  runOperation: () => Event | Promise<Event>,
  on: TTransitions,
  options: { readonly retry: Retry },
) => ReturnType<typeof operation<TTransitions>>;

/** What a retry's entry adds, read loosely in the same way. */
type RetryEntry = StateEntry & { readonly retry?: { readonly attempt: number; readonly of: number } };

/** Run options with a continuation that carries the attempt it stopped at. */
type RetryRunOptions = Omit<RunOptions, "continueAt"> & {
  readonly continueAt?: NonNullable<RunOptions["continueAt"]> & { readonly retry?: { readonly attempt: number; readonly of: number } };
};

const runRetrying = run as unknown as (definition: Parameters<typeof run>[0], options: RetryRunOptions) => ReturnType<typeof run>;

/** A push that returns each of `results` in turn, then `pushed`. Only `failed` is worth retrying. */
function pusher(results: readonly string[], retry: Partial<Retry> = {}) {
  let calls = 0;
  const definition = machine({
    initial: "push",
    states: {
      push: retrying(() => {
        const type = results[calls] ?? "pushed";
        calls += 1;
        return { type };
      }, { pushed: "awaitMerge", failed: "askPush" }, { retry: { on: "failed", times: 3, wait: "1ms", ...retry } }),
      awaitMerge: final(),
      askPush: final(),
    },
  });
  return { definition, calls: () => calls };
}

test("an Operation that fails twice then pushes, with three further attempts, reaches pushed's target after three calls", async () => {
  const { definition, calls } = pusher(["failed", "failed", "pushed"]);
  const snapshot = await run(definition);
  assert.equal(snapshot.value, "awaitMerge");
  assert.equal(calls(), 3);
});

test("with one further attempt, the same Operation reaches failed's target after two calls", async () => {
  const { definition, calls } = pusher(["failed", "failed", "pushed"], { times: 1 });
  const snapshot = await run(definition);
  assert.equal(snapshot.value, "askPush");
  assert.equal(calls(), 2);
});

test("an event other than retry.on is handled at once, and attempts used up hand on the last event", async () => {
  const pushed = pusher(["pushed"]);
  assert.equal((await run(pushed.definition)).value, "awaitMerge");
  assert.equal(pushed.calls(), 1);

  const failing = pusher(["failed", "failed", "failed", "failed", "failed", "failed"]);
  assert.equal((await run(failing.definition)).value, "askPush");
  assert.equal(failing.calls(), 4, "three further attempts are four calls in all");
});

test("an Operation that throws is called once and fails the run as it does without retry", async () => {
  let calls = 0;
  const definition = machine({
    initial: "push",
    states: {
      push: retrying(() => {
        calls += 1;
        throw new Error("network is down");
      }, { pushed: "awaitMerge", failed: "askPush" }, { retry: { on: "failed", times: 3, wait: "1ms" } }),
      awaitMerge: final(),
      askPush: final(),
    },
  });
  await assert.rejects(run(definition), /Operation failed in state "push": network is down/u);
  assert.equal(calls, 1);
});

test("a throw on a later attempt fails the run without another attempt", async () => {
  let calls = 0;
  const definition = machine({
    initial: "push",
    states: {
      push: retrying(() => {
        calls += 1;
        if (calls === 1) return { type: "failed" };
        throw new Error("index.lock is held");
      }, { pushed: "awaitMerge", failed: "askPush" }, { retry: { on: "failed", times: 3, wait: "1ms" } }),
      awaitMerge: final(),
      askPush: final(),
    },
  });
  await assert.rejects(run(definition), /Operation failed in state "push": index\.lock is held/u);
  assert.equal(calls, 2);
});

test("the run waits between attempts, and each wait's entry carries the attempt and when it is due", async () => {
  const { definition, calls } = pusher(["failed", "failed", "pushed"], { wait: "150ms" });
  const entries: RetryEntry[] = [];
  const started = Date.now();
  const snapshot = await run(definition, { onEnter: (entry) => { entries.push(entry); } });
  assert.equal(snapshot.value, "awaitMerge");
  assert.equal(calls(), 3);
  assert.ok(Date.now() - started >= 280, "the attempts did not wait between them");

  const waits = entries.filter((entry) => entry.retry !== undefined);
  assert.deepEqual(waits.map((entry) => ({ value: entry.value, kind: entry.kind, retry: entry.retry })), [
    { value: "push", kind: "operation", retry: { attempt: 2, of: 4 } },
    { value: "push", kind: "operation", retry: { attempt: 3, of: 4 } },
  ]);
  for (const entry of waits) {
    const due = Date.parse(entry.due ?? "");
    assert.ok(Number.isFinite(due), `due "${entry.due}" is not a time`);
    assert.ok(Math.abs(due - (Date.parse(entry.enteredAt) + 150)) < 50, `due ${entry.due} is not 150ms after ${entry.enteredAt}`);
  }
  // The first entry is the state's own, before any attempt failed.
  assert.equal(entries[0]?.value, "push");
  assert.equal(entries[0]?.retry, undefined);
});

test("a run continued from a retry wait resumes the count where it was, not at attempt 1", async () => {
  const { definition, calls } = pusher(Array.from({ length: 10 }, () => "failed"), { wait: "1h" });
  const entries: RetryEntry[] = [];
  const due = new Date(Date.now() - 60_000).toISOString();
  const started = Date.now();
  const snapshot = await runRetrying(definition, {
    continueAt: { value: "push", context: {}, due, retry: { attempt: 3, of: 4 } },
    onEnter: (entry) => { entries.push(entry); },
    // The wait before attempt 4 is an hour: sleep instead of waiting it out.
    onSleep: () => {},
  });
  assert.ok(Date.now() - started < 5_000, "the run waited out a retry wait that was already due");
  // Attempt 3 is made at once; the run then sleeps before attempt 4, the last.
  assert.equal(snapshot.value, "push");
  assert.equal(calls(), 1);
  // The continued entry keeps the attempt and due time, so a checkpoint written from it does too.
  assert.deepEqual({ retry: entries[0]?.retry, due: entries[0]?.due }, { retry: { attempt: 3, of: 4 }, due });
  assert.deepEqual(entries.at(-1)?.retry, { attempt: 4, of: 4 });

  const last = pusher(Array.from({ length: 10 }, () => "failed"));
  const finished = await runRetrying(last.definition, {
    continueAt: { value: "push", context: {}, due, retry: { attempt: 3, of: 4 } },
  });
  assert.equal(finished.value, "askPush");
  assert.equal(last.calls(), 2, "attempts 3 and 4 are the only ones left");
});

test("a continued retry wait waits only for the time left", async () => {
  const { definition, calls } = pusher([], { wait: "1h" });
  const due = new Date(Date.now() + 300).toISOString();
  const started = Date.now();
  const snapshot = await runRetrying(definition, {
    continueAt: { value: "push", context: {}, due, retry: { attempt: 2, of: 4 } },
  });
  const took = Date.now() - started;
  assert.equal(snapshot.value, "awaitMerge");
  assert.equal(calls(), 1, "the continued run called the Operation before its retry was due, or more than once");
  assert.ok(took >= 250 && took < 5_000, `waited ${took}ms for a retry 300ms from due`);
});

test("with sleep, a run stops at its first retry wait after one call", async () => {
  const { definition, calls } = pusher(["failed"], { wait: "1h" });
  const slept: string[] = [];
  const entries: RetryEntry[] = [];
  const snapshot = await run(definition, {
    onEnter: (entry) => { entries.push(entry); },
    onSleep: (due) => { slept.push(due); },
  });
  assert.equal(snapshot.value, "push");
  assert.equal(calls(), 1);
  const last = entries.at(-1);
  assert.deepEqual(last?.retry, { attempt: 2, of: 4 });
  assert.deepEqual(slept, [last?.due]);
});

test("the graph draws a retrying Operation's retry as a loop on its state, and no loop without retry", () => {
  const { definition } = pusher([]);
  const graph = machineGraph(definition);
  assert.ok(graph, "no graph");
  assert.ok(
    graph.edges.some((edge) => edge.from === "push" && edge.to === "push" && edge.event === "retry"),
    `no retry loop on push: ${JSON.stringify(graph.edges)}`,
  );
  assert.equal(graph.states.find((state) => state.id === "push")?.kind, "operation");

  const plain = machineGraph(machine({
    initial: "push",
    states: {
      push: operation(() => ({ type: "pushed" }), { pushed: "done", failed: "done" }),
      done: final(),
    },
  }));
  assert.ok(plain);
  assert.equal(plain.edges.some((edge) => edge.event === "retry"), false);
});

test("an Operation without retry is unchanged: called once, and no entry carries a retry", async () => {
  let calls = 0;
  const entries: RetryEntry[] = [];
  const definition = machine({
    initial: "push",
    states: {
      push: operation(() => {
        calls += 1;
        return { type: "failed" };
      }, { pushed: "awaitMerge", failed: "askPush" }),
      awaitMerge: final(),
      askPush: final(),
    },
  });
  assert.equal((await run(definition, { onEnter: (entry) => { entries.push(entry); } })).value, "askPush");
  assert.equal(calls, 1);
  assert.equal(entries.some((entry) => entry.retry !== undefined), false);
});

/** A definition whose `pushBranch` state retries with `retry`, nested in `group` when asked. */
function defineWith(retry: Retry, nested = false) {
  const state = retrying(() => ({ type: "pushed" }), { pushed: "#done", failed: "#done" }, { retry });
  const done = { id: "done", ...final() };
  return () => machine(nested
    ? { initial: "group", states: { group: { initial: "pushBranch", states: { pushBranch: state } }, done } }
    : { initial: "pushBranch", states: { pushBranch: state, done } });
}

/** The definition fails with an error that names the state. */
function assertNamesState(define: () => unknown, what: string, state = "pushBranch"): void {
  assert.throws(define, (cause: unknown) => {
    assert.ok(cause instanceof Error, `${what}: not an Error`);
    assert.ok(cause.message.includes(state), `${what}: "${cause.message}" does not name state ${state}`);
    assert.match(cause.message, /retry/u, `${what}: "${cause.message}" does not say it is the retry option`);
    return true;
  }, what);
}

test("retry.on naming an event the state does not handle fails at definition time, naming the state", () => {
  assertNamesState(defineWith({ on: "timedOut", times: 3, wait: "1m" }), "unknown event");
  assertNamesState(defineWith({ on: "", times: 3, wait: "1m" }), "empty event");
  assertNamesState(defineWith({ on: "timedOut", times: 3, wait: "1m" }, true), "unknown event in a nested state");
});

test("retry.times outside 1 to 10 fails at definition time, naming the state", () => {
  for (const times of [0, 11, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assertNamesState(defineWith({ on: "failed", times, wait: "1m" }), `times: ${times}`);
  }
  assertNamesState(defineWith({ on: "failed", times: 0, wait: "1m" }, true), "times: 0 in a nested state");
  for (const times of [1, 10]) {
    assert.doesNotThrow(defineWith({ on: "failed", times, wait: "1m" }), `times: ${times}`);
  }
});

test("a bad retry.wait fails at definition time, naming the state", () => {
  for (const wait of ["5x", "", "0", "1 m", 0, -1, Number.NaN]) {
    assertNamesState(defineWith({ on: "failed", times: 3, wait }), `wait: ${String(wait)}`);
  }
  assertNamesState(defineWith({ on: "failed", times: 3, wait: "5x" }, true), "wait: 5x in a nested state");
  for (const wait of [1, "1ms", "10s", "1m", "2h", "1d"]) {
    assert.doesNotThrow(defineWith({ on: "failed", times: 3, wait }), `wait: ${String(wait)}`);
  }
});


test("run validates retry options on a plain XState definition before invoking work", async () => {
  let calls = 0;
  const definition = createMachine({
    initial: "push",
    states: {
      push: operation(() => { calls += 1; return { type: "failed" }; }, { failed: "done" },
        { retry: { on: "failed", times: 0, wait: "1ms" } }),
      done: final(),
    },
  });
  await assert.rejects(run(definition), /State "push" retry.times/u);
  assert.equal(calls, 0);
});

test("a changed retry budget caps the continued attempt without resetting it", async () => {
  const { definition, calls } = pusher(["failed"], { times: 1 });
  const entries: StateEntry[] = [];
  assert.equal((await run(definition, {
    continueAt: { value: "push", context: {}, due: new Date(0).toISOString(), retry: { attempt: 3, of: 4 } },
    onEnter: (entry) => { entries.push(entry); },
  })).value, "askPush");
  assert.equal(calls(), 1);
  assert.deepEqual(entries[0]?.retry, { attempt: 2, of: 2 });
});
