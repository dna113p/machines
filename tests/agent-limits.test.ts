import assert from "node:assert/strict";
import { test } from "node:test";

import { createLimitMemory, limitAwareRunner, type LimitPolicy } from "../src/agent-limits.ts";
import {
  AgentLimitError,
  agentLimitOf,
  type AgentLimit,
  type AgentRequest,
  type AgentRunner,
  type AgentUpdate,
  type Event,
} from "../src/index.ts";

const start = Date.UTC(2026, 9, 10, 20);
const minute = 60_000;
const hour = 60 * minute;
const request: AgentRequest = { prompt: "Implement the task", outcomes: ["completed", "blocked"], cwd: "/work" };
const handoff = /^Implement the task\n\nNote: a previous Agent working on this assignment was interrupted by a usage limit/u;

function clock() {
  let time = start;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => time,
    advance(milliseconds: number) { time += milliseconds; },
    async sleep(milliseconds: number) {
      sleeps.push(milliseconds);
      time += milliseconds;
    },
  };
}

function policy(time: ReturnType<typeof clock>, change: Partial<LimitPolicy> = {}): LimitPolicy {
  return { maxWaitMs: 6 * hour, probeMs: 15 * minute, now: time.now, sleep: time.sleep, ...change };
}

/** A runner that plays one step per call, then completes: a usage limit, another failure, or an event. */
function scripted(harness: string, ...steps: Array<Omit<AgentLimit, "harness"> | Error | Event>) {
  const requests: AgentRequest[] = [];
  const runner: AgentRunner = async (received, report) => {
    requests.push(received);
    report?.({ type: "identity", harness });
    const step = steps.shift() ?? { type: "completed" };
    if (step instanceof Error) throw step;
    if ("type" in step) return step as Event;
    throw new AgentLimitError(`${harness} is out of quota`, { harness, ...step });
  };
  return { runner, requests };
}

function observed() {
  const updates: AgentUpdate[] = [];
  return { updates, report: (update: AgentUpdate) => { updates.push(update); } };
}

const limits = (updates: readonly AgentUpdate[]) => updates.filter((update) => update.type === "limit");

test("a run under its limits calls the bound preset exactly as an unwrapped runner", async () => {
  const time = clock();
  const bound = scripted("claude", { type: "blocked", reason: "unclear" });
  const spare = scripted("codex");
  const { updates, report } = observed();
  const runner = limitAwareRunner("implementer", [
    { name: "implementer", runner: bound.runner }, { name: "spare", runner: spare.runner },
  ], createLimitMemory(), policy(time));

  assert.deepEqual(await runner(request, report), { type: "blocked", reason: "unclear" });
  assert.equal(bound.requests[0], request);
  assert.deepEqual(updates, [{ type: "identity", harness: "claude" }]);
  assert.deepEqual(spare.requests, []);
  assert.deepEqual(time.sleeps, []);
  assert.deepEqual(await runner(request), { type: "completed" });
});

test("a limited preset hands the same request to the next allowed preset and reports the swap", async () => {
  const time = clock();
  const bound = scripted("claude", { kind: "five_hour", resetsAt: start + hour });
  const spare = scripted("codex");
  const { updates, report } = observed();
  const runner = limitAwareRunner("implementer", [
    { name: "implementer", runner: bound.runner, harness: "claude" },
    { name: "implementer-sol", runner: spare.runner, harness: "codex" },
  ], createLimitMemory(), policy(time));

  assert.deepEqual(await runner(request, report), { type: "completed" });
  assert.deepEqual(updates, [
    { type: "identity", harness: "claude" },
    {
      type: "limit",
      status: "swapped",
      agent: "implementer",
      to: "implementer-sol",
      text: "implementer reached its usage limit (resets 2026-10-10T21:00:00Z); continuing with implementer-sol",
    },
    { type: "identity", harness: "codex" },
  ]);
  assert.equal(bound.requests[0], request);
  const [reissued] = spare.requests;
  assert.match(reissued!.prompt, handoff);
  assert.match(reissued!.prompt, /Inspect the current state and continue the same assignment rather than starting over\.$/u);
  assert.deepEqual({ ...reissued, prompt: request.prompt }, request);
  assert.deepEqual(time.sleeps, []);
});

