import "./environment.ts";

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { test } from "node:test";

import { discoverMachines } from "../src/discovery.ts";
import { loadAgentBindings } from "../src/agent-bindings.ts";
import {
  listAgentPresets,
  listMachines,
  prepareMachineRun,
} from "../src/launcher.ts";
import {
  AgentLimitError,
  type AgentRequest,
  type Event,
  agent,
  final,
  human,
  machine,
  operation,
  requiredAgentNames,
  run,
} from "../src/index.ts";

test("the command loads one exact Machine file and passes its input", () => {
  const file = "tests/fixtures/input.machine.ts";
  const result = runMachineCommand(["run", file, "exact input"]);

  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes(`Machine: ${resolvePath(file)}`));
  assert.match(result.stdout, /--> done/u);
  assert.match(result.stderr, /● input\.machine · check/u);
  assert.match(result.stderr, /● input\.machine · done/u);
});

test("the command rejects a Machine without a description", () => {
  const file = "tests/fixtures/missing-description.machine.ts";
  const result = runMachineCommand(["run", file]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must export a description/u);
});

test("the command shows an invalid exact Machine path", () => {
  const file = "tests/fixtures/missing.machine.ts";
  const result = runMachineCommand(["run", file]);

  assert.notEqual(result.status, 0);
  assert.ok(result.stdout.includes(`Machine: ${resolvePath(file)}`));
  assert.match(result.stderr, /Could not load Machine/u);
});

test("discovery uses the nearest project Machine and falls back globally", async () => {
  const fixture = resolvePath("tests/fixtures/discovery");
  const project = resolvePath(fixture, "project");
  const machines = await discoverMachines(
    resolvePath(project, "nested"),
    resolvePath(fixture, "home"),
  );

  assert.deepEqual(machines, [
    { name: "folder", path: resolvePath(project, ".machines/folder/index.ts") },
    { name: "global-only", path: resolvePath(fixture, "home/.machines/global-only.ts") },
    { name: "shared", path: resolvePath(project, ".machines/shared.ts") },
  ]);
});

test("discovery follows a globally symlinked Machine file", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "machines-symlink-"));
  const home = join(fixture, "home");
  const globalDirectory = join(home, ".machines");
  const source = join(fixture, "shared.ts");
  const installed = join(globalDirectory, "shared.ts");

  try {
    mkdirSync(globalDirectory, { recursive: true });
    writeFileSync(source, "export default function shared() {}\n");
    symlinkSync(source, installed);

    assert.deepEqual(await discoverMachines(fixture, home), [
      { name: "shared", path: installed },
    ]);
  } finally {
    rmSync(fixture, { force: true, recursive: true });
  }
});

test("Agent bindings use project values over global values and are not Machines", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "machines-agents-"));
  const home = join(fixture, "home");
  const project = join(fixture, "project");
  const projectMachines = join(project, ".machines");

  try {
    mkdirSync(join(home, ".machines"), { recursive: true });
    mkdirSync(join(projectMachines, "nested"), { recursive: true });
    writeFileSync(
      join(home, ".machines", "agents.ts"),
      [
        "export default () => ({",
        "  fastImplementer: { description: 'Fast implementation', harness: 'pi', runner: () => ({ type: 'global-fast' }) },",
        "  strongImplementer: { description: 'Strong global implementation', runner: () => ({ type: 'global-strong' }) },",
        "});",
      ].join("\n"),
    );
    writeFileSync(
      join(projectMachines, "agents.ts"),
      [
        "export default () => ({",
        "  strongImplementer: { description: 'Strong project implementation', model: 'opus', thinking: 'high', runner: () => ({ type: 'project-strong' }) },",
        "});",
      ].join("\n"),
    );
    writeFileSync(
      join(projectMachines, "workflow.ts"),
      "export default function workflow() {}\n",
    );

    const loaded = await loadAgentBindings(
      join(project, ".machines", "nested"),
      home,
      {},
    );

    const fastImplementer = loaded.agents.fastImplementer;
    const strongImplementer = loaded.agents.strongImplementer;
    assert.ok(fastImplementer);
    assert.ok(strongImplementer);
    assert.equal((await fastImplementer({ prompt: "", outcomes: [] })).type, "global-fast");
    assert.equal((await strongImplementer({ prompt: "", outcomes: [] })).type, "project-strong");
    assert.deepEqual(
      { ...loaded.presets.strongImplementer, runner: undefined },
      {
        description: "Strong project implementation",
        model: "opus",
        thinking: "high",
        runner: undefined,
      },
    );
    assert.equal(
      loaded.sources.strongImplementer,
      join(projectMachines, "agents.ts"),
    );
    assert.deepEqual(await discoverMachines(project, home), [
      { name: "workflow", path: join(projectMachines, "workflow.ts") },
    ]);
    assert.deepEqual(
      (await listAgentPresets({ cwd: project, home }))
        .find((preset) => preset.name === "strongImplementer"),
      {
        name: "strongImplementer",
        description: "Strong project implementation",
        model: "opus",
        thinking: "high",
        source: join(projectMachines, "agents.ts"),
      },
    );

    const listed = runMachineCommand(["agents"], project, { HOME: home });
    assert.equal(listed.status, 0, listed.stderr);
    assert.match(
      listed.stdout,
      /default\tRuns the current Pi Agent through ACP\tpi-acp\t\t\tbuilt in/u,
    );
    assert.match(
      listed.stdout,
      /fastImplementer\tFast implementation\tpi\t\t\t.*home\/\.machines\/agents\.ts/u,
    );
    assert.match(
      listed.stdout,
      /strongImplementer\tStrong project implementation\t\topus\thigh\t.*project\/\.machines\/agents\.ts/u,
    );
  } finally {
    rmSync(fixture, { force: true, recursive: true });
  }
});

test("Agent binding files identify invalid named runners", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "machines-agents-invalid-"));
  const home = join(fixture, "home");

  try {
    mkdirSync(join(home, ".machines"), { recursive: true });
    writeFileSync(
      join(home, ".machines", "agents.ts"),
      "export default () => ({ strongImplementer: 'opus' });\n",
    );

    await assert.rejects(
      loadAgentBindings(fixture, home),
      /Agent preset "strongImplementer" .*agents\.ts.* must be an object/u,
    );
  } finally {
    rmSync(fixture, { force: true, recursive: true });
  }
});

test("Agent presets require descriptions and runner functions", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "machines-agents-invalid-preset-"));
  const home = join(fixture, "home");

  try {
    mkdirSync(join(home, ".machines"), { recursive: true });
    writeFileSync(
      join(home, ".machines", "agents.ts"),
      "export default () => ({ reviewer: { runner: () => ({ type: 'done' }) } });\n",
    );
    await assert.rejects(
      loadAgentBindings(fixture, home),
      /Agent preset "reviewer" .* must have a non-empty description/u,
    );
  } finally {
    rmSync(fixture, { force: true, recursive: true });
  }
});

