import "./environment.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { AgentLimitError, type AgentLimit, type AgentRequest, type AgentRunner } from "../src/index.ts";
import { FileLimitMemory, createLimitMemory, defaultProbeMs, forgetLimits, limitAwareRunner, readLimits, type LimitCandidate } from "../src/agent-limits.ts";
import { agentLimitsFile } from "../src/discovery.ts";

const request: AgentRequest = { prompt: "Work", outcomes: ["completed"], cwd: "/tmp" };
const completed = { type: "completed" };
const healthy: AgentRunner = async () => completed;
const safe: LimitCandidate = { name: "safe", runner: healthy };

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "limit-memory-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "limits.json");
  let at = Date.now();
  const policy = { maxWaitMs: 0, probeMs: defaultProbeMs, now: () => at };
  const first = new FileLimitMemory(file, { run: () => "first-run" });
  const second = new FileLimitMemory(file, { run: () => "second-run" });
  const fail = (limit: AgentLimit): AgentRunner => async () => { throw new AgentLimitError("limited", limit); };
  const run = (memory: FileLimitMemory, candidate: LimitCandidate, fallback = true) =>
    limitAwareRunner("worker", fallback ? [candidate, safe] : [candidate], memory, policy)(request);
  return { directory, file, first, second, policy, fail, run, advance: (ms: number) => { at += ms; } };
}

for (const storage of ["map", "file"] as const) {
  for (const scenario of ["new limit", "remembered limit", "margin already passed"] as const) {
    test(`${storage}: a reset during a fallback preserves its safety margin (${scenario})`, async (t) => {
      const f = await fixture(t);
      const memory = storage === "map" ? createLimitMemory() : f.first;
      const start = f.policy.now();
      const limit = { harness: "claude", kind: "five_hour", resetsAt: start + 1_000 };
      const sleeps: number[] = [];
      const statuses: string[] = [];
      const attempts: number[] = [];
      if (scenario === "remembered limit") {
        await limitAwareRunner("worker", [{ name: "a", runner: f.fail(limit) }, safe], memory, f.policy)(request);
      }
      const runner = limitAwareRunner("worker", [
        { name: "a", runner: async () => {
          attempts.push(f.policy.now());
          if (scenario !== "remembered limit" && attempts.length === 1) throw new AgentLimitError("limited", limit);
          return completed;
        } },
        { name: "b", runner: async () => {
          f.advance(scenario === "margin already passed" ? 62_000 : 2_000);
          throw new AgentLimitError("limited", { harness: "codex", kind: "usage" });
        } },
      ], memory, {
        ...f.policy, maxWaitMs: defaultProbeMs,
        sleep: async (ms) => { sleeps.push(ms); f.advance(ms); },
      });

      assert.deepEqual(await runner(request, (update) => {
        if (update.type === "limit") statuses.push(update.status);
      }), completed);
      const alreadyPassed = scenario === "margin already passed";
      assert.deepEqual(sleeps, alreadyPassed ? [] : [59_000]);
      assert.deepEqual(statuses, alreadyPassed ? ["swapped"] : ["swapped", "waiting", "resumed"]);
      assert.deepEqual(attempts, [
        ...(scenario === "remembered limit" ? [] : [start]),
        start + (alreadyPassed ? 62_000 : 61_000),
      ]);
    });
  }
}

for (const [description, metadata, limit, skipped] of [
  ["explicit preset overrides provider inference", { harness: "claude", model: "opus" }, { harness: "claude", kind: "five_hour", scope: "preset" }, false],
  ["explicit provider overrides unknown kind", { harness: "claude" }, { harness: "claude", kind: "new", scope: "provider" }, true],
  ["missing declared harness stays preset scoped", {}, { harness: "claude", kind: "five_hour" }, false],
  ["unknown kind stays preset scoped", { harness: "claude" }, { harness: "claude", kind: "new" }, false],
  ["explicit model uses the declared model family", { harness: "claude", model: "opus" }, { harness: "claude", scope: "model" }, true],
  ["Sonnet family includes full model names", { harness: "claude", model: "sonnet" }, { harness: "claude", kind: "seven_day_sonnet" }, true],
] as const) {
  test(description, async (t) => {
    const f = await fixture(t);
    await f.run(f.first, { name: "origin", ...metadata, runner: f.fail(limit) });
    let called = false;
    await f.run(f.second, {
      name: "sibling", harness: "claude", model: `claude-${"model" in metadata ? metadata.model : "opus"}-4-6`,
      runner: async () => { called = true; return completed; },
    });
    assert.equal(called, !skipped);
    const [entry] = await readLimits(f.second, f.policy.now());
    assert.equal(entry?.limit.scope, limit.scope, "inference does not modify the runner's limit payload");
    assert.equal(entry?.run, "first-run");
  });
}