test("roles of one run share what they learn, and a preset skipped from memory gets no handoff note", async () => {
  const time = clock();
  const claude = scripted("claude", { resetsAt: start + hour });
  const codex = scripted("codex");
  const candidates = [{ name: "claude", runner: claude.runner }, { name: "codex", runner: codex.runner }];
  const memory = createLimitMemory();
  const settings = policy(time);

  await limitAwareRunner("implementer", candidates, memory, settings)(request);
  assert.equal(claude.requests.length, 1);
  assert.match(codex.requests[0]!.prompt, handoff);

  const { updates, report } = observed();
  await limitAwareRunner("reviewer", candidates, memory, settings)(request, report);
  assert.equal(claude.requests.length, 1, "the second role does not spend a call on a preset known to be limited");
  assert.equal(codex.requests[1], request);
  assert.deepEqual(limits(updates), [{
    type: "limit",
    status: "swapped",
    agent: "claude",
    to: "codex",
    text: "claude (role reviewer) is at its usage limit (resets 2026-10-10T21:00:00Z); continuing with codex",
  }]);

  // A separate run has its own memory.
  await limitAwareRunner("reviewer", candidates, createLimitMemory(), settings)(request);
  assert.equal(claude.requests.length, 2);
});

test("a remembered limit expires at its reset, or after the probe interval when no reset is stated", async () => {
  const time = clock();
  const claude = scripted("claude", { resetsAt: start + hour });
  const codex = scripted("codex", {});
  const spare = scripted("spare");
  const runner = limitAwareRunner("worker", [
    { name: "claude", runner: claude.runner }, { name: "codex", runner: codex.runner }, { name: "spare", runner: spare.runner },
  ], createLimitMemory(), policy(time));

  await runner(request);
  assert.deepEqual([claude.requests.length, codex.requests.length, spare.requests.length], [1, 1, 1]);

  time.advance(15 * minute - 1);
  await runner(request);
  assert.deepEqual([claude.requests.length, codex.requests.length, spare.requests.length], [1, 1, 2]);

  time.advance(1);
  await runner(request);
  assert.deepEqual([claude.requests.length, codex.requests.length, spare.requests.length], [1, 2, 2]);

  time.advance(hour);
  await runner(request);
  assert.deepEqual([claude.requests.length, codex.requests.length, spare.requests.length], [2, 2, 2]);
  assert.equal(claude.requests[1], request);
});

test("a failure that is not a usage limit is rethrown as the same object and remembered as nothing", async () => {
  const time = clock();
  const failure = new Error("claude crashed");
  const wrapped = new Error("Turn failed", { cause: new Error("not a limit") });
  const bound = scripted("claude", failure, wrapped);
  const spare = scripted("codex");
  const { updates, report } = observed();
  const runner = limitAwareRunner("worker", [
    { name: "claude", runner: bound.runner }, { name: "codex", runner: spare.runner },
  ], createLimitMemory(), policy(time));

  await assert.rejects(async () => runner(request, report), (cause) => cause === failure);
  await assert.rejects(async () => runner(request, report), (cause) => cause === wrapped);
  const thrown = new Error("thrown before any promise");
  const synchronous = limitAwareRunner("worker", [{ name: "broken", runner: () => { throw thrown; } }], createLimitMemory(), policy(time));
  await assert.rejects(async () => synchronous(request), (cause) => cause === thrown);

  assert.deepEqual(await runner(request, report), { type: "completed" });
  assert.equal(bound.requests.length, 3);
  assert.deepEqual(spare.requests, []);
  assert.deepEqual(limits(updates), []);
});

test("with every preset limited the request waits for the earliest reset and resumes", async () => {
  const time = clock();
  const bound = scripted("claude", { kind: "five_hour", resetsAt: start + 30 * minute });
  const { updates, report } = observed();
  const runner = limitAwareRunner("implementer", [{ name: "implementer", runner: bound.runner }], createLimitMemory(), policy(time));

  assert.deepEqual(await runner(request, report), { type: "completed" });
  assert.deepEqual(limits(updates), [
    {
      type: "limit",
      status: "waiting",
      agent: "implementer",
      until: "2026-10-10T20:30:00Z",
      text: "implementer reached its usage limit; waiting for the reset at 2026-10-10T20:30:00Z",
    },
    {
      type: "limit",
      status: "resumed",
      agent: "implementer",
      text: "implementer waited for a usage limit to reset; continuing",
    },
  ]);
  // One minute past the reset, slept in ticks short enough to notice a suspended computer's clock.
  assert.equal(time.now(), start + 31 * minute);
  assert.equal(time.sleeps.length, 31);
  assert.ok(time.sleeps.every((milliseconds) => milliseconds === minute));
  assert.equal(bound.requests[0], request);
  assert.match(bound.requests[1]!.prompt, handoff);
});

