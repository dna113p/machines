import assert from "node:assert/strict";
import { access, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { machinesStateDirectory } from "../src/discovery.ts";
import {
  clearProviderOrder, effectiveProviderOrder, providerOrderUntil, readProviderOrder,
  writeProviderOrder,
} from "../src/provider-order.ts";

import { priorityFixture } from "./provider-test-fixture.ts";

// The ticket defines the storage location and semantics, but no JSON property names.
// Inspect its values without prescribing the persistence module's internal schema.
function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value !== null && typeof value === "object") return Object.values(value).flatMap(strings);
  return [];
}

for (const { now, expiry } of [
  { now: "2026-10-21T20:59:00-06:00", expiry: "2026-10-21T21:00:00-06:00" },
  { now: "2026-10-21T21:01:00-06:00", expiry: "2026-10-22T21:00:00-06:00" },
]) {
  test(`prefer claude --until 21:00 uses the next local 21:00 from ${now}, prints it and clears it`, async (context) => {
    const fixture = await priorityFixture(context);
    const clock = join(fixture.root, "clock.mjs");
    await writeFile(clock, `
      const ActualDate = Date;
      const now = ActualDate.parse(${JSON.stringify(now)});
      globalThis.Date = class extends ActualDate {
        constructor(...args) { if (args.length === 0) super(now); else super(...args); }
        static now() { return now; }
      };
    `);
    const cli = (args: string[]) => fixture.cli(args, {}, [clock]);
    const set = cli(["prefer", "claude", "--until", "21:00"]);
    assert.equal(set.status, 0, set.stderr);
    const stored = JSON.parse(await readFile(fixture.file, "utf8")) as unknown;
    const values = strings(stored);
    assert.ok(values.includes("claude"), "the saved JSON contains the provider order");
    assert.ok(values.some((value) => /T/u.test(value) && Date.parse(value) === Date.parse(expiry)),
      `the saved expiry must be ${expiry}: ${JSON.stringify(stored)}`);
    assert.deepEqual(await readdir(join(fixture.state, "machines")), ["provider-order.json"]);
    await assert.rejects(access(join(fixture.home, ".local", "state", "machines", "provider-order.json")), { code: "ENOENT" });

    const status = cli(["prefer"]);
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, /claude/iu);
    const utc = new Date(expiry).toISOString();
    assert.ok(
      (status.stdout.includes(expiry.slice(0, 10)) && status.stdout.includes("21:00"))
      || (status.stdout.includes(utc.slice(0, 10)) && status.stdout.includes("03:00")),
      `the status displays the expiry in local time or UTC: ${status.stdout}`,
    );
    assert.match(status.stdout, /active|in effect/iu);
    assert.doesNotMatch(status.stdout, /expired/iu);

    const clear = cli(["prefer", "--clear"]);
    assert.equal(clear.status, 0, clear.stderr);
    await assert.rejects(access(fixture.file), { code: "ENOENT" });
    const absent = cli(["prefer"]);
    assert.equal(absent.status, 0, absent.stderr);
    assert.equal(absent.stdout.trim(), "No provider preference.");
  });
}

test("prefer uses the selected Machines home's default state directory when XDG_STATE_HOME is unset", async (context) => {
  const fixture = await priorityFixture(context);
  const run = (args: string[]) => fixture.cli(args, { XDG_STATE_HOME: undefined });
  const set = run(["prefer", "claude", "codex"]);
  assert.equal(set.status, 0, set.stderr);
  const file = join(fixture.home, ".local", "state", "machines", "provider-order.json");
  const stored = JSON.parse(await readFile(file, "utf8")) as unknown;
  const values = strings(stored);
  assert.ok(values.indexOf("claude") >= 0 && values.indexOf("claude") < values.indexOf("codex"),
    "the JSON preserves the requested provider order");
  await assert.rejects(access(fixture.file), { code: "ENOENT" });
  await assert.rejects(access(join(fixture.loginHome, ".local", "state", "machines", "provider-order.json")), { code: "ENOENT" });
  const status = run(["prefer"]);
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /claude.*codex/iu);
  assert.match(status.stdout, /active|in effect/iu);
  const clear = run(["prefer", "--clear"]);
  assert.equal(clear.status, 0, clear.stderr);
  await assert.rejects(access(file), { code: "ENOENT" });
});


test("state storage isolates an alternate home from an inherited XDG directory", async (context) => {
  const fixture = await priorityFixture(context);
  assert.equal(machinesStateDirectory(fixture.home, { XDG_STATE_HOME: join(fixture.loginHome, "state") }),
    join(fixture.home, ".local", "state", "machines"));
  assert.equal(machinesStateDirectory(fixture.home, { XDG_STATE_HOME: "relative" }),
    join(fixture.home, ".local", "state", "machines"));
});

test("atomic replacements stay readable, expired files persist, and overrides bypass the file", async (context) => {
  const fixture = await priorityFixture(context);
  await writeProviderOrder({ order: ["claude", "codex"] }, fixture.home);
  assert.deepEqual(await effectiveProviderOrder(fixture.home), ["claude", "codex"]);
  await Promise.all(Array.from({ length: 8 }, (_, index) =>
    writeProviderOrder({ order: [index % 2 === 0 ? "claude" : "codex"] }, fixture.home)));
  assert.equal((await readProviderOrder(fixture.home))?.order.length, 1);
  assert.deepEqual(await readdir(join(fixture.state, "machines")), ["provider-order.json"]);
  const expired = { order: ["claude"], until: "2000-01-01T00:00:00.000Z" };
  await writeProviderOrder(expired, fixture.home);
  assert.deepEqual(await effectiveProviderOrder(fixture.home), []);
  assert.deepEqual(await readProviderOrder(fixture.home), expired);
  process.env.MACHINES_AGENT_PREFER = "codex";
  assert.deepEqual(await effectiveProviderOrder(fixture.home), ["codex"]);
  process.env.MACHINES_AGENT_PREFER = "";
  assert.deepEqual(await effectiveProviderOrder(fixture.home), []);
  delete process.env.MACHINES_AGENT_PREFER;
  await writeFile(fixture.file, '{"order":42}');
  await assert.rejects(readProviderOrder(fixture.home), /Could not read provider preference/u);
  await clearProviderOrder(fixture.home);
  await clearProviderOrder(fixture.home);
  assert.equal(await readProviderOrder(fixture.home), undefined);
});

test("expiry accepts ISO times and rejects invalid times", () => {
  assert.equal(providerOrderUntil("2026-10-21T21:00:00-06:00"), "2026-10-22T03:00:00.000Z");
  for (const value of ["25:00", "21:60", "tomorrow", "not-a-date", "2026-99-99T21:00Z"]) {
    assert.throws(() => providerOrderUntil(value), /ISO time or HH:MM/u);
  }
  const now = new Date(2026, 9, 21, 21, 0);
  assert.equal(providerOrderUntil("21:00", now), new Date(2026, 9, 22, 21, 0).toISOString());
});

test("prefer warns for unknown labels, rejects invalid arguments, and preserves the last valid file", async (context) => {
  const fixture = await priorityFixture(context);
  const unknown = fixture.prefer("custom-harness");
  assert.match(unknown.stderr, /warn.*custom-harness/iu);
  const saved = await readFile(fixture.file, "utf8");
  for (const args of [["--until"], ["claude", "--until", "25:00"], ["--clear", "claude"], ["--above", "50"], ["--until", "21:00"]]) {
    assert.notEqual(fixture.cli(["prefer", ...args]).status, 0);
    assert.equal(await readFile(fixture.file, "utf8"), saved);
  }
});
