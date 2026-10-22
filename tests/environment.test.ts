import "./environment.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

test("test setup isolates inherited home and XDG profile state", () => {
  const inheritedHome = join(tmpdir(), "machines-inherited-home");
  const inheritedState = join(tmpdir(), "machines-inherited-state");
  const script = `
    await import(${JSON.stringify(new URL("./environment.ts", import.meta.url).href)});
    const { machinesUserHome, machinesStateDirectory } = await import(${JSON.stringify(new URL("../src/discovery.ts", import.meta.url).href)});
    console.log(JSON.stringify({ home: machinesUserHome(), state: machinesStateDirectory() }));
  `;
  const actual = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    env: { ...process.env, HOME: inheritedHome, MACHINES_USER_HOME: inheritedHome, XDG_STATE_HOME: inheritedState },
  }));
  assert.notEqual(actual.home, inheritedHome);
  assert.equal(actual.state, join(actual.home, ".local", "state", "machines"));
});
