import "./environment.ts";

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { startMachineHost } from "../src/host.ts";
import { prepareMachineRun } from "../src/launcher.ts";
import { checkpointPath, type RunCheckpoint } from "../src/run-checkpoint.ts";
import { readRunStatuses } from "../src/run-status.ts";

const values = [
  { name: "undefined", source: "undefined", saved: {} },
  { name: "Date", source: 'new Date("2026-10-14T00:00:00Z")', saved: { value: "2026-10-14T00:00:00.000Z" } },
  { name: "class", source: "new (class Point { x = 1; })()", saved: { value: { x: 1 } } },
  { name: "function", source: "() => 42", saved: {} },
  { name: "array", source: "[undefined, NaN]", saved: { value: [null, null] } },
  { name: "cycle", source: "(() => { const cycle = {}; cycle.self = cycle; return cycle; })()" },
  { name: "bigint", source: "1n" },
  { name: "throwing toJSON", source: '({ toJSON() { throw new Error("cannot serialize"); } })' },
] as const;

for (const value of values) {
  test(`checkpointing ${value.name} context preserves ordinary step execution`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "checkpoint-context-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const path = join(directory, "machine.ts");
    writeFileSync(path, `export const description = "Context keeps its live values during ordinary execution.";
export default (p) => {
  const original = ${value.source};
  const context = {};
  return p.machine({ context, initial: "first", states: {
    first: p.operation(() => {
      context.value = original;
      return { type: "done" };
    }, { done: "ask" }),
    ask: p.human("Continue?", { submitted: "second" }),
    second: p.operation(() => {
      if (context.value !== original) throw new Error("context was changed by checkpointing");
      return { type: "done" };
    }, { done: "finished" }),
    finished: p.final()
  } });
};`);
    const id = "context";
    const file = checkpointPath(directory, id);
    const prepared = await prepareMachineRun({ machine: path, cwd: directory, home: directory });
    let asked = false;
    const result = await prepared.start({ checkpoint: { directory, id }, onEnter: (entry) => {
      if (entry.value === "first") {
        const checkpoint = JSON.parse(readFileSync(file, "utf8")) as RunCheckpoint;
        assert.deepEqual(checkpoint.context, {});
      }
    }, human: () => {
      asked = true;
      if ("saved" in value) {
        const checkpoint = JSON.parse(readFileSync(file, "utf8")) as RunCheckpoint;
        assert.equal(checkpoint.state.value, "ask");
        assert.deepEqual(checkpoint.context, value.saved);
        assert.equal("context" in checkpoint.state, false);
      } else {
        // The valid checkpoint from `first` must not offer a stale continuation.
        assert.equal(existsSync(file), false);
      }
      return "yes";
    } });
    assert.equal(asked, true);
    assert.equal(result.value, "finished");
    assert.equal(existsSync(file), false);
  });
}

test("CLI and published host runs complete with non-JSON context", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "checkpoint-context-process-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "machine.ts");
  writeFileSync(path, `export const description = "Runs with non-JSON context.";
export default (p) => {
  const context = { last: undefined, at: new Date(), point: new (class Point { x = 1; })(), cycle: {} };
  context.cycle.self = context.cycle;
  return p.machine({ context, initial: "work", states: {
    work: p.operation(() => {
      if (!(context.at instanceof Date) || context.point.x !== 1 || context.cycle.self !== context.cycle)
        throw new Error("context changed");
      return { type: "done" };
    }, { done: "finished" }),
    finished: p.final()
  } });
};`);
  const statusDirectory = join(directory, "status");
  const cli = spawnSync(process.execPath, [resolve("src/cli.ts"), "run", path], {
    encoding: "utf8", cwd: directory,
    env: { ...process.env, MACHINES_RUN_STATUS_DIR: statusDirectory, MACHINES_USER_HOME: directory },
  });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(readRunStatuses(statusDirectory)[0]?.status, "completed");

  const previous = process.env.MACHINES_RUN_STATUS_DIR;
  t.after(() => {
    if (previous === undefined) delete process.env.MACHINES_RUN_STATUS_DIR;
    else process.env.MACHINES_RUN_STATUS_DIR = previous;
  });
  process.env.MACHINES_RUN_STATUS_DIR = statusDirectory;
  const host = await startMachineHost({ machine: path, cwd: directory, home: directory, publishRunStatus: true });
  t.after(() => host.terminate());
  assert.deepEqual(await host.result, { state: "finished" });
  const record = readRunStatuses(statusDirectory).find((record) => record.id === host.id);
  assert.equal(record?.status, "completed");
  assert.equal(existsSync(checkpointPath(statusDirectory, host.id)), false);
});