test("Agent presets reject unknown metadata fields", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "machines-agents-unknown-field-"));
  const home = join(fixture, "home");

  try {
    mkdirSync(join(home, ".machines"), { recursive: true });
    writeFileSync(
      join(home, ".machines", "agents.ts"),
      [
        "export default () => ({",
        "  reviewer: { description: 'Reviews', provider: 'mystery', runner: () => ({ type: 'done' }) },",
        "});",
      ].join("\n"),
    );
    await assert.rejects(
      loadAgentBindings(fixture, home),
      /Agent preset "reviewer" .* has unknown fields: provider/u,
    );
  } finally {
    rmSync(fixture, { force: true, recursive: true });
  }
});

test("fallback lists are validated where they are written", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "machines-agents-fallback-shape-"));
  const preset = (name: string, fallback?: string) =>
    `${name}: { description: 'Works', ${fallback === undefined ? "" : `fallback: ${fallback}, `}runner: () => ({ type: 'done' }) }`;
  // A new directory each time, since an imported file is cached by its path.
  const load = (shared: string | undefined, ...presets: string[]) => {
    const directory = mkdtempSync(join(fixture, "project-"));
    mkdirSync(join(directory, ".machines"));
    writeFileSync(join(directory, ".machines", "agents.ts"), [
      ...(shared === undefined ? [] : [`export const fallback = ${shared};`]),
      `export default () => ({ ${presets.join(", ")} });`,
    ].join("\n"));
    return loadAgentBindings(directory, join(fixture, "no-home"));
  };

  try {
    for (const [shared, problem] of [
      ["'codex'", /Agent bindings ".*agents\.ts" fallback export must be an array of preset names/u],
      ["['codex', 7]", /fallback export must contain only non-empty, trimmed, one-line preset names/u],
      ["['codex', '']", /fallback export must contain only non-empty, trimmed, one-line preset names/u],
      ["[' codex']", /fallback export must contain only non-empty, trimmed, one-line preset names/u],
      ["['co\\ndex']", /fallback export must contain only non-empty, trimmed, one-line preset names/u],
      ["['codex', 'claude', 'codex']", /fallback export names "codex" more than once/u],
    ] as const) {
      await assert.rejects(load(shared), problem, shared);
    }
    for (const [chain, problem] of [
      ["'codex'", /Agent preset "writer" fallback in ".*agents\.ts" must be an array of preset names/u],
      ["['codex', 'codex']", /Agent preset "writer" fallback in ".*agents\.ts" names "codex" more than once/u],
      ["['codex ']", /Agent preset "writer" fallback .* must contain only non-empty, trimmed, one-line preset names/u],
      ["['codex', 'writer']", /Agent preset "writer" fallback in ".*agents\.ts" must not name the preset itself/u],
    ] as const) {
      await assert.rejects(load(undefined, preset("writer", chain)), problem, chain);
    }

    // The shared list may name any preset, its own members included, and one that is not written yet.
    const loaded = await load(
      "['writer', 'reviewer', 'unwritten']", preset("writer"), preset("reviewer", "[]"), preset("pinned", "['writer']"),
    );
    assert.deepEqual(loaded.fallback, ["writer", "reviewer", "unwritten"]);
    assert.equal("fallback" in loaded.presets.writer!, false);
    assert.deepEqual(loaded.presets.reviewer!.fallback, []);
    assert.deepEqual(loaded.presets.pinned!.fallback, ["writer"]);
  } finally {
    rmSync(fixture, { force: true, recursive: true });
  }
});

test("the project fallback list replaces the global one, and listings show each preset's effective fallback", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "machines-agents-fallback-"));
  const home = join(fixture, "home");
  const project = join(fixture, "project");
  const inherits = join(fixture, "inherits");
  const runner = "runner: () => ({ type: 'done' })";

  try {
    for (const directory of [home, project, inherits]) mkdirSync(join(directory, ".machines"), { recursive: true });
    writeFileSync(join(home, ".machines", "agents.ts"), [
      "export const fallback = ['claude', 'codex'];",
      `export default () => ({ globalWriter: { description: 'Writes globally', ${runner} } });`,
    ].join("\n"));
    writeFileSync(join(project, ".machines", "agents.ts"), [
      "export const fallback = ['writer', 'spare'];",
      "export default () => ({",
      `  writer: { description: 'Writes', harness: 'claude', ${runner} },`,
      `  spare: { description: 'Stands in', ${runner} },`,
      `  pinned: { description: 'Never swaps', fallback: [], ${runner} },`,
      `  chained: { description: 'Has its own chain', fallback: ['codex', 'writer'], ${runner} },`,
      "});",
    ].join("\n"));
    writeFileSync(join(inherits, ".machines", "agents.ts"), `export default () => ({ local: { description: 'Local', ${runner} } });\n`);

    assert.deepEqual((await loadAgentBindings(project, home)).fallback, ["writer", "spare"]);
    assert.deepEqual((await loadAgentBindings(inherits, home)).fallback, ["claude", "codex"]);
    assert.equal("fallback" in await loadAgentBindings(inherits, join(fixture, "no-home")), false);

    const listed = Object.fromEntries((await listAgentPresets({ cwd: project, home })).map((preset) => [preset.name, preset.fallback]));
    assert.deepEqual(
      { writer: listed.writer, spare: listed.spare, pinned: listed.pinned, chained: listed.chained, claude: listed.claude },
      { writer: ["spare"], spare: ["writer"], pinned: [], chained: ["codex", "writer"], claude: ["writer", "spare"] },
    );
    assert.deepEqual((await listAgentPresets({ cwd: inherits, home })).find((preset) => preset.name === "claude")?.fallback, ["codex"]);

    const rows = runMachineCommand(["agents"], project, { HOME: home }).stdout.trimEnd().split("\n").map((row) => row.split("\t"));
    const row = (name: string) => rows.find((columns) => columns[0] === name);
    assert.ok(rows.every((columns) => columns.length === 7), "every row has the fallback column, last");
    assert.deepEqual(row("writer"), ["writer", "Writes", "claude", "", "", join(project, ".machines", "agents.ts"), "spare"]);
    assert.equal(row("chained")?.[6], "codex, writer");
    assert.equal(row("pinned")?.[6], "");
    assert.equal(row("default")?.[6], "writer, spare");

    const unconfigured = runMachineCommand(["agents"], fixture, { HOME: join(fixture, "no-home") });
    assert.match(unconfigured.stdout, /^default\tRuns the current Pi Agent through ACP\tpi-acp\t\t\tbuilt in\t$/mu);
  } finally {
    rmSync(fixture, { force: true, recursive: true });
  }
});

