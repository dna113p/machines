import assert from "node:assert/strict";
import { test } from "node:test";
import { agent, final, machine, run, AgentLimitError, type AgentRunner, type AgentUpdate } from "../src/index.ts";
import { createLimitMemory, limitAwareRunner } from "../src/agent-limits.ts";

for (const invalid of [undefined, null, {}, { type: 7 }, { type: "unknown" }]) {
  test(`an invalid reply ${JSON.stringify(invalid)} is asked again and then falls back`, async () => {
    const calls: string[] = [];
    const definition = machine({ initial: "work", states: {
      work: agent("Work", { completed: "done" }, { fallback: "spare" }), done: final(),
    } });
    const result = await run(definition, { agents: {
      default: (() => { calls.push("default"); return invalid; }) as AgentRunner,
      spare: () => { calls.push("spare"); return { type: "completed" }; },
    } });
    assert.equal(result.value, "done");
    assert.deepEqual(calls, ["default", "default", "spare"]);
  });
}

test("fallback names must be distinct, trimmed role names", () => {
  for (const fallback of ["default", "", " spare", "spare ", 1, null]) {
    assert.throws(() => agent("Work", { completed: "done" }, { fallback } as Parameters<typeof agent>[2]), /fallback/u);
  }
  assert.throws(() => agent("Work", { completed: "done" }, { using: "worker", fallback: "worker" }), /different role/u);
});

test("reask accepts only zero or one, including at untyped call sites", () => {
  for (const reask of [null, true, "1", 2, -1, 0.5, NaN, Infinity]) {
    assert.throws(() => agent("Work", { completed: "done" }, { reask } as Parameters<typeof agent>[2]), /reask/u);
  }
});

test("each entry gets its own recovery budget, even after a fallback answers", async () => {
  let entries = 0;
  const calls: string[] = [];
  const definition = machine({ initial: "work", states: {
    work: agent(() => `Entry ${++entries}`, {
      again: { target: "work", reenter: true }, completed: "done",
    }, { fallback: "spare" }), done: final(),
  } });
  const result = await run(definition, { agents: {
    default: ({ prompt }) => { calls.push(prompt.split("\n")[0]!); throw new Error("no event"); },
    spare: () => { calls.push("spare"); return { type: entries === 1 ? "again" : "completed" }; },
  } });
  assert.equal(result.value, "done");
  assert.deepEqual(calls, ["Entry 1", "Entry 1", "spare", "Entry 2", "Entry 2", "spare"]);
});

test("a fallback usage limit fails after its single attempt", async () => {
  const calls: string[] = [];
  const definition = machine({ initial: "work", states: {
    work: agent("Work", { completed: "done" }, { fallback: "spare" }), done: final(),
  } });
  await assert.rejects(run(definition, { agents: {
    default: () => { calls.push("default"); throw new AgentLimitError("primary limit", { harness: "primary" }); },
    spare: () => { calls.push("spare"); throw new AgentLimitError("spare limit", { harness: "spare" }); },
  } }), /^Error: Agent failed in state "work": spare limit$/u);
  assert.deepEqual(calls, ["default", "spare"]);
});

test("a usage limit from the re-ask still follows onLimit without asking the fallback", async () => {
  let calls = 0;
  const definition = machine({ initial: "work", states: {
    work: agent("Work", { completed: "done", limited: "limited" }, { fallback: "spare", onLimit: "limited" }),
    done: final(), limited: final(),
  } });
  const result = await run(definition, { agents: {
    default: () => {
      if (++calls === 1) throw new Error("crashed");
      throw new AgentLimitError("limit", { harness: "primary" });
    },
    spare: () => assert.fail("onLimit must win"),
  } });
  assert.equal(result.value, "limited");
  assert.equal(calls, 2);
});

test("preset swaps and waiting finish before a role fallback starts", async () => {
  const calls: string[] = [];
  const updates: AgentUpdate[] = [];
  let now = 0;
  const limited = (name: string): AgentRunner => () => {
    calls.push(name);
    throw new AgentLimitError("Out of quota", { harness: name });
  };
  const primary = limitAwareRunner("default", [
    { name: "firstPreset", runner: limited("firstPreset") },
    { name: "secondPreset", runner: limited("secondPreset") },
  ], createLimitMemory(), {
    maxWaitMs: 10, probeMs: 5, now: () => now,
    sleep: async (ms) => { calls.push(`wait ${ms}`); now += ms; },
  });
  const definition = machine({ initial: "work", states: {
    work: agent("Work", { completed: "done" }, { fallback: "spare" }), done: final(),
  } });
  const result = await run(definition, { agents: {
    default: primary,
    spare: () => { calls.push("spare"); return { type: "completed" }; },
  }, onAgentUpdate: (update) => updates.push(update) });
  assert.equal(result.value, "done");
  assert.deepEqual(calls, ["firstPreset", "secondPreset", "wait 5", "firstPreset", "secondPreset", "wait 5", "firstPreset", "secondPreset", "spare"]);
  assert.deepEqual(updates.filter((update) => update.type === "attempt").map((update) => update.role), ["spare"]);
});
