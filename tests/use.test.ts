import "./environment.ts";

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, type TestContext } from "node:test";

import type { AnyStateMachine } from "xstate";

import * as machines from "../src/index.ts";
import { prepareMachineRun } from "../src/launcher.ts";

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

const notSupported = (cause: unknown) => {
  assert.ok(cause instanceof Error, String(cause));
  assert.match(cause.message, /sleep/iu);
  assert.match(cause.message, /not supported/iu);
  return true;
};

test("a sleeping run reaching a child's timed wait fails with the not-supported error", async (t) => {
  const location = isolated(t);
  const prepared = await prepareMachineRun({ ...location, machine: fixture("uses-wait") });
  let slept: string | undefined;
  await assert.rejects(prepared.start({
    checkpoint: { directory: location.cwd, id: "resting", sleep: true },
    onSleep(due) { slept = due; },
  }), notSupported);
  assert.equal(slept, undefined, "the run slept inside its child");
});

test("a sleeping run reaching a child's Human request fails with the not-supported error", async (t) => {
  const location = isolated(t);
  const prepared = await prepareMachineRun({ ...location, machine: fixture("uses-human") });
  let asked = false;
  await assert.rejects(prepared.start({
    checkpoint: { directory: location.cwd, id: "asking", sleep: true },
    onHumanSleep() { asked = true; },
  }), notSupported);
  assert.equal(asked, false, "the run slept at its child's Human request");
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