test("a missing fallback preset fails preflight only for a role the Machine uses or declares", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "machines-agents-fallback-preflight-"));
  const directory = join(fixture, ".machines");
  const home = join(fixture, "home");
  const workflow = (name: string, role: string, declared: string) => [
    `export const description = "Uses the ${role} role.";`,
    `export const agentRoles = { ${declared} };`,
    `export default function ${name}({ agent, final, machine }) {`,
    `  return machine({ initial: "work", states: { work: agent("Work", { completed: "done" }, { using: "${role}" }), done: final() } });`,
    "}",
  ].join("\n");

  try {
    mkdirSync(directory);
    writeFileSync(join(directory, "agents.ts"), [
      "export default () => ({",
      "  reviewer: { description: 'Reviews', runner: () => ({ type: 'completed' }) },",
      "  writer: { description: 'Writes', fallback: ['ghost'], runner: () => ({ type: 'completed' }) },",
      "  orphan: { description: 'Used by no Machine', fallback: ['missing'], runner: () => ({ type: 'completed' }) },",
      "});",
    ].join("\n"));
    writeFileSync(join(directory, "review.ts"), workflow("review", "reviewer", 'reviewer: "Reviews the change"'));
    writeFileSync(join(directory, "write.ts"), workflow("write", "writer", 'writer: "Writes the change"'));
    writeFileSync(join(directory, "declare.ts"), workflow("declare", "reviewer", 'reviewer: "Reviews", writer: "Declared, never used"'));

    const listed = runMachineCommand(["list"], fixture, { HOME: home });
    assert.equal(listed.status, 0, listed.stderr);
    assert.match(listed.stdout, /^write\t.*\tready$/mu);
    const presets = runMachineCommand(["agents"], fixture, { HOME: home });
    assert.equal(presets.status, 0, presets.stderr);
    assert.match(presets.stdout, /^orphan\t.*\tmissing$/mu);

    const reviewed = await prepareMachineRun({ cwd: fixture, home, machine: "review" });
    assert.equal((await reviewed.start()).value, "done");

    const expected = /^Agent preset "writer" for role "writer" falls back to "ghost", which is not a configured preset\. Available presets: .*\borphan, reviewer\b/u;
    assert.match(await rejectedMessage(prepareMachineRun({ cwd: fixture, home, machine: "write" })), expected);
    assert.match(await rejectedMessage(prepareMachineRun({ cwd: fixture, home, machine: "declare" })), expected);
    assert.match(
      await rejectedMessage(prepareMachineRun({ cwd: fixture, home, machine: "review", agents: { reviewer: "orphan" } })),
      /^Agent preset "orphan" for role "reviewer" falls back to "missing", which is not a configured preset\./u,
    );
    // Rebinding the role leaves the broken preset unused.
    const rebound = await prepareMachineRun({ cwd: fixture, home, machine: "write", agents: { writer: "reviewer" } });
    assert.equal((await rebound.start()).value, "done");
    // So does turning swapping off: no fallback is part of the role's chain.
    const unswapped = runMachineCommand(["run", "write"], fixture, { HOME: home, MACHINES_AGENT_FALLBACK: "off" });
    assert.equal(unswapped.status, 0, unswapped.stderr);
    const swapping = runMachineCommand(["run", "write"], fixture, { HOME: home, MACHINES_AGENT_FALLBACK: "on" });
    assert.notEqual(swapping.status, 0);
    assert.match(swapping.stderr, /Agent preset "writer" for role "writer" falls back to "ghost"/u);
  } finally {
    rmSync(fixture, { force: true, recursive: true });
  }
});

test("a limited role swaps along the chain of the preset it is bound to, unless swapping is off", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "machines-agents-fallback-run-"));
  const directory = join(fixture, ".machines");
  const home = join(fixture, "home");
  const reset = Date.UTC(2099, 0, 1);
  const named = (name: string, extra = "") =>
    `${name}: { description: 'Completes as ${name}', ${extra}runner: (_request, report) => { report?.({ type: 'identity', harness: '${name}' }); return { type: 'completed' }; } }`;
  const limited = (name: string, extra = "") =>
    `${name}: { description: 'Limited ${name}', harness: 'fixture', ${extra}runner: (_request, report) => { report?.({ type: 'identity', harness: '${name}' }); throw new AgentLimitError('Out of quota', { harness: 'fixture', kind: 'five_hour', resetsAt: ${reset} }); } }`;

  try {
    mkdirSync(directory);
    writeFileSync(join(directory, "agents.ts"), [
      "export const fallback = ['shared'];",
      "export default ({ AgentLimitError }) => ({",
      `  ${limited("worker")},`,
      `  ${limited("other", "fallback: ['otherSpare'], ")},`,
      `  ${limited("alone", "fallback: [], ")},`,
      `  ${named("shared")},`,
      `  ${named("otherSpare")},`,
      "});",
    ].join("\n"));
    writeFileSync(join(directory, "work.ts"), [
      'export const description = "Runs one worker.";',
      'export const agentRoles = { worker: "Does the work" };',
      "export default function work({ agent, final, machine }) {",
      '  return machine({ initial: "work", states: { work: agent("Work", { completed: "done" }, { using: "worker" }), done: final() } });',
      "}",
    ].join("\n"));
    const location = { cwd: fixture, home };
    const observe = async (agents?: Readonly<Record<string, string>>) => {
      const updates: import("../src/index.ts").AgentUpdate[] = [];
      const prepared = await prepareMachineRun({ ...location, machine: "work", ...(agents === undefined ? {} : { agents }) });
      const result = await prepared.start({ onAgentUpdate: (update) => updates.push(update) });
      return { state: result.value, updates: updates.map((update) => update.type === "identity" ? update.harness : update.type === "limit" ? update.text : update.type) };
    };

    assert.deepEqual(await observe(), {
      state: "done",
      updates: ["worker", "worker reached its usage limit (resets 2099-01-01T00:00:00Z); continuing with shared", "shared"],
    });
    // An override brings its own preset's chain, not the role's usual one.
    assert.deepEqual(await observe({ worker: "other" }), {
      state: "done",
      updates: ["other", "other (role worker) reached its usage limit (resets 2099-01-01T00:00:00Z); continuing with otherSpare", "otherSpare"],
    });

    const exhausted = /Agent failed in state "work": Agent role "worker" is at a usage limit on every allowed preset: (\w+) \(fixture, five_hour, resets 2099-01-01T00:00:00Z\); (.+)$/mu;
    // `fallback: []` keeps a preset from ever swapping; a reset that far away is not waited for.
    const pinned = await rejectedMessage(observe({ worker: "alone" }));
    assert.deepEqual(pinned.match(exhausted)?.slice(1), ["alone", "none is available within the 360-minute wait limit"]);

    const swapped = runMachineCommand(["run", "work"], fixture, { HOME: home });
    assert.equal(swapped.status, 0, swapped.stderr);
    // Outside a terminal the swap is one line between the states it happened in.
    assert.ok(swapped.stderr.endsWith([
      "● work · work",
      "worker reached its usage limit (resets 2099-01-01T00:00:00Z); continuing with shared",
      "● work · done",
      "",
    ].join("\n")), swapped.stderr);

    const off = runMachineCommand(["run", "work"], fixture, {
      HOME: home, MACHINES_AGENT_FALLBACK: "off", MACHINES_AGENT_LIMIT_WAIT_MINUTES: "0",
    });
    assert.notEqual(off.status, 0);
    assert.deepEqual(off.stderr.match(exhausted)?.slice(1), ["worker", "waiting for a reset is off"]);
    assert.doesNotMatch(off.stderr, /continuing with/u);

    const unknown = runMachineCommand(["run", "work"], fixture, { HOME: home, MACHINES_AGENT_FALLBACK: "false" });
    assert.notEqual(unknown.status, 0);
    assert.match(unknown.stderr, /MACHINES_AGENT_FALLBACK must be "off" or "on", not "false"/u);
  } finally {
    rmSync(fixture, { force: true, recursive: true });
  }
});

