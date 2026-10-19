import "./environment.ts";

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";

import { prepareMachineRun } from "../src/launcher.ts";

const runtime = JSON.stringify(pathToFileURL(resolve("src/index.ts")).href);
const header = `import { defineEndings, Type } from ${runtime};
export const description = "Composition validation fixture";
`;
const leaf = `${header}
export const endings = defineEndings({ done: { kind: "succeeded" } });
export default p => p.machine({ initial: "done", states: { done: p.final(endings.done) } });`;

function workspace(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "machines-use-validation-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, "package.json"), '{"type":"module"}');
  const write = (name: string, source: string) => {
    const path = join(directory, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, source);
    return path;
  };
  return { directory, write, location: { cwd: directory, home: directory } };
}

function parent(selector: string, input = '""', on = '{ done: "done" }') {
  return `${header}
export const uses = [${JSON.stringify(selector)}];
export default p => p.machine({ initial: "delegate", states: {
  delegate: p.use(${JSON.stringify(selector)}, { input: () => ${input}, on: ${on} }),
  done: p.final(),
} });`;
}

test("child factories build at each entry with independent working data", async (t) => {
  const { write, location } = workspace(t);
  write("child.ts", `${header}
export const endings = defineEndings({ done: { kind: "succeeded" } });
export default (p, input) => {
  if (input !== "ready") throw new Error("child built before entry");
  const saved = p.data({ calls: 0 });
  return p.machine({ initial: "work", output: () => saved.calls, states: {
    work: p.operation(() => { saved.calls++; return { type: "done" }; }, { done: "done" }),
    done: p.final(endings.done),
  } });
}`);
  const machine = write("parent.ts", `${header}
export const uses = ["./child.ts"];
export default p => {
  const saved = p.data({ input: "not ready", results: [] });
  const receive = ({ event }) => saved.results.push(event.output);
  return p.machine({ initial: "prepare", output: () => saved.results, states: {
    prepare: p.operation(() => { saved.input = "ready"; return { type: "done" }; }, { done: "first" }),
    first: p.use("./child.ts", { input: () => saved.input, on: { done: { target: "second", actions: receive } } }),
    second: p.use("./child.ts", { input: () => saved.input, on: { done: { target: "done", actions: receive } } }),
    done: p.final(),
  } });
}`);
  const prepared = await prepareMachineRun({ ...location, machine });
  assert.deepEqual((await prepared.start()).output, [1, 1]);
});

test("use checks include nested states at prepare and child states at entry", async (t) => {
  const { write, location } = workspace(t);
  write("leaf.ts", leaf);
  const nested = `${header}
export const uses = ["./leaf.ts"];
export const endings = defineEndings({ done: { kind: "succeeded" } });
export default p => p.machine({ initial: "group", states: {
  group: { initial: "delegate", states: {
    delegate: p.use("./leaf.ts", { input: () => "", on: { unexpected: "#done" } }),
  } },
  done: { ...p.final(endings.done), id: "done" },
} });`;
  const machine = write("nested.ts", nested);
  await assert.rejects(prepareMachineRun({ ...location, machine }), /group\.delegate.*leaf.*missing: done.*extra: unexpected/u);
  const prepared = await prepareMachineRun({ ...location, machine: write("parent.ts", parent("./nested.ts")) });
  await assert.rejects(prepared.start(), /group\.delegate.*leaf.*missing: done.*extra: unexpected/u);
});

test("uses metadata rejects malformed and duplicate selectors at prepare", async (t) => {
  const { write, location } = workspace(t);
  for (const [i, uses] of [null, "child", [""], [" child"], [3], ["child", "child"]].entries()) {
    const machine = write(`invalid-${i}.ts`, `${leaf}\nexport const uses = ${JSON.stringify(uses)};`);
    await assert.rejects(prepareMachineRun({ ...location, machine }), /uses must/u);
  }
});