test("a remembered implementer limit never covers a different harness with the same preset name", async (t) => {
  const f = await fixture(t);
  for (const harness of ["claude", undefined]) {
    for (const scope of ["preset", "provider", "model"] as const) {
      await forgetLimits(f.first);
      await f.run(f.first, {
        name: "implementer", harness, model: "opus",
        runner: f.fail({ harness: "claude", kind: "five_hour", scope }),
      });
      const recorded = await readLimits(f.second, f.policy.now());
      assert.equal(recorded[0]?.harness, harness, "record the preset's declared harness");
      assert.equal(recorded[0]?.scope, scope);
      let calls = 0;
      assert.deepEqual(await f.run(f.second, {
        name: "implementer", harness: "codex", model: "opus",
        runner: async () => { calls++; return completed; },
      }, false), completed);
      assert.equal(calls, 1, "a different or unknown recorded harness cannot skip Codex");
      assert.deepEqual(await readLimits(f.first, f.policy.now()), recorded,
        "Codex success must not clear the unrelated limit");
      await assert.rejects(async () => f.run(f.second, {
        name: "implementer", harness, model: "opus",
        runner: async () => assert.fail("the matching harness should still be limited"),
      }, false), AgentLimitError);
    }
  }
});

for (const storage of ["map", "file"] as const) {
  test(`${storage}: same-name limits survive across harnesses and forgetting removes every matching name`, async (t) => {
    const f = await fixture(t);
    const first = storage === "map" ? createLimitMemory() : f.first;
    const second = storage === "map" ? first : f.second;
    const record = (harness: string | undefined) => limitAwareRunner("worker", [{
      name: "implementer", harness,
      runner: f.fail({ harness: harness ?? "unknown", kind: harness === "codex" ? "usage" : "five_hour",
        resetsAt: f.policy.now() + 3_600_000 }),
    }, safe], harness === "codex" ? second : first, f.policy)(request);
    await Promise.all([record("claude"), record("codex"), record(undefined)]);
    const recorded = await readLimits(second, f.policy.now());
    assert.equal(recorded.length, 3, "each declared harness, including unknown, has its own entry");
    assert.deepEqual(new Set(recorded.map((entry) => entry.harness)), new Set(["claude", "codex", undefined]));
    for (const harness of ["claude", "codex", undefined]) {
      await assert.rejects(async () => limitAwareRunner("worker", [{
        name: harness === undefined ? "implementer" : "tester", harness,
        runner: async () => assert.fail("the original limit must still skip this candidate"),
      }], second, f.policy)(request), AgentLimitError);
    }
    await limitAwareRunner("worker", [{ name: "other", runner: f.fail({ harness: "unknown" }) }, safe],
      second, f.policy)(request);
    await forgetLimits(second, "implementer");
    assert.deepEqual((await readLimits(first, f.policy.now())).map((entry) => entry.preset), ["other"],
      "forget removes all harnesses of the named preset and preserves unrelated entries");
  });
}

test("same-name probe claims and success preserve limits from other harnesses", async (t) => {
  const f = await fixture(t);
  for (const harness of ["claude", "codex", undefined]) {
    await f.run(f.first, { name: "implementer", harness,
      runner: f.fail({ harness: harness ?? "unknown", kind: harness === "codex" ? "usage" : "five_hour" }),
    });
  }
  const original = await readLimits(f.second, f.policy.now());
  assert.equal(original.length, 3);
  f.advance(defaultProbeMs);
  let finish!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { finish = resolve; });
  const probing = f.run(f.first, { name: "implementer", harness: "codex", runner: async () => {
    entered(); await gate; return completed;
  } });
  await started;
  try {
    const claimed = await readLimits(f.second, f.policy.now());
    assert.equal(claimed.length, 3, "claiming a probe replaces exactly one entry");
    assert.deepEqual(claimed.filter((entry) => entry.harness !== "codex"),
      original.filter((entry) => entry.harness !== "codex"));
    assert.equal(claimed.find((entry) => entry.harness === "codex")?.lastProbeAt, f.policy.now());
    await assert.rejects(async () => f.run(f.second, { name: "tester", harness: "codex",
      runner: async () => assert.fail("another run cannot probe the claimed provider"),
    }, false), AgentLimitError);
  } finally { finish(); await probing; }
  assert.deepEqual(await readLimits(f.second, f.policy.now()), original.filter((entry) => entry.harness !== "codex"),
    "success clears only the observed harness, including after reloading the file");
  await f.run(f.second, { name: "implementer", harness: "claude", runner: healthy });
  assert.deepEqual(await readLimits(f.first, f.policy.now()), original.filter((entry) => entry.harness === undefined));
});