test("a state that handles its usage limit receives the event instead of its preset's fallback", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "machines-agents-on-limit-"));
  const directory = join(fixture, ".machines");
  const reset = Date.UTC(2099, 0, 1);

  try {
    mkdirSync(directory);
    writeFileSync(join(directory, "agents.ts"), [
      "export const fallback = ['shared'];",
      "export default ({ AgentLimitError }) => ({",
      `  reviewer: { description: 'Limited reviewer', harness: 'fixture', runner: (_request, report) => { report?.({ type: 'identity', harness: 'reviewer' }); throw new AgentLimitError('Out of quota', { harness: 'fixture', kind: 'five_hour', resetsAt: ${reset} }); } },`,
      "  shared: { description: 'Completes as shared', runner: (_request, report) => { report?.({ type: 'identity', harness: 'shared' }); return { type: 'approved' }; } },",
      "});",
    ].join("\n"));
    writeFileSync(join(directory, "review.ts"), [
      'export const description = "Reviews with another provider when it has quota.";',
      'export const agentRoles = { reviewer: "Reviews the change" };',
      "export default function review({ agent, final, machine }) {",
      "  let received;",
      "  return machine({ initial: 'review', output: () => received, states: {",
      "    review: agent('Review', {",
      "      approved: 'reviewed',",
      "      limited: { target: 'unreviewed', actions: ({ event }) => { received = event; } },",
      "    }, { using: 'reviewer', onLimit: 'limited' }),",
      "    reviewed: final(),",
      "    unreviewed: final(),",
      "  } });",
      "}",
    ].join("\n"));

    const updates: import("../src/index.ts").AgentUpdate[] = [];
    const prepared = await prepareMachineRun({ cwd: fixture, home: join(fixture, "home"), machine: "review" });
    const result = await prepared.start({ onAgentUpdate: (update) => updates.push(update) });

    assert.equal(result.value, "unreviewed");
    assert.deepEqual(result.output, {
      type: "limited",
      limit: { role: "reviewer", agent: "reviewer", harness: "fixture", kind: "five_hour", resetsAt: "2099-01-01T00:00:00.000Z" },
      message: "Out of quota",
    });
    // The configured fallback is never asked, and nothing is reported as swapped or waiting.
    assert.deepEqual(updates, [{ type: "identity", harness: "reviewer" }]);
  } finally {
    rmSync(fixture, { force: true, recursive: true });
  }
});

test("the wait limit is a non-negative number of minutes, and a role with no fallback waits for its reset", async () => {
  for (const value of ["soon", "-1", "1e3", " "]) {
    const result = runMachineCommand(["run", "tests/fixtures/input.machine.ts", "exact input"], process.cwd(), {
      MACHINES_AGENT_LIMIT_WAIT_MINUTES: value,
    });
    assert.notEqual(result.status, 0, value);
    assert.ok(
      result.stderr.includes(`MACHINES_AGENT_LIMIT_WAIT_MINUTES must be a non-negative number of minutes, not "${value}"`),
      result.stderr,
    );
  }
  for (const value of ["0", "90", "7.5", ""]) {
    const result = runMachineCommand(["run", "tests/fixtures/input.machine.ts", "exact input"], process.cwd(), {
      MACHINES_AGENT_LIMIT_WAIT_MINUTES: value,
    });
    assert.equal(result.status, 0, result.stderr);
  }

  const location = { cwd: resolvePath("tests/fixtures/agent-limit-project"), home: resolvePath("tests/fixtures/empty-home") };
  for (const waitMinutes of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
    await assert.rejects(
      prepareMachineRun({ ...location, machine: "work", agentLimits: { waitMinutes } }),
      /agentLimits\.waitMinutes must be a non-negative number of minutes/u,
    );
  }

  // Nothing is configured for the wait: the preset has no fallback and its reset is an hour away.
  let time = Date.now();
  const slept: number[] = [];
  const texts: string[] = [];
  const wait = (waitMinutes?: number) => prepareMachineRun({
    ...location,
    machine: "work",
    agents: { default: "waits" },
    agentLimits: {
      ...(waitMinutes === undefined ? {} : { waitMinutes }),
      now: () => time,
      sleep: async (milliseconds) => { slept.push(milliseconds); time += milliseconds; },
    },
  });
  await assert.rejects(
    (await wait(30)).start({ onAgentUpdate: (update) => { if (update.type === "limit") texts.push(update.text); } }),
    /is at a usage limit on every allowed preset: waits \(fixture, five_hour, resets .*Z\); none is available within the 30-minute wait limit/u,
  );
  assert.deepEqual({ slept, texts }, { slept: [], texts: [] });

  // The default is six hours. The fixture preset stays limited: once its stated reset has passed it is
  // probed every fifteen minutes, and a last time when the six hours are up.
  const states: unknown[] = [];
  await assert.rejects(
    (await wait()).start({
      onState: (state) => states.push(state),
      onAgentUpdate: (update) => { if (update.type === "limit") texts.push(`${update.status}: ${update.text}`); },
    }),
    /none is available within the 360-minute wait limit/u,
  );
  assert.deepEqual(states, ["work"]);
  // The wait is reported once for all of those probes, and the Agent never resumes.
  assert.equal(texts.length, 1, texts.join("\n"));
  assert.match(texts[0]!, /^waiting: waits \(role default\) reached its usage limit; waiting for the reset at .*Z$/u);
  assert.ok(slept.every((milliseconds) => milliseconds <= 60_000));
  assert.equal(Math.round(slept.reduce((total, milliseconds) => total + milliseconds, 0) / 60_000), 360);
});

