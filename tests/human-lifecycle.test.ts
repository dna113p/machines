import assert from "node:assert/strict";
import { test } from "node:test";

import { final, human, machine, run } from "../src/index.ts";

test("Human input starts before an initial Human runner acquires its input", async () => {
  const events: string[] = [];
  const workflow = machine({
    initial: "question",
    states: {
      question: human("Continue?", { submitted: "done" }),
      done: final(),
    },
  });

  const result = await run(workflow, {
    onHumanInput: (active) => events.push(active ? "input started" : "input finished"),
    human: () => {
      events.push("runner acquired input");
      return "continue";
    },
  });

  assert.equal(result.value, "done");
  assert.deepEqual(events, ["input started", "runner acquired input", "input finished"]);
});

test("a deferred Human runner still reports synchronous failures with state context", async () => {
  const events: string[] = [];
  const workflow = machine({
    initial: "question",
    states: {
      question: human("Continue?", { submitted: "done" }),
      done: final(),
    },
  });

  await assert.rejects(run(workflow, {
    onHumanInput: (active) => events.push(active ? "input started" : "input finished"),
    human: () => {
      events.push("runner acquired input");
      throw new Error("input unavailable");
    },
  }), /Human failed in state "question": input unavailable/u);

  assert.deepEqual(events.slice(0, 2), ["input started", "runner acquired input"]);
});
