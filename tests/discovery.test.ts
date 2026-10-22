import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import { Type } from "../src/index.ts";
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

/** A module that re-exports a Machine, so a temporary project can list it. */
const reexport = (fixture: string) =>
  `export * from ${JSON.stringify(pathToFileURL(resolve(fixture)).href)}; export { default } from ${JSON.stringify(pathToFileURL(resolve(fixture)).href)};\n`;

test("discovery lists each Machine's endings with their kinds and output schemas, and none for a Machine without endings", async (context) => {
  const location = await project(context);
  await writeFile(join(location.cwd, ".machines", "ended.ts"), reexport("tests/fixtures/endings/matching.machine.ts"));
  await writeFile(join(location.cwd, ".machines", "plain.ts"),
    "export const description = 'Plain workflow'; export default () => {};\n");

  const entries = await listMachines(location);
  const ended = entries.find((entry) => entry.name === "ended");
  assert.equal(ended?.error, undefined);
  assert.deepEqual((ended as { endings?: unknown } | undefined)?.endings, [
    { name: "success", kind: "succeeded", output: JSON.parse(JSON.stringify(Type.Object({ report: Type.String() }))) },
    { name: "failure", kind: "failed" },
    { name: "abandoned", kind: "cancelled" },
  ]);
  const plain = entries.find((entry) => entry.name === "plain")!;
  assert.equal(plain.error, undefined);
  assert.equal("endings" in plain, false);
});

test("a malformed endings export lists with an error, as a malformed agentRoles does", async (context) => {
  const location = await project(context);
  await writeFile(join(location.cwd, ".machines", "loose.ts"),
    "export const description = 'Loose endings'; export const endings = { success: { kind: 'succeeded' } }; export default () => {};\n");
  await writeFile(join(location.cwd, ".machines", "scalar.ts"),
    "export const description = 'Scalar endings'; export const endings = 'success'; export default () => {};\n");
  await writeFile(join(location.cwd, ".machines", "roles.ts"),
    "export const description = 'Bad roles'; export const agentRoles = 'reviewer'; export default () => {};\n");
  await writeFile(join(location.cwd, ".machines", "valid.ts"),
    "export const description = 'Valid workflow'; export default () => {};\n");

  const entries = await listMachines(location);
  const entry = (name: string) => entries.find((found) => found.name === name);
  assert.match(entry("loose")?.error ?? "", /\bending "success"/u);
  assert.match(entry("scalar")?.error ?? "", /\bendings\b/u);
  assert.match(entry("roles")?.error ?? "", /agentRoles/u);
  // An invalid Machine lists the way one with bad roles does, and its neighbours list as before.
  for (const name of ["loose", "scalar"]) {
    const { error: _error, path: _path, ...rest } = entry(name)!;
    const { error: _roles, path: _rolesPath, ...roles } = entry("roles")!;
    assert.deepEqual(rest, { ...roles, name }, name);
  }
  assert.equal(entry("valid")?.description, "Valid workflow");
  assert.equal(entry("valid")?.error, undefined);
});

test("machine list prints each ending with its kind under its Machine, and a Machine without endings as before", async (context) => {
  const location = await project(context);
  await writeFile(join(location.cwd, ".machines", "ended.ts"), reexport("tests/fixtures/endings/matching.machine.ts"));
  await writeFile(join(location.cwd, ".machines", "plain.ts"),
    "export const description = 'Plain workflow'; export default () => {};\n");
  const listing = spawnSync(process.execPath, [resolve("machine"), "list"], {
    cwd: location.cwd,
    encoding: "utf8",
    env: { ...process.env, HOME: location.home, MACHINES_USER_HOME: location.home },
  });
  assert.equal(listing.status, 0, listing.stderr);
  const lines = listing.stdout.trimEnd().split("\n");
  const row = (name: string) => lines.findIndex((line) => line.startsWith(`${name}\t`));
  assert.match(lines[row("ended")]!, /^ended\tEnds in each of its declared endings, chosen by its input\.\t.*\.machines\/ended\.ts\tready$/u);
  assert.deepEqual(lines.slice(row("ended") + 1, row("ended") + 4), [
    "  success (succeeded)",
    "  failure (failed)",
    "  abandoned (cancelled)",
  ]);
  // A Machine without endings prints its one row and nothing under it.
  assert.match(lines[row("plain")]!, /^plain\tPlain workflow\t.*\.machines\/plain\.ts\tready$/u);
  assert.ok(row("plain") === lines.length - 1 || /^\S/u.test(lines[row("plain") + 1]!), lines.join("\n"));
});

test('quota discovery runs hooks concurrently, preserves configuration order and refreshes readings', async (context) => {
  const location = await project(context);
  const path = join(location.cwd, '.machines', 'agents.ts');
  const source = (remaining: number) => `
    let release;
    const both = new Promise(resolve => { release = resolve; });
    export default () => ({
      zFirst: { description: 'first', harness: 'claude', reserve: 10,
        runner: () => ({type:'done'}), quota: async () => { await both; return {remaining: ${remaining}, kind: 'seven_day'}; } },
      claude: { description: 'second overrides builtin', harness: 'claude', reserve: 0,
        runner: () => ({type:'done'}), quota: async () => { release(); return {remaining: 90}; } },
    });`;
  await writeFile(path, source(8));
  const entries = await listAgentPresets(location);
  const first = entries.find((entry) => entry.name === 'zFirst')!;
  assert.equal(first.hasQuota, true);
  assert.equal(first.reserve, 10);
  assert.deepEqual(first.quota, { remaining: 8, kind: 'seven_day' });
  assert.ok(first.configurationIndex! < entries.find((entry) => entry.name === 'claude')!.configurationIndex!);
  await writeFile(path, source(35));
  assert.equal((await listAgentPresets(location)).find((entry) => entry.name === 'zFirst')?.quota?.remaining, 35);
});

test('quota discovery caps each hanging hook without losing successful or failed readings', async (context) => {
  const location = await project(context);
  await writeFile(join(location.cwd, '.machines', 'agents.ts'), `
    const preset = { description: 'quota test', runner: () => ({type:'done'}) };
    export default () => ({
      slow: { ...preset, quota: () => new Promise(() => {}) },
      alsoSlow: { ...preset, quota: () => new Promise(() => {}) },
      fast: { ...preset, quota: async () => ({remaining: 42}) },
      broken: { ...preset, quota: async () => { throw new Error('offline'); } },
      empty: { ...preset, quota: async () => undefined },
    });
  `);
  const started = Date.now();
  const entries = await listAgentPresets(location);
  assert.ok(Date.now() - started < 20_000, 'each hook has its own concurrent deadline');
  for (const name of ['slow', 'alsoSlow']) {
    assert.match(entries.find((entry) => entry.name === name)?.quotaError ?? '', /10 seconds/u);
  }
  assert.equal(entries.find((entry) => entry.name === 'fast')?.quota?.remaining, 42);
  assert.match(entries.find((entry) => entry.name === 'broken')?.quotaError ?? '', /offline/u);
  assert.match(entries.find((entry) => entry.name === 'empty')?.quotaError ?? '', /no reading/u);
});