test("a Claude Code usage limit falls back to Codex and the Machine finishes", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "machines-agents-fallback-cli-"));
  const directory = join(fixture, ".machines");
  const command = (file: string, mode: string) =>
    `${JSON.stringify(process.execPath)}, ${JSON.stringify([resolvePath("tests/fixtures", file), mode])}, { output: "capture", harness: "fake-${mode}" }`;

  try {
    mkdirSync(directory);
    writeFileSync(join(directory, "agents.ts"), [
      "export const fallback = ['claude', 'codex'];",
      "export default ({ claudeAgent, codexAgent }) => ({",
      `  claude: { description: 'Claude Code at its limit', harness: 'claude', runner: claudeAgent(${command("fake-claude-agent.mjs", "usage-limit")}) },`,
      `  codex: { description: 'Codex', harness: 'codex', runner: codexAgent(${command("fake-codex-agent.mjs", "normal")}) },`,
      "});",
    ].join("\n"));
    writeFileSync(join(directory, "task.ts"), [
      'export const description = "Runs one implementer.";',
      'export const agentRoles = { implementer: "Implements the task" };',
      "export default function task({ agent, final, machine }) {",
      `  return machine({ initial: "implement", states: {`,
      `    implement: agent("Do the task", { completed: "done" }, { using: "implementer", cwd: ${JSON.stringify(fixture)} }),`,
      "    done: final(),",
      "  } });",
      "}",
    ].join("\n"));

    const updates: import("../src/index.ts").AgentUpdate[] = [];
    const prepared = await prepareMachineRun({
      cwd: fixture, home: join(fixture, "home"), machine: "task", agents: { implementer: "claude" },
    });
    const result = await prepared.start({ onAgentUpdate: (update) => updates.push(update) });

    assert.equal(result.value, "done");
    const order = updates.flatMap((update) => update.type === "identity" ? [update.harness] : update.type === "limit" ? ["limit"] : []);
    assert.deepEqual(order.filter((item, index) => item !== order[index - 1]), ["fake-usage-limit", "limit", "fake-normal"]);
    const swap = updates.find((update) => update.type === "limit")!;
    assert.deepEqual({ status: swap.status, agent: swap.agent, to: swap.to }, { status: "swapped", agent: "claude", to: "codex" });
    assert.match(
      swap.text,
      /^claude \(role implementer\) reached its usage limit \(resets \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\); continuing with codex$/u,
    );
  } finally {
    rmSync(fixture, { force: true, recursive: true });
  }
});

test("the command finds a project Machine upward and prefers its file", () => {
  const cwd = resolvePath("tests/fixtures/discovery/project/nested");
  const result = runMachineCommand(["run", "shared"], cwd);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\.machines\/shared\.ts/u);
  assert.match(result.stdout, /scope: local/u);
});

test("a directory Machine can import neighboring TypeScript", () => {
  const cwd = resolvePath("tests/fixtures/discovery/project/nested");
  const result = runMachineCommand(["run", "folder"], cwd);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\.machines\/folder\/index\.ts/u);
  assert.match(result.stdout, /loaded folder\/index\.ts and its import/u);
});

test("list exposes Machine descriptions and resolved project paths", () => {
  const cwd = resolvePath("tests/fixtures/discovery/project/nested");
  const listed = runMachineCommand(["list"], cwd);
  const shown = runMachineCommand(["show", "folder"], cwd);

  assert.equal(listed.status, 0, listed.stderr);
  assert.match(
    listed.stdout,
    /folder\tDemonstrates a directory Machine with a neighboring import\.\t.*\.machines\/folder\/index\.ts/u,
  );
  assert.match(
    listed.stdout,
    /shared\tRuns the project-specific shared Machine\.\t.*\.machines\/shared\.ts/u,
  );
  assert.equal(shown.status, 0, shown.stderr);
  assert.match(shown.stdout, /Machine: .*\.machines\/folder\/index\.ts/u);
  assert.match(shown.stdout, /from "\.\/message\.ts"/u);
});

test("the shared launcher lists validated Machine metadata", async () => {
  const cwd = resolvePath("tests/fixtures/discovery/project/nested");
  const home = resolvePath("tests/fixtures/discovery/home");
  const listed = await listMachines({ cwd, home });

  assert.deepEqual(
    listed.map(({ name, description, missingAgents }) => ({
      name,
      description,
      missingAgents,
    })),
    [
      {
        name: "folder",
        description: "Demonstrates a directory Machine with a neighboring import.",
        missingAgents: [],
      },
      {
        name: "global-only",
        description: "Runs the global-only discovery fixture.",
        missingAgents: [],
      },
      {
        name: "shared",
        description: "Runs the project-specific shared Machine.",
        missingAgents: [],
      },
    ],
  );
});

test("a prepared Machine run is validated before it starts and starts only once", async () => {
  const prepared = await prepareMachineRun({
    machine: "tests/fixtures/input.machine.ts",
    input: "exact input",
  });

  assert.equal(prepared.name, "input.machine");
  assert.equal(prepared.description, "Checks that exact-path execution receives its command input.");
  const result = await prepared.start();
  assert.equal(result.value, "done");
  assert.throws(
    () => prepared.start(),
    /Prepared Machine .* has already started/u,
  );
});

test("a prepared directory Machine keeps its discovered name", async () => {
  const prepared = await prepareMachineRun({
    cwd: resolvePath("tests/fixtures/discovery/project/nested"),
    home: resolvePath("tests/fixtures/discovery/home"),
    machine: "folder",
  });

  assert.equal(prepared.name, "folder");
});

test("list rejects an invalid Machine description", () => {
  const fixture = mkdtempSync(join(tmpdir(), "machines-description-"));
  const directory = join(fixture, ".machines");

  try {
    mkdirSync(directory);
    writeFileSync(
      join(directory, "invalid.ts"),
      "export const description = ['not a string'];\nexport default function invalid() {}\n",
    );
    const result = runMachineCommand(["list"], fixture);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /description must be a non-empty string/u);
  } finally {
    rmSync(fixture, { force: true, recursive: true });
  }
});

test("list rejects a Machine without a description", () => {
  const fixture = mkdtempSync(join(tmpdir(), "machines-description-"));
  const directory = join(fixture, ".machines");

  try {
    mkdirSync(directory);
    writeFileSync(join(directory, "legacy.ts"), "export default function legacy() {}\n");
    const result = runMachineCommand(["list"], fixture);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /must export a description/u);
  } finally {
    rmSync(fixture, { force: true, recursive: true });
  }
});

