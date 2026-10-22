import "./environment.ts";

import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";

import { FileLimitMemory, readLimits } from "../src/agent-limits.ts";

import { observePriority, priorityFixture } from "./provider-test-fixture.ts";

const reset = Date.UTC(2099, 0, 1);

interface QuotaPreset {
  readonly name: string;
  readonly harness: string;
  readonly fallback?: readonly string[];
  readonly quota?: "reading" | "throws" | "invalid";
  readonly reserve?: number;
  readonly remaining?: number;
}

/** Exercise configured hooks through the launcher and CLI, without a real provider. */
async function quotaFixture(context: TestContext, presets: readonly QuotaPreset[]) {
  const fixture = await priorityFixture(context, []);
  const log = join(fixture.root, "calls.jsonl");
  const readings = join(fixture.root, "readings.json");
  await writeFile(log, "");
  await writeFile(readings, JSON.stringify(Object.fromEntries(presets.map((preset) => [
    preset.name, { remaining: preset.remaining ?? 8, resetsAt: reset, kind: "seven_day" },
  ]))));
  await writeFile(join(fixture.cwd, ".machines", "agents.ts"), `
    import { appendFileSync, readFileSync } from 'node:fs';
    const record = (value) => appendFileSync(${JSON.stringify(log)}, JSON.stringify(value) + '\\n');
    const settings = ${JSON.stringify(presets)};
    export default () => Object.fromEntries(settings.map(({ name, quota, remaining, ...metadata }) => [name, {
      description: 'Quota fixture ' + name,
      ...metadata,
      ...(quota === undefined ? {} : { quota: quota === 'invalid' ? 'x' : async () => {
        record('quota:' + name);
        if (quota === 'throws') throw new Error('quota reader offline');
        return JSON.parse(readFileSync(${JSON.stringify(readings)}, 'utf8'))[name];
      } }),
      runner: (request, report) => {
        record('runner:' + name);
        record({ preset: name, prompt: request.prompt });
        report?.({ type: 'identity', harness: metadata.harness, model: name });
        return { type: 'completed', preset: name };
      },
    }]));
  `);
  return {
    ...fixture,
    calls: async (): Promise<unknown[]> => (await readFile(log, "utf8")).trim().split("\n").filter(Boolean)
      .map((line) => JSON.parse(line) as unknown),
    setRemaining: async (name: string, remaining: number) => {
      const values = JSON.parse(await readFile(readings, "utf8"));
      values[name].remaining = remaining;
      await writeFile(readings, JSON.stringify(values));
    },
  };
}