test("a wait ends at the first preset to reset, which may be a fallback", async () => {
  const time = clock();
  const bound = scripted("claude", { resetsAt: start + 5 * hour });
  const spare = scripted("codex", { resetsAt: start + 2 * hour });
  const { updates, report } = observed();
  const runner = limitAwareRunner("worker", [
    { name: "claude", runner: bound.runner }, { name: "codex", runner: spare.runner },
  ], createLimitMemory(), policy(time));

  await runner(request, report);
  assert.deepEqual(limits(updates).map(({ status, agent, to, until, text }) => ({ status, agent, to, until, text })), [
    {
      status: "swapped", agent: "claude", to: "codex", until: undefined,
      text: "claude (role worker) reached its usage limit (resets 2026-10-11T01:00:00Z); continuing with codex",
    },
    {
      status: "waiting", agent: "claude", to: undefined, until: "2026-10-10T22:00:00Z",
      text: "claude (role worker) and its fallback (codex) reached their usage limits; waiting for the reset at 2026-10-10T22:00:00Z",
    },
    {
      status: "resumed", agent: "claude", to: "codex", until: undefined,
      text: "claude (role worker) waited for a usage limit to reset; continuing with codex",
    },
  ]);
  assert.equal(time.now(), start + 2 * hour + minute);
  assert.deepEqual([bound.requests.length, spare.requests.length], [1, 2]);
});

test("a limit with no stated reset is probed with the real request until it clears", async () => {
  const time = clock();
  const bound = scripted("codex", { kind: "usage" }, { kind: "usage" }, { kind: "usage" });
  const { updates, report } = observed();
  const runner = limitAwareRunner("codex", [{ name: "codex", runner: bound.runner }], createLimitMemory(), policy(time));

  assert.deepEqual(await runner(request, report), { type: "completed" });
  assert.equal(bound.requests.length, 4);
  assert.equal(time.now(), start + 45 * minute);
  assert.ok(time.sleeps.every((milliseconds) => milliseconds <= minute));
  const waiting = {
    type: "limit",
    status: "waiting",
    agent: "codex",
    until: "2026-10-11T02:00:00Z",
    text: "codex reached its usage limit; no reset is stated, retrying until 2026-10-11T02:00:00Z",
  };
  const resumed = { type: "limit", status: "resumed", agent: "codex", text: "codex waited for a usage limit to reset; continuing" };
  // The wait is reported once, however often the preset is probed, and ends when it answers.
  assert.deepEqual(limits(updates), [waiting, resumed]);
  assert.deepEqual(updates.at(-1), resumed);
  assert.match(bound.requests[3]!.prompt, handoff);
  assert.equal(bound.requests[3]!.prompt.match(/Note: a previous Agent/gu)?.length, 1);
});

test("a waiting Agent resumes at its first tool call, and a later wait in the same request is reported again", async () => {
  const time = clock();
  const requests: AgentRequest[] = [];
  const limit = (resetsAt: number) => new AgentLimitError("claude is out of quota", { harness: "claude", resetsAt });
  const bound: AgentRunner = async (received, report) => {
    requests.push(received);
    report?.({ type: "identity", harness: "claude" });
    report?.({ type: "output", text: "You have reached your usage limit\n" });
    if (requests.length === 1) throw limit(start + 10 * minute);
    report?.({ type: "tool", id: "tool-1", title: "Read", status: "in_progress" });
    report?.({ type: "tool", id: "tool-1", title: "Read", status: "completed" });
    // The first working turn runs into the limit again after it has done some work.
    if (requests.length === 2) throw limit(start + 30 * minute);
    return { type: "completed" };
  };
  const { updates, report } = observed();
  const runner = limitAwareRunner("claude", [{ name: "claude", runner: bound }], createLimitMemory(), policy(time));

  assert.deepEqual(await runner(request, report), { type: "completed" });
  assert.equal(requests.length, 3);
  assert.deepEqual(updates.map((update) => update.type === "limit" ? update.status : update.type), [
    "identity", "output", "waiting",
    "identity", "output", "resumed", "tool", "tool", "waiting",
    "identity", "output", "resumed", "tool", "tool",
  ]);
  assert.deepEqual(limits(updates).map((update) => update.until), [
    "2026-10-10T20:10:00Z", undefined, "2026-10-10T20:30:00Z", undefined,
  ]);
});