test("machine limits --forget removes every harness of a preset", async (t) => {
  const f = await fixture(t);
  for (const harness of ["claude", "codex", undefined]) {
    await f.run(f.first, { name: "implementer", harness,
      runner: f.fail({ harness: harness ?? "unknown", kind: harness === "codex" ? "usage" : "five_hour" }),
    });
  }
  await f.run(f.first, { name: "unrelated", runner: f.fail({ harness: "unknown" }) });
  const result = spawnSync(process.execPath, [resolve("machine"), "limits", "--forget", "implementer"], {
    cwd: f.directory, env: { ...process.env, MACHINES_AGENT_LIMITS_FILE: f.file },
    encoding: "utf8", timeout: 15_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual((await readLimits(f.second, f.policy.now())).map((entry) => entry.preset), ["unrelated"]);
});

test("two memories share one probe and a successful probe clears the provider for both", async (t) => {
  const f = await fixture(t);
  await f.run(f.first, { name: "origin", harness: "codex", runner: f.fail({ harness: "codex", kind: "usage" }) });
  f.advance(defaultProbeMs);
  let finish!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { finish = resolve; });
  let calls = 0;
  const probing = f.run(f.first, { name: "sibling", harness: "codex", runner: async () => {
    calls++; entered(); await gate; return completed;
  } });
  await started;
  const [claimed] = await readLimits(f.second, f.policy.now());
  assert.equal(claimed?.lastProbeAt, f.policy.now());
  assert.equal(claimed?.until, f.policy.now() + defaultProbeMs);
  await f.run(f.second, { name: "another", harness: "codex", runner: async () => { calls++; return completed; } });
  assert.equal(calls, 1, "another run skips the in-flight probe");
  finish();
  await probing;
  assert.deepEqual(await readLimits(f.second, f.policy.now()), []);
  await f.run(f.second, { name: "another", harness: "codex", runner: async () => { calls++; return completed; } });
  assert.equal(calls, 2, "success is visible to another memory on its next attempt");
});

test("a stale successful probe cannot clear a newer failure", async (t) => {
  const f = await fixture(t);
  const origin = { name: "origin", harness: "codex", runner: f.fail({ harness: "codex", kind: "usage" }) };
  await f.run(f.first, origin);
  f.advance(defaultProbeMs);
  let finish!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { finish = resolve; });
  const probing = f.run(f.first, { ...origin, runner: async () => { entered(); await gate; return completed; } });
  await started;
  f.advance(defaultProbeMs);
  await f.run(f.second, origin);
  const [newer] = await readLimits(f.second, f.policy.now());
  finish(); await probing;
  assert.deepEqual(await readLimits(f.first, f.policy.now()), [newer]);
});

test("a waiting run refreshes after each sleep and notices another run forgetting the limit", async (t) => {
  const f = await fixture(t);
  const origin = { name: "origin", harness: "codex", runner: f.fail({ harness: "codex", kind: "usage" }) };
  await f.run(f.first, origin);
  let sleeps = 0;
  const answer = await limitAwareRunner("worker", [{ ...origin, runner: healthy }], f.first, {
    ...f.policy, maxWaitMs: defaultProbeMs * 2,
    sleep: async (ms) => { sleeps++; f.advance(ms); await forgetLimits(f.second); },
  })(request);
  assert.deepEqual(answer, completed);
  assert.equal(sleeps, 1);
});

test("report-only requests respect shared coverage without swapping or altering inferred event scope", async (t) => {
  const f = await fixture(t);
  await f.run(f.first, { name: "origin", harness: "claude", runner: f.fail({ harness: "claude", kind: "five_hour" }) });
  let called = false;
  const runner = limitAwareRunner("reviewer", [{ name: "sibling", harness: "claude", runner: async () => {
    called = true; return completed;
  } }, safe], f.second, f.policy);
  await assert.rejects(async () => runner({ ...request, limits: "report" }, () => assert.fail("no update")), (error) => {
    assert.ok(error instanceof AgentLimitError);
    assert.deepEqual(error.limit, { harness: "claude", kind: "five_hour", agent: "origin" });
    return true;
  });
  assert.equal(called, false);
});