function setEnvironment(context: TestContext, name: string, value: string) {
  const previous = process.env[name];
  process.env[name] = value;
  context.after(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
}

test("a bound Codex preset at 8% with reserve 10% skips its runner and shares a provider limit", async (context) => {
  const fixture = await quotaFixture(context, [
    { name: "implementer-astra", harness: "codex", quota: "reading", remaining: 8, reserve: 10, fallback: ["implementer"] },
    { name: "implementer", harness: "claude" },
    { name: "codex-reviewer", harness: "codex", quota: "reading", remaining: 90, fallback: ["implementer"] },
  ]);
  const file = join(fixture.root, "shared-limits.json");
  setEnvironment(context, "MACHINES_AGENT_LIMITS_FILE", file);
  // Both runs are prepared before either one discovers the low reading.
  const first = await fixture.prepare("implementer-astra");
  const sibling = await fixture.prepare("codex-reviewer");
  const observed = await observePriority(first);
  assert.equal(observed.result.value, "done");
  assert.deepEqual(observed.result.output, { type: "completed", preset: "implementer" });
  assert.deepEqual(observed.tried, ["implementer"]);
  const updates = observed.updates.filter((update) => update.type === "limit");
  assert.equal(updates.length, 1);
  assert.equal(updates[0]?.status, "swapped");
  assert.equal(updates[0]?.agent, "implementer-astra");
  assert.equal(updates[0]?.to, "implementer");
  const text = updates[0]!.text;
  for (const detail of [/implementer-astra/u, /codex/iu, /seven_day/u, /8%/u, /reserve\D*10%/iu, /continuing with implementer/u]) {
    assert.match(text, detail);
  }
  const remembered = await readLimits(new FileLimitMemory(file));
  assert.equal(remembered.length, 1);
  assert.equal(remembered[0]?.preset, "implementer-astra");
  assert.equal(remembered[0]?.harness, "codex");
  assert.equal(remembered[0]?.scope, "provider");
  assert.equal(remembered[0]?.limit.scope, "provider");
  assert.equal(remembered[0]?.limit.kind, "seven_day");
  assert.equal(remembered[0]?.limit.resetsAt, reset);
  assert.equal((await observePriority(sibling)).result.output?.preset, "implementer");
  assert.deepEqual(await fixture.calls(), [
    "quota:implementer-astra",
    "runner:implementer", { preset: "implementer", prompt: "Work" },
    "runner:implementer", { preset: "implementer", prompt: "Work" },
  ], "neither Codex runner runs; shared coverage skips the sibling hook, and skipped turns add no handoff note");
});

test("a reading of 11% with reserve 10% checks quota once immediately before running the bound preset", async (context) => {
  const fixture = await quotaFixture(context, [
    { name: "implementer-astra", harness: "codex", quota: "reading", remaining: 11, reserve: 10, fallback: ["implementer"] },
    { name: "implementer", harness: "claude" },
  ]);
  const observed = await observePriority(await fixture.prepare("implementer-astra"));
  assert.deepEqual(observed.result.output, { type: "completed", preset: "implementer-astra" });
  assert.deepEqual(observed.tried, ["implementer-astra"]);
  assert.deepEqual(observed.swaps, []);
  assert.deepEqual(await fixture.calls(), [
    "quota:implementer-astra", "runner:implementer-astra", { preset: "implementer-astra", prompt: "Work" },
  ]);
});

test("a throwing quota hook warns once per run and still runs the preset on repeated turns", async (context) => {
  const fixture = await quotaFixture(context, [
    { name: "implementer-astra", harness: "codex", quota: "throws", reserve: 10 },
  ]);
  await writeFile(join(fixture.cwd, ".machines", "work.ts"), `
    export const description = 'Repeated turns with an unavailable quota reader';
    export const agentRoles = { worker: 'Does the work' };
    export default ({ agent, final, machine }) => machine({ initial: 'first', states: {
      first: agent('First', { completed: 'second' }, { using: 'worker' }),
      second: agent('Second', { completed: 'done' }, { using: 'worker' }),
      done: final(),
    } });
  `);
  const warnings: string[] = [];
  const warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
  context.mock.method(console, "warn", warn);
  context.mock.method(console, "error", warn);
  const observed = await observePriority(await fixture.prepare("implementer-astra"));
  assert.equal(observed.result.value, "done");
  assert.deepEqual(observed.tried, ["implementer-astra", "implementer-astra"]);
  assert.deepEqual(observed.swaps, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /implementer-astra/u);
  assert.match(warnings[0]!, /quota/iu);
  assert.doesNotMatch(warnings[0]!, /[\r\n]/u);
  const calls = await fixture.calls();
  assert.equal(calls.filter((call) => call === "runner:implementer-astra").length, 2);
});

for (const remaining of [25, 35]) {
  test(`prefer claude --above 30 ${remaining === 25 ? "releases" : "applies"} the order at ${remaining}%`, async (context) => {
    const fixture = await quotaFixture(context, [
      { name: "boundCodex", harness: "codex", fallback: ["claudeA"] },
      { name: "claudeA", harness: "claude", quota: "reading", remaining },
    ]);
    const set = fixture.prefer("claude", "--above", "30");
    assert.match(set.stdout, /above\D*30%/iu);
    assert.match(set.stdout, /claudeA/u);
    assert.match(set.stdout, new RegExp(`${remaining}%`, "u"));
    const observed = await observePriority(await fixture.prepare());
    const expected = remaining > 30 ? "claudeA" : "boundCodex";
    assert.deepEqual(observed.tried, [expected]);
    assert.deepEqual(observed.result.output, { type: "completed", preset: expected });
    const saved = await readFile(fixture.file, "utf8");
    assert.deepEqual(JSON.parse(saved), { order: ["claude"], above: 30 }, "readings are not persisted");
    // Status reads the current workspace again rather than replaying the preparation reading.
    const fresh = remaining === 25 ? 35 : 25;
    await fixture.setRemaining("claudeA", fresh);
    const status = fixture.prefer();
    assert.match(status.stdout, /above\D*30%/iu);
    assert.match(status.stdout, /claudeA/u);
    assert.match(status.stdout, new RegExp(`${fresh}%`, "u"));
    assert.equal(await readFile(fixture.file, "utf8"), saved);
  });
}

test("prefer claude --above 30 applies with no Claude hook and explains that the condition cannot be checked", async (context) => {
  const fixture = await quotaFixture(context, [
    { name: "boundCodex", harness: "codex", fallback: ["claudeA"] },
    { name: "claudeA", harness: "claude" },
  ]);
  const set = fixture.prefer("claude", "--above", "30");
  assert.match(set.stdout + set.stderr, /cannot.*check|could not.*check|uncheck/iu);
  const status = fixture.prefer();
  assert.match(status.stdout + status.stderr, /cannot.*check|could not.*check|uncheck/iu);
  assert.match(status.stdout, /above\D*30%/iu);
  const observed = await observePriority(await fixture.prepare());
  assert.deepEqual(observed.tried, ["claudeA"]);
  assert.deepEqual(observed.result.output, { type: "completed", preset: "claudeA" });
});

test("MACHINES_AGENT_FALLBACK=off calls no quota hook during preference preparation or execution", async (context) => {
  const fixture = await quotaFixture(context, [
    { name: "boundCodex", harness: "codex", quota: "reading", reserve: 10, fallback: ["claudeA"] },
    { name: "claudeA", harness: "claude", quota: "reading", reserve: 10 },
  ]);
  await mkdir(dirname(fixture.file), { recursive: true });
  await writeFile(fixture.file, JSON.stringify({ order: ["claude"], above: 30 }));
  process.env.MACHINES_AGENT_FALLBACK = "off";
  const observed = await observePriority(await fixture.prepare());
  assert.deepEqual(observed.result.output, { type: "completed", preset: "boundCodex" });
  assert.deepEqual(observed.tried, ["boundCodex"]);
  assert.deepEqual(await fixture.calls(), ["runner:boundCodex", { preset: "boundCodex", prompt: "Work" }]);
});

for (const { metadata, field } of [
  { metadata: { quota: "reading", reserve: 150 }, field: "reserve" },
  { metadata: { reserve: 10 }, field: "reserve" },
  { metadata: { quota: "invalid" }, field: "quota" },
] as const) {
  test(`preflight rejects ${JSON.stringify(metadata)} and names the preset and ${field}`, async (context) => {
    const fixture = await quotaFixture(context, [{ name: "bad-preset", harness: "codex", ...metadata }]);
    await assert.rejects(fixture.prepare("bad-preset"), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /bad-preset/u);
      assert.match(error.message, new RegExp(field, "u"));
      assert.doesNotMatch(error.message, /unknown fields?/iu, "quota and reserve are recognized preset fields");
      return true;
    });
    assert.deepEqual(await fixture.calls(), [], "invalid bindings fail before hooks and runners execute");
  });
}

test("machine agents prints a configured preset's reserve and current quota reading", async (context) => {
  const fixture = await quotaFixture(context, [
    { name: "implementer-astra", harness: "codex", quota: "reading", reserve: 10, remaining: 8 },
  ]);
  const listing = fixture.cli(["agents"]);
  assert.equal(listing.status, 0, listing.stderr);
  const row = listing.stdout.split("\n").find((line) => line.startsWith("implementer-astra\t"));
  assert.ok(row, listing.stdout);
  assert.match(row, /10%/u, "the preset row includes its reserve");
  assert.match(row, /8%/u, "the preset row includes the live reading");
  assert.match(row, /seven_day/u);
  assert.deepEqual(await fixture.calls(), ["quota:implementer-astra"], "listing reads quota without running an Agent");
});