test("while a wait is reported, each probe that moves on to another preset reports its swap", async () => {
  const time = clock();
  const claude = scripted("claude", {}, {}, {});
  const codex = scripted("codex", {}, {});
  const { updates, report } = observed();
  const candidates = [{ name: "claude", runner: claude.runner }, { name: "codex", runner: codex.runner }];
  const memory = createLimitMemory();
  const runner = limitAwareRunner("worker", candidates, memory, policy(time));

  assert.deepEqual(await runner(request, report), { type: "completed" });
  assert.deepEqual([claude.requests.length, codex.requests.length], [3, 3]);
  // The wait itself is reported once; the probes at 15 and 30 minutes each swap from claude to codex.
  assert.deepEqual(limits(updates).map(({ status, agent, to }) => ({ status, agent, to })), [
    { status: "swapped", agent: "claude", to: "codex" },
    { status: "waiting", agent: "claude", to: undefined },
    { status: "swapped", agent: "claude", to: "codex" },
    { status: "swapped", agent: "claude", to: "codex" },
    { status: "resumed", agent: "claude", to: "codex" },
  ]);
  assert.deepEqual(updates.map((update) => update.type === "identity" ? update.harness : update.type === "limit" ? update.status : update.type), [
    "claude", "swapped", "codex", "waiting",
    "claude", "swapped", "codex",
    "claude", "swapped", "codex", "resumed",
  ]);
  assert.ok(limits(updates).filter((update) => update.status === "swapped").every((update) =>
    update.text === "claude (role worker) reached its usage limit (reset unknown); continuing with codex"));

  // A probed preset whose fallback is still known to be limited has nothing to swap to.
  const stated = clock();
  const probed = scripted("claude", {}, {});
  const held = scripted("codex", { resetsAt: start + 2 * hour });
  const alone = observed();
  await limitAwareRunner("worker", [
    { name: "claude", runner: probed.runner }, { name: "codex", runner: held.runner },
  ], createLimitMemory(), policy(stated))(request, alone.report);
  assert.deepEqual([probed.requests.length, held.requests.length], [3, 1]);
  assert.deepEqual(limits(alone.updates).map(({ status, to }) => ({ status, to })), [
    { status: "swapped", to: "codex" },
    { status: "waiting", to: undefined },
    { status: "resumed", to: undefined },
  ]);

  // Another role of the run arrived at both limits from memory: it ran on neither, so its wait ends without a swap.
  const later = scripted("codex");
  const second = observed();
  const waited = createLimitMemory();
  await assert.rejects(async () => limitAwareRunner("first", [
    { name: "claude", runner: scripted("claude", { resetsAt: start + 5 * hour }).runner },
    { name: "codex", runner: scripted("codex", { resetsAt: start + 2 * hour }).runner },
  ], waited, policy(time, { maxWaitMs: 0 }))(request));
  await limitAwareRunner("second", [
    { name: "claude", runner: scripted("claude").runner }, { name: "codex", runner: later.runner },
  ], waited, policy(time))(request, second.report);
  assert.deepEqual(limits(second.updates).map((update) => update.status), ["waiting", "resumed"]);
  assert.equal(later.requests[0], request, "a preset this request never ran on gets no handoff note");
});

test("a preset that answers an early probe is no longer remembered as limited by any role", async () => {
  const time = clock();
  const codex = scripted("codex", {}, {}, {});
  const candidates = [{ name: "codex", runner: codex.runner }];
  const memory = createLimitMemory();
  const settings = policy(time, { maxWaitMs: 40 * minute });

  // The last probe is at the deadline, five minutes before the limit would have been tried again.
  assert.deepEqual(await limitAwareRunner("implementer", candidates, memory, settings)(request), { type: "completed" });
  assert.equal(time.now(), start + 40 * minute);
  assert.equal(codex.requests.length, 4);
  assert.equal(memory.size, 0);

  const { updates, report } = observed();
  const slept = time.sleeps.length;
  assert.deepEqual(await limitAwareRunner("reviewer", candidates, memory, settings)(request, report), { type: "completed" });
  assert.equal(codex.requests[4], request);
  assert.deepEqual(limits(updates), []);
  assert.equal(time.sleeps.length, slept, "the second role does not wait for a limit that has cleared");
});

