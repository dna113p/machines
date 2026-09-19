import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { startMachineHost } from "../src/host.ts";
import { prepareMachineRun } from "../src/launcher.ts";
import type { JsonValue } from "../src/json.ts";
const machine = "tests/fixtures/structured.machine.ts";
for (const input of [
  null,
  false,
  0,
  "legacy",
  [1, null],
  { task: "work", criteria: ["checked"] },
] satisfies JsonValue[]) {
  test(`structured input/output preserves ${JSON.stringify(input)}`, async () => {
    const direct = await (await prepareMachineRun({ machine, input })).start();
    assert.deepEqual(direct.output, input);
    const hosted = await startMachineHost({ machine, input });
    assert.deepEqual(await hosted.result, { state: "done", output: input });
  });
}
test("omitted input preserves the empty string", async () => {
  assert.equal(
    (await (await prepareMachineRun({ machine })).start()).output,
    "",
  );
});
test("non-JSON launch values are rejected before execution", async () => {
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  for (const value of [
    NaN,
    Infinity,
    1n,
    new Date(),
    { x: undefined },
    cycle,
  ]) {
    await assert.rejects(
      prepareMachineRun({ machine, input: value as JsonValue }),
      /JSON-serializable/,
    );
    await assert.rejects(
      startMachineHost({ machine, input: value as JsonValue }),
      /JSON-serializable/,
    );
  }
});
test("CLI reads structured input from stdin", async () => {
  const output = await new Promise<string>((resolve, reject) => {
    const child = execFile(
      process.execPath,
      ["src/cli.ts", "run", machine, "--input-file", "-"],
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
    child.stdin?.end('{"task":"stdin"}');
  });
  assert.match(output, /"task": "stdin"/);
  await assert.rejects(
    promisify(execFile)(process.execPath, [
      "src/cli.ts",
      "run",
      machine,
      "--input-file",
      "-",
      "positional",
    ]),
    /positional input/,
  );
});

test("non-JSON hosted output fails explicitly", async () => {
  const host = await startMachineHost({ machine, input: "non-json-output" });
  await assert.rejects(
    host.result,
    /Machine output must be a JSON-serializable value/,
  );
});

test("direct CLI execution retains support for non-JSON XState output", async () => {
  const result = await promisify(execFile)(process.execPath, ["src/cli.ts", "run", machine, "non-json-output"]);
  assert.match(result.stdout, /1n/);
});
