import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { listAgentPresets, listMachines } from "../src/launcher.ts";

async function project(context: { after(fn: () => Promise<void>): void }) {
  const cwd = await mkdtemp(join(tmpdir(), "machines-catalog-"));
  context.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, ".machines", "workflow"), { recursive: true });
  return { cwd, home: join(cwd, "empty-home") };
}

test("discovery keeps valid Machines visible beside invalid definitions", async (context) => {
  const location = await project(context);
  await writeFile(join(location.cwd, ".machines", "valid.ts"),
    "export const description = 'Valid workflow'; export default () => {};\n");
  await writeFile(join(location.cwd, ".machines", "invalid.ts"),
    "export default () => {};\n");

  const entries = await listMachines(location);
  assert.equal(entries.find((entry) => entry.name === "valid")?.description, "Valid workflow");
  assert.match(entries.find((entry) => entry.name === "invalid")?.error ?? "", /must export a description/u);
});

test("discovery refreshes metadata from transitive Machine imports", async (context) => {
  const location = await project(context);
  const directory = join(location.cwd, ".machines", "workflow");
  await writeFile(join(directory, "index.ts"),
    "export { description } from './description.ts'; export default () => {};\n");
  await writeFile(join(directory, "description.ts"), "export const description = 'Before edit';\n");
  assert.equal((await listMachines(location))[0]?.description, "Before edit");
  await writeFile(join(directory, "description.ts"), "export const description = 'After edit';\n");
  assert.equal((await listMachines(location))[0]?.description, "After edit");
});

test("Agent preset discovery refreshes edited bindings", async (context) => {
  const location = await project(context);
  const path = join(location.cwd, ".machines", "agents.ts");
  const source = (description: string) => `export default () => ({ reviewer: { description: ${JSON.stringify(description)}, runner: () => ({type: 'done'}) } });`;
  await writeFile(path, source("Before edit"));
  assert.equal((await listAgentPresets(location)).find((entry) => entry.name === "reviewer")?.description, "Before edit");
  await writeFile(path, source("After edit"));
  assert.equal((await listAgentPresets(location)).find((entry) => entry.name === "reviewer")?.description, "After edit");
});

test("discovery output cannot corrupt the command's listing", async (context) => {
  const location = await project(context);
  await writeFile(join(location.cwd, ".machines", "noisy.ts"),
    "console.log('UNEXPECTED_MODULE_OUTPUT'); console.error('UNEXPECTED_MODULE_ERROR'); export const description = 'Noisy workflow'; export default () => {};\n");
  const listing = spawnSync(process.execPath, [resolve("machine"), "list"], {
    cwd: location.cwd,
    encoding: "utf8",
  });
  assert.equal(listing.status, 0, listing.stderr);
  assert.match(listing.stdout, /noisy\tNoisy workflow/u);
  assert.doesNotMatch(listing.stdout + listing.stderr, /UNEXPECTED_MODULE/u);
});
