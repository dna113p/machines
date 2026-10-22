import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { prepareMachineRun } from "../src/launcher.ts";
import { writeProviderOrder } from "../src/provider-order.ts";

import { observePriority, priorityFixture } from "./provider-test-fixture.ts";

test("prepare sorts bound Codex and its fallbacks stably to Claude, Claude, bound Codex, spare Codex", async (context) => {
  const fixture = await priorityFixture(context);
  process.env.MACHINES_AGENT_PREFER = "claude,codex";

  const observed = await observePriority(await fixture.prepare());
  assert.equal(observed.result.value, "done");
  assert.deepEqual(observed.result.output, { type: "completed", preset: "spareCodex" });
  assert.deepEqual(observed.tried, ["claudeA", "claudeB", "boundCodex", "spareCodex"]);
  assert.deepEqual(observed.swaps, [
    { status: "swapped", agent: "claudeA", to: "claudeB" },
    { status: "swapped", agent: "claudeB", to: "boundCodex" },
    { status: "swapped", agent: "boundCodex", to: "spareCodex" },
  ]);
  assert.equal(observed.attempts.length, 1, "the observer sees one preference announcement");
  assert.equal(observed.attempts[0]?.role, "worker");
  assert.match(observed.attempts[0]!.text, /boundCodex.*claude.*prefer.*claudeA/iu);
});

test("an expired --until keeps agents.ts ordering and remains visible as expired", async (context) => {
  const fixture = await priorityFixture(context);
  const expired = "2000-01-01T00:00:00.000Z";
  fixture.prefer("claude", "codex", "--until", expired);
  const stored = await readFile(fixture.file, "utf8");

  const observed = await observePriority(await fixture.prepare());
  assert.deepEqual(observed.tried, ["boundCodex", "claudeA", "claudeB", "spareCodex"]);
  assert.deepEqual(observed.attempts, []);
  const status = fixture.prefer();
  assert.match(status.stdout, /claude.*codex/iu);
  assert.match(status.stdout, /expired/iu);
  assert.match(status.stdout, /2000-01-01/u);
  assert.equal(await readFile(fixture.file, "utf8"), stored, "reading an expired preference leaves it unchanged");
});

test("a codex environment override replaces a claude file for this process", async (context) => {
  const fixture = await priorityFixture(context);
  fixture.prefer("claude");
  const stored = await readFile(fixture.file, "utf8");
  assert.deepEqual((await observePriority(await fixture.prepare())).tried,
    ["claudeA", "claudeB", "boundCodex", "spareCodex"]);

  process.env.MACHINES_AGENT_PREFER = "codex";
  const observed = await observePriority(await fixture.prepare());
  assert.deepEqual(observed.tried, ["boundCodex", "spareCodex"]);
  assert.deepEqual(observed.swaps, [{ status: "swapped", agent: "boundCodex", to: "spareCodex" }]);
  assert.equal(await readFile(fixture.file, "utf8"), stored, "the override does not change the saved order");
});

test("an empty environment override disables the saved preference", async (context) => {
  const fixture = await priorityFixture(context);
  fixture.prefer("claude");
  assert.deepEqual((await observePriority(await fixture.prepare())).tried,
    ["claudeA", "claudeB", "boundCodex", "spareCodex"]);

  process.env.MACHINES_AGENT_PREFER = "";
  const observed = await observePriority(await fixture.prepare());
  assert.deepEqual(observed.tried, ["boundCodex", "claudeA", "claudeB", "spareCodex"]);
  assert.deepEqual(observed.attempts, []);
});

test("fallback off leaves the bound preset first and alone even when Claude is preferred", async (context) => {
  const fixture = await priorityFixture(context);
  process.env.MACHINES_AGENT_PREFER = "claude,codex";
  assert.deepEqual((await observePriority(await fixture.prepare())).tried,
    ["claudeA", "claudeB", "boundCodex", "spareCodex"]);

  process.env.MACHINES_AGENT_FALLBACK = "off";
  const updates: import("../src/index.ts").AgentUpdate[] = [];
  const prepared = await fixture.prepare();
  await assert.rejects(prepared.start({ onAgentUpdate: (update) => updates.push(update) }),
    /boundCodex.*waiting for a reset is off/u);
  assert.deepEqual(updates.filter((update) => update.type === "identity").map((update) => update.model), ["boundCodex"]);
  assert.deepEqual(updates.filter((update) => update.type === "limit" || update.type === "attempt"), []);
});