test("the command preflights declared Agent roles before starting the Machine", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "machines-agent-preflight-"));
  const directory = join(fixture, ".machines");
  const marker = join(fixture, "operation-ran");

  try {
    mkdirSync(directory);
    writeFileSync(
      join(directory, "review.ts"),
      [
        'import { writeFileSync } from "node:fs";',
        'export const description = "Proves named Agent dependency preflight.";',
        'export const agentRoles = { strongReviewer: "Performs escalated review" };',
        "export default function review({ agent, final, machine, operation }) {",
        "  return machine({",
        '    initial: "prepare",',
        "    states: {",
        `      prepare: operation(() => { writeFileSync(${JSON.stringify(marker)}, "yes"); return { type: "prepared" }; }, { prepared: "review" }),`,
        '      review: agent("Review carefully", { completed: "done" }, { using: "strongReviewer" }),',
        "      done: final(),",
        "    },",
        "  });",
        "}",
      ].join("\n"),
    );

    const listed = runMachineCommand(["list"], fixture);
    const missing = runMachineCommand(["run", "review"], fixture);
    const directMissing = await rejectedMessage(prepareMachineRun({
      cwd: fixture,
      home: join(fixture, "home"),
      machine: "review",
    }));

    assert.equal(listed.status, 0, listed.stderr);
    assert.match(listed.stdout, /review\t.*\tmissing Agents: strongReviewer/u);
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /missing required Agent runners/u);
    assert.ok(missing.stderr.includes(directMissing));
    assert.match(missing.stderr, /strongReviewer: Performs escalated review/u);
    assert.match(missing.stderr, /\.machines\/agents\.ts/u);
    assert.equal(existsSync(marker), false);

    writeFileSync(
      join(directory, "agents.ts"),
      'export default () => ({ opusReviewer: { description: "Careful Opus review", runner: () => ({ type: "completed" }) } });\n',
    );
    const unknownPreset = runMachineCommand(
      ["run", "review", "--agent", "strongReviewer=missing"],
      fixture,
    );
    assert.notEqual(unknownPreset.status, 0);
    assert.match(unknownPreset.stderr, /Agent preset "missing" was not found/u);
    assert.equal(existsSync(marker), false);
    const directUnknownPreset = await rejectedMessage(prepareMachineRun({
      cwd: fixture,
      home: join(fixture, "home"),
      machine: "review",
      agents: { strongReviewer: "missing" },
    }));
    assert.ok(unknownPreset.stderr.includes(directUnknownPreset));

    const unknownRole = runMachineCommand(
      ["run", "review", "--agent", "implementer=opusReviewer"],
      fixture,
    );
    assert.notEqual(unknownRole.status, 0);
    assert.match(unknownRole.stderr, /does not declare or use Agent role "implementer"/u);
    assert.equal(existsSync(marker), false);

    const configured = runMachineCommand([
      "run",
      "review",
      "--agent",
      "strongReviewer=opusReviewer",
      "--",
      "Review this exact change",
    ], fixture);

    assert.equal(configured.status, 0, configured.stderr);
    assert.equal(existsSync(marker), true);
    assert.match(configured.stdout, /--> done/u);
  } finally {
    rmSync(fixture, { force: true, recursive: true });
  }
});

test("the command rejects a named Agent state without a declared role", () => {
  const fixture = mkdtempSync(join(tmpdir(), "machines-agent-role-"));
  const directory = join(fixture, ".machines");

  try {
    mkdirSync(directory);
    writeFileSync(
      join(directory, "review.ts"),
      [
        'export const description = "Uses one named reviewer.";',
        "export default function review({ agent, final, machine }) {",
        "  return machine({",
        '    initial: "review",',
        "    states: {",
        '      review: agent("Review", { completed: "done" }, { using: "reviewer" }),',
        "      done: final(),",
        "    },",
        "  });",
        "}",
      ].join("\n"),
    );
    writeFileSync(
      join(directory, "agents.ts"),
      'export default () => ({ reviewer: { description: "Reviews changes", runner: () => ({ type: "completed" }) } });\n',
    );

    const result = runMachineCommand(["run", "review"], fixture);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /uses undeclared Agent roles: reviewer/u);
  } finally {
    rmSync(fixture, { force: true, recursive: true });
  }
});

test("a missing Machine name points to the list command", () => {
  const cwd = resolvePath("tests/fixtures/discovery/project/nested");
  const result = runMachineCommand(["run", "missing"], cwd);

  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /Machine "missing" not found\. Run "machine list" to see available Machines\./u,
  );
});

function runMachineCommand(
  args: readonly string[],
  cwd = process.cwd(),
  env: Readonly<Record<string, string>> = {},
) {
  return spawnSync(
    process.execPath,
    [resolvePath("machine"), ...args],
    { cwd, encoding: "utf8", env: { ...process.env, ...env } },
  );
}

test("an Agent receives only its request and returns one outcome", async () => {
  const requests: AgentRequest[] = [];
  const example = machine({
    initial: "work",
    states: {
      work: agent(
        "Implement the tiny task",
        { completed: "done" },
        { cwd: "/tmp/machines-fake" },
      ),
      done: final(),
    },
  });

  const result = await run(example, {
    agents: {
      default: (request) => {
        requests.push(request);
        return { type: "completed" };
      },
    },
  });

  assert.deepEqual(requests, [{
    prompt: "Implement the tiny task",
    outcomes: ["completed"],
    cwd: "/tmp/machines-fake",
  }]);
  assert.equal(result.value, "done");
});

test("Agent states select exact named runners", async () => {
  const calls: string[] = [];
  const example = machine({
    initial: "quickReview",
    states: {
      quickReview: agent(
        "Review quickly",
        { inconclusive: "strongReview" },
        { using: "fastReviewer" },
      ),
      strongReview: agent(
        "Review carefully",
        { approved: "done" },
        { using: "strongReviewer" },
      ),
      done: final(),
    },
  });

  const result = await run(example, {
    agents: {
      fastReviewer: (request) => {
        calls.push(`fast: ${request.prompt}`);
        assert.deepEqual(Object.keys(request), ["prompt", "outcomes"]);
        return { type: "inconclusive" };
      },
      strongReviewer: (request) => {
        calls.push(`strong: ${request.prompt}`);
        return { type: "approved" };
      },
    },
  });

  assert.deepEqual(calls, ["fast: Review quickly", "strong: Review carefully"]);
  assert.equal(result.value, "done");
});

