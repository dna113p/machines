import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { smokeMcp } from "./mcp-smoke.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), "machines-package-"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const userHome = join(temporary, "empty-home");
await mkdir(userHome);
const childEnvironment = { ...process.env, MACHINES_USER_HOME: userHome };
try {
  const packed = JSON.parse(execFileSync(npm, ["pack", "--ignore-scripts", "--json", "--pack-destination", temporary], {
    cwd: root, encoding: "utf8",
  }));
  assert.ok(packed[0].files.some(({ path }) => path === "dist/src/index.d.ts"));
  assert.equal(packed[0].name, "@dna113p/machines");
  assert.ok(packed[0].files.every(({ path }) => !path.startsWith("src/") && !path.startsWith("tests/")));
  assert.ok(packed[0].files.every(({ path }) => !path.startsWith("docs/history/") && path !== "AGENTS.md"));
  await writeFile(join(temporary, "package.json"), '{"private":true,"type":"module"}\n');
  execFileSync(npm, ["install", "--ignore-scripts", "--no-audit", "--no-fund", join(temporary, packed[0].filename)], {
    cwd: temporary, stdio: "inherit",
  });
  const code = `
    import assert from "node:assert/strict";
    import { machine, operation, final, run } from "@dna113p/machines";
    import { acpAgent } from "@dna113p/machines/acp";
    import { agyAgent } from "@dna113p/machines/agy";
    import { listMachines } from "@dna113p/machines/launcher";
    import { createMachinesMcpServer } from "@dna113p/machines/mcp";
    import extension from "@dna113p/machines/pi-extension";
    assert.equal(typeof acpAgent, "function");
    assert.equal(typeof agyAgent, "function");
    assert.equal(typeof listMachines, "function");
    assert.equal(typeof createMachinesMcpServer, "function");
    assert.equal(typeof extension, "function");
    const definition = machine({ initial: "work", states: {
      work: operation(() => ({ type: "completed" }), { completed: "done" }), done: final(),
    }});
    assert.equal((await run(definition)).value, "done");
  `;
  await writeFile(join(temporary, "consumer.mjs"), code);
  execFileSync(process.execPath, ["consumer.mjs"], { cwd: temporary, stdio: "inherit", env: childEnvironment });
  const installed = join(temporary, "node_modules/@dna113p/machines");
  const metadata = JSON.parse(await readFile(join(installed, "package.json"), "utf8"));
  assert.equal(metadata.bin.machine, "./dist/src/cli.js");
  for (const command of ["machine", "@dna113p/machines"]) {
    const cli = execFileSync(npm, ["exec", "--offline", "--", command, "list"], {
      cwd: temporary, encoding: "utf8", env: childEnvironment,
    });
    assert.equal(typeof cli, "string");
  }
  await writeFile(join(temporary, "consumer.mts"), `
    import { machine, operation, final, type MachinePrimitives } from "@dna113p/machines";
    const make = ({ machine, operation, final }: MachinePrimitives) => machine({
      initial: "work", states: {
        work: operation(() => ({ type: "completed" }), { completed: "done" }), done: final(),
      },
    });
    make(await import("@dna113p/machines"));
  `);
  execFileSync(process.execPath, [
    join(root, "node_modules/typescript/bin/tsc"), "--noEmit", "--strict",
    "--types", "node", "--typeRoots", join(root, "node_modules/@types"),
    "--module", "NodeNext", "--target", "ES2024", "consumer.mts",
  ], {
    cwd: temporary, stdio: "inherit",
  });
  await smokeMcp({ args: [join(installed, "dist/mcp/server.js")], cwd: temporary, project: join(temporary, "project") });
  await writeFile(join(temporary, "consumer-pi.mjs"), `
    import assert from "node:assert/strict";
    import { setTimeout } from "node:timers/promises";
    import { resolve } from "node:path";
    import extension from "@dna113p/machines/pi-extension";
    const tools = new Map();
    let shutdown;
    extension({ registerTool: (tool) => tools.set(tool.name, tool), on: (_event, handler) => { shutdown = handler; } });
    const context = { cwd: resolve("project"), ui: {
      select: async () => undefined, input: async () => undefined,
      notify: () => {}, setWidget: () => {},
    }};
    const execute = (name, params = {}) => tools.get(name).execute("smoke", params, undefined, undefined, context);
    try {
      assert.ok((await execute("machine_list")).details.machines.some((item) => item.name === "review" && !item.error));
      const runId = (await execute("machine_start", { machine: "review" })).details.run.id;
      const waiting = await waitFor("waiting");
      await execute("machine_respond", { runId, requestId: waiting.human.requestId, response: "yes" });
      assert.equal((await waitFor("completed")).state, "done");
      async function waitFor(status) {
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          const run = (await execute("machine_status", { runId })).details.runs[0];
          assert.notEqual(run.status, "failed", JSON.stringify(run));
          if (run.status === status) return run;
          await setTimeout(20);
        }
        throw new Error("Built Pi run did not become " + status);
      }
    } finally { await shutdown({}, context); }
  `);
  execFileSync(process.execPath, ["consumer-pi.mjs"], { cwd: temporary, stdio: "inherit", env: childEnvironment });
  console.log("Packed installation: imports, declarations, CLI, MCP widget, and MCP/Pi hosted Human round trips passed.");
} finally {
  await rm(temporary, { recursive: true, force: true });
}
