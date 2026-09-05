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
  type AgentRequest,
  agent,
  final,
  human,
  machine,
  operation,
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