test("catalogue selectors prefer the project and path cycles resolve symlinks", async (t) => {
  const { write, location, directory } = workspace(t);
  write("home/.machines/child.ts", `${header}throw new Error("global child selected");`);
  write("project/.machines/child.ts", leaf);
  const machine = write("parent.ts", parent("child"));
  const prepared = await prepareMachineRun({ machine, cwd: join(directory, "project"), home: join(directory, "home") });
  assert.equal((await prepared.start()).value, "done");
  const cycle = write("cycle.ts", parent("./alias.ts"));
  symlinkSync(cycle, join(directory, "alias.ts"));
  await assert.rejects(prepareMachineRun({ ...location, machine: cycle }), /delegate.*alias.*cycle/u);
});

test("invalid child input and ending output fail the parent's use state", async (t) => {
  const { write, location } = workspace(t);
  write("leaf.ts", leaf);
  let prepared = await prepareMachineRun({ ...location, machine: write("input.ts", parent("./leaf.ts", "undefined")) });
  await assert.rejects(prepared.start(), /delegate.*input must be a JSON-serializable value/u);
  write("bad-output.ts", `${header}
export const endings = defineEndings({ done: { kind: "succeeded", output: Type.String() } });
export default p => p.machine({ initial: "done", output: () => 42, states: { done: p.final(endings.done) } });`);
  prepared = await prepareMachineRun({ ...location, machine: write("output.ts", parent("./bad-output.ts")) });
  await assert.rejects(prepared.start(), /delegate.*output does not match ending "done"/u);
});

test("sleep mode refuses child retry waits without calling the parent's hooks", async (t) => {
  const { write, location, directory } = workspace(t);
  write("retry.ts", `${header}
export const endings = defineEndings({ done: { kind: "succeeded" } });
export default p => p.machine({ initial: "work", states: {
  work: p.operation(() => ({ type: "again" }), { again: "done" }, { retry: { on: "again", times: 1, wait: "1h" } }),
  done: p.final(endings.done),
} });`);
  const prepared = await prepareMachineRun({ ...location, machine: write("parent.ts", parent("./retry.ts")) });
  await assert.rejects(prepared.start({
    checkpoint: { directory, id: "retry", sleep: true },
    onHumanSleep() { assert.fail("parent sleep hook called"); },
  }), /delegate.*Sleeping through a child Machine is not supported yet/u);
});

test("child roles accept overrides and share Agent updates and limit policy", async (t) => {
  const { write, location } = workspace(t);
  write(".machines/agents.ts", `import { AgentLimitError } from ${runtime};
export default () => ({
  default: { description: "unused", runner: () => { throw new Error("default used"); } },
  limited: { description: "at limit", fallback: ["replacement"], runner: () => {
    throw new AgentLimitError("at limit", { harness: "test", kind: "rate" });
  } },
  replacement: { description: "works", runner: (_request, report) => {
    report?.({ type: "output", text: "child progress" });
    return { type: "done" };
  } },
});`);
  write("child.ts", `${header}
export const agentRoles = { reviewer: "Reviews work" };
export const endings = defineEndings({ done: { kind: "succeeded" } });
export default p => p.machine({ initial: "review", states: {
  review: p.agent("Review", { done: "done" }, { using: "reviewer" }),
  done: p.final(endings.done),
} });`);
  const prepared = await prepareMachineRun({
    ...location, machine: write("parent.ts", parent("./child.ts")), agents: { reviewer: "limited" },
    agentLimits: { sleep: async () => { assert.fail("should use fallback"); } },
  });
  const updates: unknown[] = [];
  const states: unknown[] = [];
  assert.equal((await prepared.start({ onAgentUpdate: update => updates.push(update), onState: state => states.push(state) })).value, "done");
  assert.ok(updates.some(update => (update as { text?: string }).text === "child progress"));
  assert.ok(updates.some(update => (update as { status?: string }).status === "swapped"));
  assert.deepEqual(states, ["delegate", { delegate: "review" }, { delegate: "done" }, "done"]);
});
