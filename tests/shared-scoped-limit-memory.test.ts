import "./environment.ts";

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";

import type { AgentLimit, AgentUpdate } from "../src/index.ts";
import { prepareMachineRun } from "../src/launcher.ts";

const hour = 60 * 60_000;

interface Preset {
  readonly harness?: string;
  readonly model?: string;
  readonly fallback?: readonly string[];
  readonly limit?: AgentLimit;
}

interface FixtureBindings {
  readonly calls: Array<{ name: string; prompt: string }>;
  readonly controls: { beforeTurn?: (name: string) => Promise<void> };
}

function environment(t: TestContext, values: Record<string, string | undefined>) {
  for (const [name, value] of Object.entries(values)) {
    const previous = process.env[name];
    t.after(() => {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    });
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

/** Exercise real launcher memories without choosing an implementation's file schema or new memory API. */
async function project(t: TestContext, presets: Readonly<Record<string, Preset>>) {
  const cwd = await mkdtemp(join(tmpdir(), "machines-shared-limits-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const home = join(cwd, "home");
  const directory = join(cwd, ".machines");
  const file = join(home, ".local", "state", "machines", "agent-limits.json");
  environment(t, {
    MACHINES_USER_HOME: home,
    XDG_STATE_HOME: undefined,
    MACHINES_AGENT_LIMITS_FILE: undefined,
  });
  await mkdir(directory, { recursive: true });
  await writeFile(join(cwd, "package.json"), '{"private":true,"type":"module"}\n');
  const bindingPath = join(directory, "agents.ts");
  await writeFile(bindingPath, `
    export const calls = [];
    export const controls = {};
    const presets = ${JSON.stringify(presets)};
    export default ({ AgentLimitError }) => Object.fromEntries(Object.entries(presets).map(([name, settings]) => {
      const { limit, ...metadata } = settings;
      return [name, {
        description: 'Deterministic test preset ' + name,
        ...metadata,
        runner: async (request) => {
          calls.push({ name, prompt: request.prompt });
          await controls.beforeTurn?.(name);
          if (limit) throw new AgentLimitError(name + ' exhausted', limit);
          return { type: 'completed', preset: name };
        },
      }];
    }));
  `);
  for (const role of ["implementer", "investigator"]) {
    await writeFile(join(directory, `${role}.ts`), `
      export const description = 'Exercises one limit-aware role';
      export const agentRoles = { ${role}: 'Does the work' };
      export default ({ agent, final, machine }) => {
        let answer;
        return machine({ initial: 'work', output: () => answer, states: {
          work: agent('Do the work', { completed: {
            target: 'done', actions: ({ event }) => { answer = event.preset; },
          } }, { using: '${role}' }),
          done: final(),
        } });
      };
    `);
  }
  const bindings: FixtureBindings = await import(pathToFileURL(bindingPath).href);
  let time = Date.now();
  const prepare = (role: "implementer" | "investigator", preset: string) => prepareMachineRun({
    cwd, home, machine: role, agents: { [role]: preset },
    agentLimits: { waitMinutes: 0, now: () => time },
  });
  const execute = async (role: "implementer" | "investigator", preset: string) => {
    const updates: AgentUpdate[] = [];
    const result = await (await prepare(role, preset)).start({ onAgentUpdate: (update) => updates.push(update) });
    assert.equal(result.value, "done");
    return { answer: result.output, updates };
  };
  const command = (...args: string[]) => spawnSync(process.execPath, [resolve("machine"), ...args], {
    cwd, env: { ...process.env }, encoding: "utf8", timeout: 15_000,
  });
  return { cwd, home, file, bindings, prepare, execute, command, advance: (ms: number) => { time += ms; } };
}

test("two prepared runs share a Claude provider limit across presets and roles", async (t) => {
  const p = await project(t, {
    implementer: {
      harness: "claude", model: "opus", fallback: ["safe"],
      limit: { harness: "claude", kind: "five_hour", resetsAt: Date.now() + hour },
    },
    "claude-investigator": { harness: "claude", model: "sonnet", fallback: ["safe"] },
    safe: { harness: "codex" },
  });
  // Both memories exist before either run learns the limit: the second must refresh before its attempt.
  const first = await p.prepare("implementer", "implementer");
  const second = await p.prepare("investigator", "claude-investigator");
  assert.equal((await first.start()).output, "safe");
  const updates: AgentUpdate[] = [];
  const result = await second.start({ onAgentUpdate: (update) => updates.push(update) });

  assert.equal(result.value, "done");
  assert.equal(result.output, "safe", "the Claude-less fallback must answer the second run");
  assert.deepEqual(p.bindings.calls.map(({ name }) => name), ["implementer", "safe", "safe"]);
  const swap = updates.find((update) => update.type === "limit" && update.status === "swapped");
  assert.ok(swap?.type === "limit", "skipping a remembered provider limit reports the swap");
  assert.equal(swap.to, "safe");
  assert.match(swap.text, /implementer/u, "the swap names the preset that recorded the covering limit");
  assert.match(swap.text, /usage limit/u);
  assert.equal(p.bindings.calls.at(-1)?.prompt, "Do the work", "a skipped turn has no interrupted-work handoff");
  assert.ok(existsSync(p.file), "the default Machines user state file stores the limit");
});

for (const [kind, winner] of [["seven_day_opus", "sonnet"], ["five_hour", "safe"]] as const) {
  test(`${kind} skips the covered Claude families before spending another turn`, async (t) => {
    const p = await project(t, {
      opus: {
        harness: "claude", model: "opus", fallback: ["sibling-opus", "sonnet", "safe"],
        limit: { harness: "claude", kind, resetsAt: Date.now() + hour },
      },
      "sibling-opus": { harness: "claude", model: "claude-opus-4-6" },
      sonnet: { harness: "claude", model: "claude-sonnet-4-6" },
      safe: { harness: "codex" },
    });
    const result = await p.execute("implementer", "opus");

    assert.equal(result.answer, winner);
    assert.deepEqual(p.bindings.calls.map(({ name }) => name), ["opus", winner],
      "an Opus alias and a full Opus model name share a family; a provider limit also covers Sonnet");
  });
}

test("independent prepared memories merge their writes and prune an expired entry on read", { timeout: 15_000 }, async (t) => {
  const p = await project(t, {
    "expires-first": {
      harness: "claude", fallback: ["safe"],
      limit: { harness: "claude", kind: "five_hour", resetsAt: Date.now() + hour },
    },
    "expires-later": {
      harness: "codex", fallback: ["safe"],
      limit: { harness: "codex", kind: "usage", resetsAt: Date.now() + 2 * hour },
    },
    safe: {},
  });
  const first = await p.prepare("implementer", "expires-first");
  const second = await p.prepare("investigator", "expires-later");
  let entered = 0;
  let release!: () => void;
  const bothEntered = new Promise<void>((resolve) => { release = resolve; });
  p.bindings.controls.beforeTurn = async (name) => {
    if (name === "safe") return;
    if (++entered === 2) release();
    await bothEntered;
  };
  const results = await Promise.all([first.start(), second.start()]);
  assert.deepEqual(results.map((result) => result.output), ["safe", "safe"]);
  delete p.bindings.controls.beforeTurn;

  const stored = await readFile(p.file, "utf8");
  assert.doesNotThrow(() => JSON.parse(stored), "concurrent writes leave a complete JSON document");
  assert.ok(stored.includes('"expires-first"'), "one writer must not overwrite the other writer's entry");
  assert.ok(stored.includes('"expires-later"'));
  await p.execute("implementer", "expires-first");
  await p.execute("investigator", "expires-later");
  assert.equal(p.bindings.calls.filter(({ name }) => name !== "safe").length, 2,
    "fresh readers observe both remembered limits");

  p.advance(hour + 60_000);
  await p.execute("investigator", "safe"); // Reading before a healthy candidate also prunes expired entries.
  const pruned = await readFile(p.file, "utf8");
  assert.doesNotThrow(() => JSON.parse(pruned));
  assert.ok(!pruned.includes('"expires-first"'), "expired limits are removed on read");
  assert.ok(pruned.includes('"expires-later"'), "pruning preserves an unexpired limit from another run");
});

test("the none override retries a limited preset in each run while a file remembers it", async (t) => {
  const p = await project(t, {
    limited: {
      harness: "claude", fallback: ["safe"],
      limit: { harness: "claude", kind: "five_hour", resetsAt: Date.now() + hour },
    },
    safe: { harness: "codex" },
  });
  process.env.MACHINES_AGENT_LIMITS_FILE = "none";
  assert.equal((await p.execute("implementer", "limited")).answer, "safe");
  assert.equal((await p.execute("investigator", "limited")).answer, "safe");
  assert.equal(p.bindings.calls.filter(({ name }) => name === "limited").length, 2);
  assert.equal(existsSync(p.file), false, "none keeps the per-run Map and creates no state file");

  process.env.MACHINES_AGENT_LIMITS_FILE = join(p.cwd, "custom-state", "limits.json");
  assert.equal((await p.execute("implementer", "limited")).answer, "safe");
  assert.equal((await p.execute("investigator", "limited")).answer, "safe");
  assert.equal(p.bindings.calls.filter(({ name }) => name === "limited").length, 3,
    "the same two runs with a file spend only one limited turn between them");
  assert.ok(existsSync(process.env.MACHINES_AGENT_LIMITS_FILE));
  assert.equal(existsSync(p.file), false, "the override replaces the default path");
});

test("machine limits lists persisted failures and forget removes only the named preset", async (t) => {
  const p = await project(t, {
    "claude-limited": {
      harness: "claude", fallback: ["safe"],
      limit: { harness: "claude", kind: "five_hour", resetsAt: Date.now() + hour },
    },
    "codex-limited": {
      harness: "codex", fallback: ["safe"],
      limit: { harness: "codex", kind: "usage", resetsAt: Date.now() + hour },
    },
    safe: {},
  });
  await p.execute("implementer", "claude-limited");
  await p.execute("investigator", "codex-limited");
  const listed = p.command("limits");
  assert.equal(listed.status, 0, listed.stderr);
  for (const field of ["claude-limited", "claude", "five_hour", "provider", "codex-limited", "usage"]) {
    assert.ok(listed.stdout.includes(field), `listing must include ${field}: ${listed.stdout}`);
  }

  const forgot = p.command("limits", "--forget", "claude-limited");
  assert.equal(forgot.status, 0, forgot.stderr);
  const remaining = p.command("limits");
  assert.equal(remaining.status, 0, remaining.stderr);
  assert.doesNotMatch(remaining.stdout, /claude-limited/u);
  assert.match(remaining.stdout, /codex-limited/u);

  const cleared = p.command("limits", "--forget-all");
  assert.equal(cleared.status, 0, cleared.stderr);
  const empty = p.command("limits");
  assert.equal(empty.status, 0, empty.stderr);
  assert.equal(empty.stdout.trim(), "No usage limits remembered.");
});

test("machine agents shows a remembered provider limit on a sibling preset", async (t) => {
  const p = await project(t, {
    origin: {
      harness: "claude", model: "opus", fallback: ["safe"],
      limit: { harness: "claude", kind: "five_hour", resetsAt: Date.now() + hour },
    },
    sibling: { harness: "claude", model: "sonnet" },
    safe: { harness: "codex" },
  });
  await p.execute("implementer", "origin");
  const result = p.command("agents");
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const sibling = result.stdout.split("\n").find((line) => line.startsWith("sibling\t"));
  assert.match(sibling ?? "", /usage limit: origin.*five_hour.*provider/u);
  const safe = result.stdout.split("\n").find((line) => line.startsWith("safe\t"));
  assert.doesNotMatch(safe ?? "", /usage limit/u);
});


test("machine agents and limits still list when limit storage is unavailable", async (t) => {
  const p = await project(t, { healthy: { harness: "codex" } });
  const unavailable = join(p.cwd, "not-a-directory");
  await writeFile(unavailable, "file");
  environment(t, { MACHINES_AGENT_LIMITS_FILE: join(unavailable, "limits.json") });
  for (const command of ["agents", "limits"]) {
    const result = p.command(command);
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, command === "agents" ? /healthy/u : /No usage limits remembered\./u);
    assert.match(result.stderr, /usage-limit.*memory.*this run/iu);
  }
});