test("corrupt memory is quarantined with one warning; valid writers can then merge", async (t) => {
  const f = await fixture(t);
  await writeFile(f.file, '{"partial":');
  const warnings: string[] = [];
  const memory = new FileLimitMemory(f.file, { warn: (message) => { warnings.push(message); } });
  assert.deepEqual(await readLimits(memory), []);
  assert.deepEqual(await readLimits(memory), []);
  assert.equal(warnings.length, 1);
  const quarantined = (await readdir(f.directory)).filter((name) => name.includes(".corrupt-"));
  assert.equal(quarantined.length, 1);
  assert.equal(await readFile(join(f.directory, quarantined[0]!), "utf8"), '{"partial":');
  await Promise.all([
    f.run(memory, { name: "a", runner: f.fail({ harness: "a" }) }),
    f.run(f.second, { name: "b", runner: f.fail({ harness: "b" }) }),
  ]);
  assert.deepEqual((await readLimits(memory)).map((entry) => entry.preset).sort(), ["a", "b"]);
});

test("a dead writer's lock is recovered", async (t) => {
  const f = await fixture(t);
  // Linux cannot allocate this pid (above pid_max); kill(0) deterministically reports ESRCH.
  await writeFile(`${f.file}.lock`, JSON.stringify({ pid: 2_147_483_647 }));
  assert.deepEqual(await readLimits(f.first), []);
});

test("the state path respects XDG, an isolated Machines home, and explicit overrides", () => {
  assert.equal(agentLimitsFile({ XDG_STATE_HOME: "/state" }), "/state/machines/agent-limits.json");
  assert.equal(agentLimitsFile({ MACHINES_USER_HOME: "/isolated", XDG_STATE_HOME: "/real" }),
    "/isolated/.local/state/machines/agent-limits.json");
  assert.equal(agentLimitsFile({ MACHINES_USER_HOME: "/isolated", XDG_STATE_HOME: "/isolated/state" }),
    "/isolated/state/machines/agent-limits.json");
  assert.equal(agentLimitsFile({ MACHINES_AGENT_LIMITS_FILE: "/chosen/limits.json" }), "/chosen/limits.json");
  assert.equal(agentLimitsFile({ MACHINES_AGENT_LIMITS_FILE: "none" }), undefined);
});

test("a failed sibling probe waits for every covering limit before probing again", async (t) => {
  const f = await fixture(t);
  await f.run(f.first, { name: "origin", harness: "codex", runner: f.fail({ harness: "codex", kind: "usage" }) });
  f.advance(defaultProbeMs);
  let calls = 0;
  const result = await limitAwareRunner("worker", [{ name: "sibling", harness: "codex", runner: async () => {
    calls++;
    if (calls === 1) {
      f.advance(1_000);
      throw new AgentLimitError("still limited", { harness: "codex", kind: "usage" });
    }
    return completed;
  } }], f.second, {
    ...f.policy, maxWaitMs: defaultProbeMs * 2, sleep: async (ms) => { f.advance(ms); },
  })(request);
  assert.deepEqual(result, completed);
  assert.equal(calls, 2);
  assert.deepEqual(await readLimits(f.first, f.policy.now()), []);
});

test("a shared-memory wait retains the reset safety margin while pruning expired records", async (t) => {
  const f = await fixture(t);
  const reset = f.policy.now() + 60_000;
  await f.run(f.first, { name: "origin", harness: "claude", runner: f.fail({ harness: "claude", kind: "five_hour", resetsAt: reset }) });
  await limitAwareRunner("worker", [{ name: "sibling", harness: "claude", runner: healthy }], f.second, {
    ...f.policy, maxWaitMs: 120_000, sleep: async (ms) => { f.advance(ms); },
  })(request);
  assert.equal(f.policy.now(), reset + 60_000);
  assert.deepEqual(await readLimits(f.first, f.policy.now()), []);
});


