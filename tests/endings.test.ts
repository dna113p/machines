import "./environment.ts";

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import * as machines from "../src/index.ts";
import { startMachineHost } from "../src/host.ts";
import { prepareMachineRun } from "../src/launcher.ts";
import { checkpointPath } from "../src/run-checkpoint.ts";

// Read from the namespace so that each case fails on its own until the exports exist.
const { defineEndings, final, Type } = machines;

const fixture = (name: string) => resolve(`tests/fixtures/endings/${name}.machine.ts`);

test("defineEndings returns each ending by name with its kind and output schema", () => {
  const output = Type.Object({ report: Type.String() });
  const endings = defineEndings({
    success: { kind: "succeeded", output },
    failure: { kind: "failed" },
    abandoned: { kind: "cancelled" },
  });
  assert.deepEqual(Object.keys(endings), ["success", "failure", "abandoned"]);
  assert.equal(endings.success.name, "success");
  assert.equal(endings.success.kind, "succeeded");
  assert.equal(endings.success.output, output);
  assert.equal(endings.failure.kind, "failed");
  assert.equal(endings.failure.output, undefined);
  assert.equal(endings.abandoned.kind, "cancelled");
});

test("defineEndings rejects an unknown kind, naming the ending", () => {
  assert.throws(
    () => defineEndings({ finished: { kind: "completed" as "succeeded" } }),
    (cause: unknown) => cause instanceof Error && cause.message.includes("finished"),
  );
});

test("defineEndings rejects a name that is not a trimmed, non-empty identifier, naming it", () => {
  for (const name of ["", " a", "a ", "a-b", "1a"]) {
    assert.throws(
      () => defineEndings({ [name]: { kind: "succeeded" } }),
      (cause: unknown) => cause instanceof Error && (name === "" || cause.message.includes(name.trim())),
      `the ending name ${JSON.stringify(name)} was accepted`,
    );
  }
});

test("defineEndings rejects an output that is not a schema object, naming the ending", () => {
  assert.throws(
    () => defineEndings({ reported: { kind: "succeeded", output: "string" as never } }),
    (cause: unknown) => cause instanceof Error && cause.message.includes("reported"),
  );
});

test("final(ending) marks the final state with its ending, and a bare final() is unchanged", () => {
  const endings = defineEndings({ success: { kind: "succeeded" } });
  assert.deepEqual(final(endings.success), { type: "final", meta: { "machines.ending": "success" } });
  assert.deepEqual(final(), { type: "final" });
});

test("final accepts an ending made by another copy of the package, and refuses one that is not an ending", () => {
  const copied = { name: "success", kind: "succeeded", [Symbol.for("machines.ending")]: true };
  assert.deepEqual(final(copied as never), { type: "final", meta: { "machines.ending": "success" } });
  assert.throws(() => final({ name: "success", kind: "succeeded" } as never));
});

test("Type is exported for ending output schemas", () => {
  assert.equal(typeof Type.Object, "function");
  assert.equal(typeof Type.String, "function");
});

test("a module whose top-level finals match its endings loads and finishes in each ending", async () => {
  for (const [input, state] of [["", "success"], ["fail", "failure"], ["cancel", "abandoned"]] as const) {
    const prepared = await prepareMachineRun({ machine: fixture("matching"), input });
    const snapshot = await prepared.start();
    assert.equal(snapshot.status, "done");
    assert.equal(snapshot.value, state);
    assert.deepEqual(snapshot.output, { report: `ended after ${input || "work"}` });
  }
});

test("a hosted run whose output fits its ending finishes as before", async () => {
  const host = await startMachineHost({ machine: fixture("matching"), input: "" });
  assert.deepEqual(await host.result, { state: "success", output: { report: "ended after work" } });
});

for (const [name, offender, what] of [
  ["undeclared-final", "stray", "a top-level final with no declared ending"],
  ["unused-ending", "spare", "a declared ending no final takes"],
  ["wrong-ending", "dropped", "a final that takes another state's ending"],
  ["nested-ending", "deep", "a nested final that takes an ending"],
  ["ending-without-export", "loose", "a final that takes an ending when the module exports none"],
] as const) {
  test(`${what} fails to load, naming "${offender}"`, async () => {
    await assert.rejects(
      prepareMachineRun({ machine: fixture(name) }),
      (cause: unknown) => {
        assert.ok(cause instanceof Error, String(cause));
        assert.match(cause.message, new RegExp(`\\b${offender}\\b`, "u"));
        return true;
      },
    );
  });
}

test("an output that breaks its ending's schema fails the run, naming the ending and the problem", async () => {
  const prepared = await prepareMachineRun({ machine: fixture("bad-output") });
  await assert.rejects(prepared.start(), (cause: unknown) => {
    assert.ok(cause instanceof Error, String(cause));
    assert.match(cause.message, /\breported\b/u);
    assert.match(cause.message, /\/report\b/u);
    return true;
  });
});

test("a hosted run whose output breaks its ending's schema fails, naming the ending", async () => {
  const host = await startMachineHost({ machine: fixture("bad-output") });
  await assert.rejects(host.result, /\breported\b/u);
});

test("a run that sleeps before an ending with an output schema is not checked, and keeps its checkpoint", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "machines-endings-sleep-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const prepared = await prepareMachineRun({ machine: fixture("sleeping"), cwd: directory, home: directory });
  let slept: string | undefined;
  const snapshot = await prepared.start({
    checkpoint: { directory, id: "resting", sleep: true },
    onSleep(due) { slept = due; },
  });
  assert.equal(typeof slept, "string");
  assert.notEqual(snapshot.status, "done");
  assert.ok(existsSync(checkpointPath(directory, "resting")), "the sleeping run lost its checkpoint");
});