test("machine agents prints the effective order once and the complete sorted chain in its fallback column", async (context) => {
  const fixture = await priorityFixture(context);
  fixture.prefer("claude", "codex");
  const listing = fixture.cli(["agents"]);
  assert.equal(listing.status, 0, listing.stderr);
  const lines = listing.stdout.trimEnd().split("\n");
  const header = lines.filter((line) => /(?:prefer|provider.*order).*claude.*codex/iu.test(line) && !line.includes("\t"));
  assert.equal(header.length, 1, listing.stdout);
  const row = lines.find((line) => line.split("\t")[0] === "boundCodex");
  assert.ok(row, listing.stdout);
  assert.ok(lines.indexOf(header[0]!) < lines.indexOf(row), "order appears above the listing");
  assert.equal(row.split("\t")[6], "claudeA, claudeB, boundCodex, spareCodex");
  for (const name of ["claudeA", "claudeB"]) {
    const preferred = lines.find((line) => line.includes(name) && line.includes("\t") && !line.includes("boundCodex"));
    assert.ok(preferred, listing.stdout);
    assert.match(preferred, /prefer|\*/iu, "the preferred provider's presets are marked");
  }
});


test("unlisted and missing harnesses keep their order, and an explicit empty fallback stays alone", async (context) => {
  const fixture = await priorityFixture(context, [
    { name: "boundCodex", harness: "other", fallback: ["missing", "claudeA", "other", "claudeB"], limited: true },
    { name: "missing", limited: true },
    { name: "claudeA", harness: "claude", limited: true },
    { name: "other", harness: "other", limited: true },
    { name: "claudeB", harness: "claude", limited: true },
    { name: "singleton", harness: "codex", fallback: [] },
  ]);
  process.env.MACHINES_AGENT_PREFER = "claude";
  const tried: string[] = [];
  const prepared = await fixture.prepare();
  await assert.rejects(prepared.start({ onAgentUpdate: (update) => {
    if (update.type === "identity") tried.push(update.model!);
  } }), /waiting for a reset is off/u);
  assert.deepEqual(tried, ["claudeA", "claudeB", "boundCodex", "missing", "other"]);
  const singleton = await observePriority(await fixture.prepare("singleton"));
  assert.deepEqual(singleton.tried, ["singleton"]);
  assert.deepEqual(singleton.attempts, []);
});

test("preparation snapshots the selected home's file and the environment order", async (context) => {
  const fixture = await priorityFixture(context);
  await writeProviderOrder({ order: ["claude"] }, fixture.home);
  process.env.MACHINES_USER_HOME = fixture.loginHome;
  const prepared = await fixture.prepare();
  await writeProviderOrder({ order: ["codex"] }, fixture.home);
  process.env.MACHINES_AGENT_PREFER = "codex";
  assert.deepEqual((await observePriority(prepared)).tried, ["claudeA", "claudeB", "boundCodex", "spareCodex"]);
  assert.deepEqual((await observePriority(await fixture.prepare())).tried, ["boundCodex", "spareCodex"]);
});

test("report-only requests use the bound preset and repeated managed requests announce preference once", async (context) => {
  const fixture = await priorityFixture(context, [
    { name: "boundCodex", harness: "codex", fallback: ["claudeA"], limited: true },
    { name: "claudeA", harness: "claude" },
  ]);
  await writeFile(join(fixture.cwd, ".machines", "report.ts"), `
    export const description = 'Reports then runs the same role twice';
    export const agentRoles = { worker: 'Does the work' };
    export default ({ agent, final, machine }) => machine({ initial: 'report', states: {
      report: agent('Report', { completed: 'wrong', limited: 'first' }, { using: 'worker', onLimit: 'limited' }),
      first: agent('First', { completed: 'second' }, { using: 'worker' }),
      second: agent('Second', { completed: 'done' }, { using: 'worker' }),
      done: final(), wrong: final(),
    } });
  `);
  process.env.MACHINES_AGENT_PREFER = "claude";
  const prepared = await prepareMachineRun({ cwd: fixture.cwd, home: fixture.home,
    machine: "report", agents: { worker: "boundCodex" }, agentLimits: { waitMinutes: 0 } });
  const observed = await observePriority(prepared);
  assert.equal(observed.result.value, "done");
  assert.deepEqual(observed.tried, ["boundCodex", "claudeA", "claudeA"]);
  assert.equal(observed.attempts.length, 1);
  assert.equal(observed.updates[0]?.type, "identity", "the report-only request emits no preference announcement");
  assert.deepEqual(observed.swaps, []);
});