test("missing named runners fail before an Operation starts", async () => {
  let operationRan = false;
  const example = machine({
    initial: "prepare",
    states: {
      prepare: operation(
        () => {
          operationRan = true;
          return { type: "prepared" };
        },
        { prepared: "review" },
      ),
      review: agent(
        "Review carefully",
        { approved: "done" },
        { using: "strongReviewer" },
      ),
      done: final(),
    },
  });

  await assert.rejects(
    run(example, { agents: { default: () => ({ type: "completed" }) } }),
    /Machine requires missing Agent runner: strongReviewer/u,
  );
  assert.equal(operationRan, false);
});

test("invalid runner bindings fail before an Operation starts", async () => {
  let operationRan = false;
  const example = machine({
    initial: "prepare",
    states: {
      prepare: operation(
        () => {
          operationRan = true;
          return { type: "prepared" };
        },
        { prepared: "work" },
      ),
      work: agent("Work", { completed: "done" }),
      done: final(),
    },
  });

  await assert.rejects(
    run(example, {
      agents: { default: "not a runner" } as unknown as Record<string, never>,
    }),
    /Agent runner "default" must be a function/u,
  );
  assert.equal(operationRan, false);
});

test("an Agent runner reports harness-neutral updates", async () => {
  const updates: import("../src/index.ts").AgentUpdate[] = [];
  const example = machine({
    initial: "work",
    states: {
      work: agent("Implement the tiny task", { completed: "done" }),
      done: final(),
    },
  });

  await run(example, {
    agents: {
      default: (_request, report) => {
        report?.({
          type: "identity",
          harness: "native-codex",
          model: "gpt-5",
          thinking: "high",
        });
        return { type: "completed" };
      },
    },
    onAgentUpdate: (update) => updates.push(update),
  });

  assert.deepEqual(updates, [{
    type: "identity",
    harness: "native-codex",
    model: "gpt-5",
    thinking: "high",
  }]);
});

test("an Agent can resolve its prompt when its state starts", async () => {
  let prompt = "before the Operation";
  const requests: AgentRequest[] = [];
  const example = machine({
    initial: "prepare",
    states: {
      prepare: operation(
        () => {
          prompt = "after the Operation";
          return { type: "prepared" };
        },
        { prepared: "work" },
      ),
      work: agent(() => prompt, { completed: "done" }),
      done: final(),
    },
  });

  const result = await run(example, {
    agents: {
      default: (request) => {
        requests.push(request);
        return { type: "completed" };
      },
    },
  });

  assert.equal(requests[0]?.prompt, "after the Operation");
  assert.equal(result.value, "done");
});

test("a run reports each authoritative state change once", async () => {
  const states: unknown[] = [];
  const example = machine({
    initial: "prepare",
    states: {
      prepare: operation(
        () => {
          assert.deepEqual(states, ["prepare"]);
          return { type: "prepared" };
        },
        { prepared: "finish" },
      ),
      finish: operation(
        () => ({ type: "finished" }),
        { finished: "done" },
      ),
      done: final(),
    },
  });

  const result = await run(example, {
    onState: (state) => states.push(state),
  });

  assert.deepEqual(states, ["prepare", "finish", "done"]);
  assert.equal(result.value, "done");
});

test("an invalid Agent outcome identifies the state and event", async () => {
  const example = machine({
    initial: "work",
    states: {
      work: agent("Implement the tiny task", { completed: "done" }),
      done: final(),
    },
  });

  await assert.rejects(
    run(example, { agents: { default: () => ({ type: "unexpected" }) } }),
    /State "work" does not handle event "unexpected"/u,
  );
});

test("a missing Agent runner fails at the Agent state", async () => {
  const example = machine({
    initial: "work",
    states: {
      work: agent("Implement the tiny task", { completed: "done" }),
      done: final(),
    },
  });

  await assert.rejects(
    run(example),
    /Machine requires missing Agent runner: default/u,
  );
});

test("an Agent state validates the usage-limit event it names", () => {
  const transitions = { approved: "done", limited: "done" };

  assert.throws(
    () => agent("Review", transitions, { onLimit: "exhausted" }),
    /Agent onLimit event "exhausted" must be one of the state's transitions/u,
  );
  assert.throws(
    () => agent("Review", { limited: "done" }, { onLimit: "limited" }),
    /Agent onLimit event "limited" cannot be the state's only transition: the Agent needs an outcome of its own/u,
  );
  for (const onLimit of [" limited", "limited ", "", "  "]) {
    assert.throws(
      () => agent("Review", { ...transitions, [onLimit]: "done" }, { onLimit }),
      /Agent onLimit must be a non-empty trimmed event name/u,
    );
  }
  assert.throws(
    () => agent("Review", transitions, { onLimit: 1 as unknown as string }),
    /Agent onLimit must be a non-empty trimmed event name/u,
  );
});

test("a usage limit becomes the event its Agent state names, which the Agent is never offered", async () => {
  const requests: AgentRequest[] = [];
  const received: Event[] = [];
  const resetsAt = Date.UTC(2026, 9, 10, 21);
  const example = machine({
    initial: "review",
    states: {
      review: agent(
        "Review the change",
        {
          approved: "commit",
          revise: "repair",
          limited: { target: "soloFlow", actions: ({ event }: { event: Event }) => { received.push(event); } },
        },
        { using: "reviewer", onLimit: "limited", cwd: "/tmp/machines-fake" },
      ),
      commit: final(),
      repair: final(),
      soloFlow: agent("Review your own change", { approved: "commit" }),
    },
  });

  assert.deepEqual(requiredAgentNames(example), ["default", "reviewer"]);
  assert.deepEqual(
    (example.config.states as Record<string, { readonly meta?: unknown }>).review?.meta,
    { "machines.agent": { using: "reviewer", onLimit: "limited" } },
  );

  const result = await run(example, {
    agents: {
      reviewer: (request) => {
        requests.push(request);
        throw new Error("Turn failed", {
          cause: new AgentLimitError("Out of quota until 21:00", { harness: "claude", kind: "five_hour", resetsAt }),
        });
      },
      default: (request) => {
        requests.push(request);
        return { type: "approved" };
      },
    },
  });

  assert.equal(result.value, "commit");
  assert.deepEqual(requests, [
    { prompt: "Review the change", outcomes: ["approved", "revise"], cwd: "/tmp/machines-fake", limits: "report" },
    { prompt: "Review your own change", outcomes: ["approved"] },
  ]);
  const expected = {
    type: "limited",
    limit: { role: "reviewer", harness: "claude", kind: "five_hour", resetsAt: "2026-10-10T21:00:00.000Z" },
    message: "Turn failed",
  };
  assert.deepEqual(received, [expected]);
  assert.deepEqual(JSON.parse(JSON.stringify(received[0])), expected);

  // Only what the limit states is in the event: a preset name comes from whoever selected the preset.
  received.length = 0;
  await run(example, {
    agents: {
      reviewer: () => { throw new AgentLimitError("No quota", { harness: "codex", agent: "codex-write", resetsAt: Number.NaN }); },
      default: () => ({ type: "approved" }),
    },
  });
  assert.deepEqual(received, [{
    type: "limited",
    limit: { role: "reviewer", agent: "codex-write", harness: "codex" },
    message: "No quota",
  }]);
});