test("probing stops at the deadline fixed by the first wait", async () => {
  const time = clock();
  const steps = Array.from({ length: 10 }, () => ({ kind: "usage" }));
  const bound = scripted("codex", ...steps);
  const runner = limitAwareRunner("codex", [{ name: "codex", runner: bound.runner, harness: "codex" }], createLimitMemory(), policy(time, {
    maxWaitMs: 40 * minute,
  }));

  await assert.rejects(async () => runner(request), (cause) => {
    assert.ok(cause instanceof AgentLimitError);
    assert.equal(
      cause.message,
      'Agent role "codex" is at a usage limit on every allowed preset: codex (codex, usage, reset unknown); none is available within the 40-minute wait limit',
    );
    return true;
  });
  // Probes at 15 and 30 minutes, and a last one when the wait runs out.
  assert.equal(bound.requests.length, 4);
  assert.equal(time.now(), start + 40 * minute);
});

test("a reset beyond the wait limit fails at once, naming every preset and its limit", async () => {
  const time = clock();
  const bound = scripted("claude", { kind: "seven_day", resetsAt: start + 30 * hour });
  const spare = scripted("gpt", { kind: "five_hour", resetsAt: start + 7 * hour });
  const { updates, report } = observed();
  const runner = limitAwareRunner("implementer", [
    { name: "implementer", runner: bound.runner, harness: "claude" },
    { name: "implementer-sol", runner: spare.runner },
  ], createLimitMemory(), policy(time));

  await assert.rejects(async () => runner(request, report), (cause) => {
    assert.ok(cause instanceof AgentLimitError);
    assert.equal(cause.message, [
      'Agent role "implementer" is at a usage limit on every allowed preset:',
      "implementer (claude, seven_day, resets 2026-10-12T02:00:00Z);",
      "implementer-sol (gpt, five_hour, resets 2026-10-11T03:00:00Z);",
      "none is available within the 360-minute wait limit",
    ].join(" "));
    assert.deepEqual(cause.limits, [
      { harness: "claude", agent: "implementer", kind: "seven_day", resetsAt: start + 30 * hour },
      { harness: "gpt", agent: "implementer-sol", kind: "five_hour", resetsAt: start + 7 * hour },
    ]);
    assert.deepEqual(cause.limit, cause.limits?.[1], "the limit that resets first");
    assert.equal(agentLimitOf(new Error("Agent failed", { cause })), cause.limit);
    assert.equal(agentLimitOf(cause.cause)?.harness, "gpt");
    return true;
  });
  assert.deepEqual(time.sleeps, []);
  assert.deepEqual(limits(updates).map((update) => update.status), ["swapped"]);
});

test("a wait limit of zero never waits", async () => {
  const time = clock();
  const bound = scripted("claude", { resetsAt: start + minute });
  const spare = scripted("codex", {});
  const { updates, report } = observed();
  const runner = limitAwareRunner("worker", [
    { name: "claude", runner: bound.runner }, { name: "codex", runner: spare.runner },
  ], createLimitMemory(), policy(time, { maxWaitMs: 0 }));

  await assert.rejects(async () => runner(request, report), (cause) => {
    assert.ok(cause instanceof AgentLimitError);
    assert.equal(
      cause.message,
      'Agent role "worker" is at a usage limit on every allowed preset: claude (claude, resets 2026-10-10T20:01:00Z); codex (codex, reset unknown); waiting for a reset is off',
    );
    assert.deepEqual(cause.limit, { harness: "claude", agent: "claude", resetsAt: start + minute });
    assert.deepEqual(cause.limits?.map((limit) => limit.agent), ["claude", "codex"]);
    return true;
  });
  assert.deepEqual(time.sleeps, []);
  assert.deepEqual(limits(updates).map((update) => update.status), ["swapped"]);
});

test("a state announced in the tick its Agent starts hears of a remembered limit only afterwards", async () => {
  const time = clock();
  const memory = createLimitMemory();
  const settings = policy(time);
  const claude = scripted("claude", { resetsAt: start + hour });
  const candidates = [{ name: "claude", runner: claude.runner }];
  await assert.rejects(async () => limitAwareRunner("first", candidates, memory, { ...settings, maxWaitMs: 0 })(request));

  const order: string[] = [];
  const pending = limitAwareRunner("second", candidates, memory, settings)(request, (update) => {
    if (update.type === "limit") order.push(update.status);
  });
  order.push("state announced");
  await pending;
  assert.deepEqual(order, ["state announced", "waiting", "resumed"]);
});
