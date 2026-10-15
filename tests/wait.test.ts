import "./environment.ts";

import assert from "node:assert/strict";
import { test } from "node:test";

import { final, machine, operation, run, wait, type StateEntry } from "../src/index.ts";
import * as primitives from "../src/index.ts";
import type { MachinePrimitives } from "../src/index.ts";

/** What a wait's entry adds, read loosely so the test names only what the ticket asks. */
type WaitEntry = StateEntry & { readonly due?: string };

function restThenCheck(every: string | number, checks = 1) {
  let count = 0;
  const definition = machine({
    initial: "rest",
    states: {
      rest: wait({ every }, { due: "check" }),
      check: operation(() => {
        count += 1;
        return { type: count >= checks ? "enough" : "again" };
      }, { again: "rest", enough: "finished" }),
      finished: final(),
    },
  });
  return { definition, checks: () => count };
}

test("the public module supplies wait as a factory primitive", () => {
  const factoryPrimitives: MachinePrimitives = primitives;
  assert.equal(typeof factoryPrimitives.wait, "function");
});

test("without sleeping, a timed wait takes `due` in the same process, and its entry says when it is due", async () => {
  const { definition, checks } = restThenCheck("200ms", 2);
  const entries: WaitEntry[] = [];
  const started = Date.now();
  const snapshot = await run(definition, { onEnter: (entry) => { entries.push(entry); } });
  assert.equal(snapshot.value, "finished");
  assert.equal(checks(), 2);
  assert.ok(Date.now() - started >= 380, "the waits did not wait");

  const waits = entries.filter((entry) => entry.kind === "wait");
  assert.deepEqual(waits.map((entry) => entry.value), ["rest", "rest"]);
  const dues = waits.map((entry) => Date.parse(entry.due ?? ""));
  for (const [index, entry] of waits.entries()) {
    const due = dues[index] ?? Number.NaN;
    assert.ok(Number.isFinite(due), `due "${entry.due}" is not a time`);
    assert.ok(Math.abs(due - (Date.parse(entry.enteredAt) + 200)) < 50, `due ${entry.due} is not 200ms after ${entry.enteredAt}`);
  }
  assert.ok((dues[1] ?? 0) > (dues[0] ?? 0), "the repeated wait is not due later");
});

test("a continued wait waits only for the time left, and goes at once when that time has passed", async () => {
  const past = restThenCheck("1h");
  const started = Date.now();
  const late = await run(past.definition, {
    continueAt: { value: "rest", context: {}, due: new Date(started - 60_000).toISOString() },
  });
  assert.equal(late.value, "finished");
  assert.equal(past.checks(), 1);
  assert.ok(Date.now() - started < 1_000, "a wait that was already due did not go at once");

  const soon = restThenCheck("1h");
  const entries: WaitEntry[] = [];
  const due = new Date(Date.now() + 300).toISOString();
  const from = Date.now();
  const left = await run(soon.definition, {
    continueAt: { value: "rest", context: {}, due },
    onEnter: (entry) => { entries.push(entry); },
  });
  const took = Date.now() - from;
  assert.equal(left.value, "finished");
  assert.ok(took >= 250 && took < 5_000, `waited ${took}ms for a wait 300ms from due`);
  assert.equal(entries.find((entry) => entry.kind === "wait")?.due, due);
});

test("a timed wait needs a positive duration and a `due` transition", () => {
  for (const every of ["0", "5x", "", -1, 0, Number.NaN]) {
    assert.throws(() => wait({ every }, { due: "check" }), Error, `every: ${String(every)}`);
  }
  for (const every of [1, "10ms", "10s", "10m", "2h", "1d"]) {
    assert.doesNotThrow(() => wait({ every }, { due: "check" }), `every: ${String(every)}`);
  }
  assert.throws(() => wait({ every: "10m" }, {} as { due: string }));
});