test("an Agent state that names a usage-limit event still fails on any other error", async () => {
  const example = machine({
    initial: "review",
    states: {
      review: agent("Review the change", { approved: "done", limited: "done" }, { onLimit: "limited" }),
      done: final(),
    },
  });

  await assert.rejects(
    run(example, { agents: { default: () => { throw new Error("claude crashed"); } } }),
    /^Error: Agent failed in state "review": claude crashed$/u,
  );
  // The Agent is at no limit until its runner says so: it cannot take the transition by naming the event.
  await assert.rejects(
    run(example, { agents: { default: () => ({ type: "limited" }) } }),
    /^Error: Agent failed in state "review": the runner returned "limited", which this state reserves for its usage-limit event$/u,
  );
  await assert.rejects(
    run(example, { agents: { default: () => ({ type: "unexpected" }) } }),
    /State "review" does not handle event "unexpected"/u,
  );
  assert.equal((await run(example, { agents: { default: () => ({ type: "approved" }) } })).value, "done");
});

test("a usage limit fails an Agent state that names no event for it", async () => {
  const requests: AgentRequest[] = [];
  const example = machine({
    initial: "work",
    states: {
      work: agent("Implement the tiny task", { completed: "done", limited: "done" }),
      done: final(),
    },
  });

  await assert.rejects(
    run(example, {
      agents: {
        default: (request) => {
          requests.push(request);
          throw new AgentLimitError("Out of quota", { harness: "claude" });
        },
      },
    }),
    /^Error: Agent failed in state "work": Out of quota$/u,
  );
  assert.deepEqual(requests, [{ prompt: "Implement the tiny task", outcomes: ["completed", "limited"] }]);
});

test("a Human accepts free-form terminal input even when a suggestion is shown", async () => {
  const result = await runHumanExample("Something entirely different\n");

  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout, /What should happen\?/u);
  assert.match(result.stdout, /- Use the default/u);
  assert.match(result.stdout, /submitted "Something entirely different"\n--> done/u);
});

test("a Human accepts only declared choices outside an interactive terminal", async () => {
  const accepted = await runHumanChoices("approve\n");
  const rejected = await runHumanChoices("Something entirely different\n");

  assert.equal(accepted.exitCode, 0, accepted.stderr);
  assert.match(accepted.stdout, /Choices:\n- approve\n- deny/u);
  assert.match(accepted.stdout, /submitted "approve"\n--> done/u);
  assert.notEqual(rejected.exitCode, 0);
  assert.match(rejected.stderr, /Expected one of: approve, deny/u);
});

test("a Human requires at least one restricted choice", () => {
  assert.throws(
    () => human("Choose", { submitted: "done" }, { choices: [] }),
    /Human choices must include at least one value/u,
  );
});

test("a Human marks the interval where terminal input is active", () => {
  const state = human("What should happen?", { submitted: "done" });

  assert.equal(state.entry, "humanInputStarted");
  assert.equal(state.exit, "humanInputFinished");
});

test("a Human runner receives the request and supplies the answer without terminal input", async () => {
  const requests: import("../src/index.ts").HumanRequest[] = [];
  const example = machine({
    initial: "review",
    states: {
      review: human(
        "Choose the result",
        { submitted: "done" },
        { choices: ["approve", "deny"] },
      ),
      done: final(),
    },
  });

  const result = await run(example, {
    human: (request) => {
      requests.push(request);
      return "approve";
    },
  });

  assert.deepEqual(requests, [{
    prompt: "Choose the result",
    choices: ["approve", "deny"],
  }]);
  assert.equal(result.value, "done");
});

test("a Human runner cannot bypass restricted choices", async () => {
  const example = machine({
    initial: "review",
    states: {
      review: human(
        "Choose the result",
        { submitted: "done" },
        { choices: ["approve", "deny"] },
      ),
      done: final(),
    },
  });

  await assert.rejects(
    run(example, { human: () => "something else" }),
    /Human failed in state "review": Expected one of: approve, deny/u,
  );
});

test("a Human fails clearly when terminal input closes", async () => {
  const result = await runHumanExample("");

  assert.notEqual(result.exitCode, 0);
  assert.match(
    result.stderr,
    /Human failed in state "choose": Terminal input closed before a response/u,
  );
});

async function runHumanExample(input: string) {
  return runExampleWithInput("examples/human.ts", input);
}

async function runHumanChoices(input: string) {
  return runExampleWithInput("examples/choices.ts", input);
}

async function runExampleWithInput(file: string, input: string) {
  const child = spawn(process.execPath, [file], {
    cwd: process.cwd(),
    stdio: "pipe",
  });
  let stdout = "";
  let stderr = "";

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  child.stdin.end(input);

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });

  return { exitCode, stderr, stdout };
}

async function rejectedMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (cause) {
    assert.ok(cause instanceof Error);
    return cause.message;
  }
  assert.fail("Expected promise to reject");
}

test("an Operation event drives the Machine to a final state", async () => {
  const example = machine({
    initial: "calculate",
    states: {
      calculate: operation(
        () => ({ type: "completed" }),
        { completed: "done" },
      ),
      done: final(),
    },
  });

  const result = await run(example);

  assert.equal(result.status, "done");
  assert.equal(result.value, "done");
});

test("an unhandled Operation event identifies the state and event", async () => {
  const example = machine({
    initial: "calculate",
    states: {
      calculate: operation(
        () => ({ type: "unexpected" }),
        { completed: "done" },
      ),
      done: final(),
    },
  });

  await assert.rejects(
    run(example),
    /State "calculate" does not handle event "unexpected"/u,
  );
});

test("a thrown Operation identifies the state and cause", async () => {
  const example = machine({
    initial: "calculate",
    states: {
      calculate: operation(
        () => {
          throw new Error("division failed");
        },
        { completed: "done" },
      ),
      done: final(),
    },
  });

  await assert.rejects(
    run(example),
    /Operation failed in state "calculate": division failed/u,
  );
});

test("a missing target is rejected by XState", () => {
  assert.throws(
    () => machine({
      initial: "calculate",
      states: {
        calculate: operation(
          () => ({ type: "completed" }),
          { completed: "missing" },
        ),
      },
    }),
    /Child state 'missing' does not exist/u,
  );
});