test("unavailable storage warns once and keeps limits in memory for the run", async (t) => {
  const f = await fixture(t);
  // A regular file cannot be a parent directory, even when tests run as root.
  await writeFile(f.file, "not a directory");
  const warnings: string[] = [];
  const memory = new FileLimitMemory(join(f.file, "limits.json"), { warn: (message) => { warnings.push(message); } });
  assert.deepEqual(await f.run(memory, safe, false), completed, "a healthy turn still runs");
  await rm(f.file);
  await mkdir(f.file);
  let calls = 0;
  const origin = { name: "origin", harness: "codex", runner: async () => {
    calls++;
    throw new AgentLimitError("limited", { harness: "codex", kind: "usage" });
  } };
  await f.run(memory, origin);
  await f.run(memory, origin);
  assert.equal(calls, 1, "fallback memory still skips remembered limits");
  assert.equal((await readLimits(memory)).length, 1);
  assert.deepEqual(await readdir(f.file), [], "storage stays disabled for the rest of this run");
  f.advance(defaultProbeMs);
  await f.run(memory, { ...origin, runner: healthy });
  assert.deepEqual(await readLimits(memory), [], "successful probes clear local memory");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /usage-limit.*memory.*this run/iu);
});

test("a read-only limits directory does not prevent healthy turns or listings", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.directory, "readonly"));
  const directory = join(f.directory, "readonly");
  await chmod(directory, 0o500);
  t.after(() => chmod(directory, 0o700).catch(() => {}));
  const warnings: string[] = [];
  const memory = new FileLimitMemory(join(directory, "limits.json"), { warn: (message) => { warnings.push(message); } });
  assert.deepEqual(await f.run(memory, safe, false), completed);
  assert.deepEqual(await readLimits(memory), []);
  if (process.getuid?.() !== 0) assert.equal(warnings.length, 1);
});

test("a live writer's lock times out into local memory without removing the lock", async (t) => {
  const f = await fixture(t);
  const lock = JSON.stringify({ pid: process.pid });
  await writeFile(`${f.file}.lock`, lock);
  const warnings: string[] = [];
  const memory = new FileLimitMemory(f.file, { warn: (message) => { warnings.push(message); } });
  let time = Date.now();
  t.mock.method(Date, "now", () => { time += 10_001; return time; });
  assert.deepEqual(await f.run(memory, safe, false), completed);
  assert.deepEqual(await readLimits(memory), []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /Timed out/u);
  assert.equal(await readFile(`${f.file}.lock`, "utf8"), lock);
  assert.deepEqual(await readdir(f.directory), ["limits.json.lock"], "the failed acquisition cleans up its owner file");
});

test("read failure preserves the last observed limits and forget works locally", async (t) => {
  const f = await fixture(t);
  const warnings: string[] = [];
  const memory = new FileLimitMemory(f.file, { warn: (message) => { warnings.push(message); } });
  await f.run(memory, { name: "origin", runner: f.fail({ harness: "codex", kind: "usage" }) });
  await rm(f.file);
  await mkdir(f.file);
  const remembered = await readLimits(memory);
  assert.equal(remembered[0]?.preset, "origin");
  await forgetLimits(memory, "origin");
  assert.deepEqual(await readLimits(memory), []);
  assert.equal(warnings.length, 1);
});

test("a failed write retains the mutation without repeating it", async (t) => {
  const f = await fixture(t);
  const warnings: string[] = [];
  const memory = new FileLimitMemory(f.file, { warn: (message) => { warnings.push(message); } });
  await f.run(memory, { name: "origin", runner: f.fail({ harness: "codex", kind: "usage" }) });
  const [entry] = await readLimits(memory);
  assert.ok(entry);
  // Force rename to fail after the transaction has read the valid file.
  const { mkdirSync, unlinkSync } = await import("node:fs");
  let calls = 0;
  const result = await memory.transaction(f.policy.now(), (entries) => {
    calls++;
    entries.set("new", { ...entry, preset: "new" });
    unlinkSync(f.file);
    mkdirSync(f.file);
    return "applied";
  });
  assert.equal(result, "applied");
  assert.equal(calls, 1);
  assert.deepEqual((await readLimits(memory)).map((item) => item.preset), ["origin", "new"]);
  assert.equal(warnings.length, 1);
  assert.deepEqual(await readdir(f.directory), ["limits.json"], "temporary files and locks are cleaned up");
});

test("transaction callback errors remain visible and do not disable persistence", async (t) => {
  const f = await fixture(t);
  const warnings: string[] = [];
  const memory = new FileLimitMemory(f.file, { warn: (message) => { warnings.push(message); } });
  const failure = new Error("callback bug");
  await assert.rejects(memory.transaction(f.policy.now(), () => { throw failure; }), (error) => error === failure);
  await f.run(memory, { name: "origin", runner: f.fail({ harness: "codex", kind: "usage" }) });
  assert.equal((await readLimits(f.second))[0]?.preset, "origin");
  assert.deepEqual(warnings, []);
});
