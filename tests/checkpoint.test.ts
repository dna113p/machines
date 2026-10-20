import "./environment.ts";

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";

import { startMachineHost } from "../src/host.ts";
import { readRunStatuses, type RunStatusRecord } from "../src/run-status.ts";

/** What a continued record says of its continuation, read loosely so the test names only what the ticket asks. */
type ContinuedRecord = RunStatusRecord & { readonly continued?: { readonly machineChanged?: boolean } };

interface Checkpoint {
  readonly schemaVersion: number;
  readonly id: string;
  readonly machine: { readonly name: string; readonly path: string; readonly sourceHash: string };
  readonly input: unknown;
  readonly state: { readonly value: unknown; readonly kind: string; readonly enteredAt: string };
  readonly data: unknown;
  readonly context: unknown;
  readonly writtenAt: string;
}

interface MachineShape {
  /** Adds a state the run never enters. */
  readonly extra?: boolean;
  /** Renames the Agent state `work` to `labour`. */
  readonly rename?: boolean;
}

const runtime = pathToFileURL(resolve("src/index.ts")).href;

/**
 * An Operation, an Agent and a second Operation. The first Operation saves
 * data, the Agent's prompt changes it as the Agent starts, and the second
 * Operation logs what it finds. The Agent hangs on its first call when
 * CHECKPOINT_HANG is set, so a test can stop the run while it is in that state.
 */
function machineSource(shape: MachineShape = {}): string {
  const work = shape.rename === true ? "labour" : "work";
  return `import { appendFileSync } from "node:fs";

export const description = "Saves data across an Agent state between two Operations.";

function unsaveable(kind) {
  if (kind === "function") return () => 1;
  if (kind === "undefined-in-array") return [1, undefined];
  if (kind === "class") return new (class Point { x = 1; })();
  return undefined;
}

export default function checkpointMachine(p, input) {
  const saved = p.data({ steps: [], count: 0 });
  return p.machine({
    initial: "first",
    states: {
      first: p.operation(() => {
        appendFileSync(input.log, "first\\n");
        saved.steps.push("first");
        saved.count += 1;
        if (input.bad !== undefined) saved.badKey = unsaveable(input.bad);
        return { type: "done" };
      }, { done: "${work}" }),
      ${work}: p.agent(() => {
        saved.count += 10;
        return "Do the fixture work.";
      }, { completed: "second" }),
      ${shape.extra === true ? `extra: p.operation(() => ({ type: "done" }), { done: "finished" }),` : ""}
      second: p.operation(() => {
        appendFileSync(input.log, "second " + JSON.stringify(saved) + "\\n");
        return { type: "done" };
      }, { done: "finished" }),
      finished: p.final(),
    },
  });
}
`;
}

const agentsSource = `import { appendFileSync, existsSync, readFileSync } from "node:fs";

import type { AgentRunner } from "${runtime}";

const runner: AgentRunner = async () => {
  const log = process.env.CHECKPOINT_LOG ?? "";
  const calls = existsSync(log) ? readFileSync(log, "utf8").split("\\n").filter((line) => line === "agent").length : 0;
  appendFileSync(log, "agent\\n");
  if (calls === 0 && process.env.CHECKPOINT_HANG === "1") {
    // Keeps the process alive until the test stops it.
    await new Promise(() => { setInterval(() => {}, 1_000); });
  }
  return { type: "completed" };
};

export default function agents() {
  return { default: { description: "Logs each call, and hangs on the first when asked.", runner } };
}
`;

interface Project {
  readonly root: string;
  readonly project: string;
  readonly machine: string;
  readonly status: string;
  readonly home: string;
  readonly log: string;
  readonly inputFile: string;
  readonly input: { readonly log: string; readonly bad?: string };
}

async function createProject(context: TestContext, bad?: string): Promise<Project> {
  const root = await mkdtemp(join(tmpdir(), "machines-checkpoint-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, "project");
  const home = join(root, "home");
  await mkdir(join(project, ".machines"), { recursive: true });
  await mkdir(home);
  const machine = join(project, ".machines", "checkpoint.ts");
  await writeFile(machine, machineSource());
  await writeFile(join(project, ".machines", "agents.ts"), agentsSource);
  const log = join(root, "log");
  const input = { log, ...(bad === undefined ? {} : { bad }) };
  const inputFile = join(root, "input.json");
  await writeFile(inputFile, JSON.stringify(input));
  return { root, project, machine, status: join(root, "status"), home, log, inputFile, input };
}

function environment(project: Project, extra: Readonly<Record<string, string | undefined>> = {}): NodeJS.ProcessEnv {
  const inherited = { ...process.env };
  for (const key of ["MACHINES_RUN_OWNER", "MACHINES_RUN_PARENT", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "PI_SESSION_ID"]) {
    delete inherited[key];
  }
  return {
    ...inherited,
    MACHINES_RUN_STATUS_DIR: project.status,
    MACHINES_USER_HOME: project.home,
    CHECKPOINT_LOG: project.log,
    ...extra,
  };
}

/** Starts `machine run checkpoint` in the project, stopped when the test ends. */
function startRun(context: TestContext, project: Project, extra: Readonly<Record<string, string | undefined>> = {}) {
  const child = spawn(process.execPath, [resolve("src/cli.ts"), "run", "checkpoint", "--input-file", project.inputFile], {
    cwd: project.project,
    env: environment(project, { CHECKPOINT_HANG: "1", ...extra }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.setEncoding("utf8").on("data", (text: string) => { output += text; });
  child.stderr.setEncoding("utf8").on("data", (text: string) => { output += text; });
  const exited = new Promise<number | null>((done) => { child.on("close", (code) => done(code)); });
  context.after(() => { child.kill("SIGKILL"); });
  return { child, exited, output: () => output };
}

function cli(project: Project, args: readonly string[], extra: Readonly<Record<string, string | undefined>> = {}) {
  return spawnSync(process.execPath, [resolve("src/cli.ts"), ...args], {
    cwd: project.project, encoding: "utf8", env: environment(project, extra),
  });
}

function logLines(project: Project): string[] {
  return existsSync(project.log) ? readFileSync(project.log, "utf8").split("\n").filter((line) => line !== "") : [];
}

function checkpointPath(project: Project, id: string): string {
  return join(project.status, `${id}.checkpoint.json`);
}

function readCheckpoint(project: Project, id: string): Checkpoint {
  return JSON.parse(readFileSync(checkpointPath(project, id), "utf8")) as Checkpoint;
}

async function checkpointFiles(directory: string): Promise<string[]> {
  try {
    const names = await readdir(directory, { recursive: true });
    return names.filter((name) => name.endsWith(".checkpoint.json"));
  } catch {
    return [];
  }
}

/** Runs the Machine until its Agent hangs, then stops the process, leaving the run where it was. */
async function stopInAgent(context: TestContext, project: Project): Promise<RunStatusRecord> {
  const started = startRun(context, project);
  await eventually(() => {
    assert.deepEqual(logLines(project), ["first", "agent"], started.output());
    const [current] = readRunStatuses(project.status);
    // The Agent logs before XState's observer publishes the state. Wait for
    // publication too, so stopping the process cannot interrupt that work.
    assert.equal(current?.state, "work");
    assert.equal(readCheckpoint(project, current.id).state.value, "work");
  });
  const [record, ...others] = readRunStatuses(project.status);
  assert.ok(record, started.output());
  assert.deepEqual(others, []);
  assert.equal(record.state, "work");
  started.child.kill("SIGKILL");
  await started.exited;
  return record;
}

test("a run stopped while its Agent runs continues as the same run: the Agent runs again, then the second Operation once", async (context) => {
  const project = await createProject(context);
  const started = startRun(context, project);
  await eventually(() => {
    assert.deepEqual(logLines(project), ["first", "agent"], started.output());
    const [current] = readRunStatuses(project.status);
    assert.equal(current?.state, "work");
    assert.equal(readCheckpoint(project, current.id).state.value, "work");
  });

  const [before] = readRunStatuses(project.status);
  assert.ok(before);
  // The checkpoint was written as the Agent state was entered, before its prompt changed the data.
  const checkpoint = readCheckpoint(project, before.id);
  assert.equal(checkpoint.schemaVersion, 2);
  // A run without children saves none.
  assert.equal("children" in checkpoint, false);
  assert.equal(checkpoint.id, before.id);
  assert.equal(checkpoint.machine.name, "checkpoint");
  assert.equal(checkpoint.machine.path, project.machine);
  assert.equal(typeof checkpoint.machine.sourceHash, "string");
  assert.notEqual(checkpoint.machine.sourceHash, "");
  // No copy of the Machine's source is kept.
  assert.doesNotMatch(JSON.stringify(checkpoint), /checkpointMachine|Saves data across/u);
  assert.deepEqual(checkpoint.input, project.input);
  assert.equal(checkpoint.state.value, "work");
  assert.equal(checkpoint.state.kind, "agent");
  assert.equal(new Date(checkpoint.state.enteredAt).toISOString(), checkpoint.state.enteredAt);
  assert.equal(new Date(checkpoint.writtenAt).toISOString(), checkpoint.writtenAt);
  assert.deepEqual(checkpoint.data, { steps: ["first"], count: 1 });
  assert.ok("context" in checkpoint);

  started.child.kill("SIGKILL");
  await started.exited;
  // The stopped run left its checkpoint whole.
  assert.deepEqual(readCheckpoint(project, before.id).data, { steps: ["first"], count: 1 });

  const continued = cli(project, ["continue", before.id]);
  assert.equal(continued.status, 0, continued.stderr);

  // The Agent was invoked a second time, with the data as it was when its state was
  // entered: its prompt adds 10 once more, to the saved 1. The first Operation did not run again.
  assert.deepEqual(logLines(project), ["first", "agent", "agent", 'second {"steps":["first"],"count":11}']);

  const [after, ...others] = readRunStatuses(project.status) as ContinuedRecord[];
  assert.deepEqual(others, []);
  assert.ok(after);
  assert.equal(after.id, before.id);
  assert.equal(after.startedAt, before.startedAt);
  assert.deepEqual({ status: after.status, state: after.state }, { status: "completed", state: "finished" });
  assert.equal(after.error, undefined);
  assert.notEqual(after.continued?.machineChanged, true);
  // The same trail goes on: what was entered before the stop is still its start.
  assert.deepEqual(after.trail?.slice(0, before.trail?.length ?? 0), before.trail ?? []);
  assert.deepEqual(after.trail?.map((step) => step.state).slice(-3), ["work", "second", "finished"]);

  // A run that reached its final state keeps no checkpoint.
  assert.deepEqual(await checkpointFiles(project.status), []);
});

test("a run continues on a Machine file that gained a state elsewhere, and its status says the Machine changed", async (context) => {
  const project = await createProject(context);
  const before = await stopInAgent(context, project);
  await writeFile(project.machine, machineSource({ extra: true }));

  const continued = cli(project, ["continue", before.id]);
  assert.equal(continued.status, 0, continued.stderr);
  assert.deepEqual(logLines(project), ["first", "agent", "agent", 'second {"steps":["first"],"count":11}']);
  const [after, ...others] = readRunStatuses(project.status) as ContinuedRecord[];
  assert.deepEqual(others, []);
  assert.equal(after?.id, before.id);
  assert.equal(after?.status, "completed");
  assert.equal(after?.continued?.machineChanged, true);
  assert.deepEqual(await checkpointFiles(project.status), []);
});

test("a version 1 checkpoint, written before checkpoints saved children, continues as the same run", async (context) => {
  const project = await createProject(context);
  const before = await stopInAgent(context, project);
  const written = readCheckpoint(project, before.id);
  assert.equal(written.schemaVersion, 2);
  await writeFile(checkpointPath(project, before.id), `${JSON.stringify({ ...written, schemaVersion: 1 })}\n`);

  const continued = cli(project, ["continue", before.id]);
  assert.equal(continued.status, 0, continued.stderr);
  assert.deepEqual(logLines(project), ["first", "agent", "agent", 'second {"steps":["first"],"count":11}']);
  const [after, ...others] = readRunStatuses(project.status) as ContinuedRecord[];
  assert.deepEqual(others, []);
  assert.deepEqual({ id: after?.id, status: after?.status, state: after?.state }, { id: before.id, status: "completed", state: "finished" });
  assert.notEqual(after?.continued?.machineChanged, true);
  assert.deepEqual(await checkpointFiles(project.status), []);
});

test("a run whose saved state was renamed in its Machine file is refused, and the error names the state", async (context) => {
  const project = await createProject(context);
  const before = await stopInAgent(context, project);
  await writeFile(project.machine, machineSource({ rename: true }));

  const continued = cli(project, ["continue", before.id]);
  assert.notEqual(continued.status, 0, continued.stdout);
  assert.match(continued.stderr, /\bwork\b/u);
  // Nothing ran: neither the Agent nor either Operation.
  assert.deepEqual(logLines(project), ["first", "agent"]);
  assert.notEqual(readRunStatuses(project.status)[0]?.status, "completed");
});

test("data that does not survive JSON fails the run with an error naming its key", async (context) => {
  for (const bad of ["function", "undefined-in-array", "class"]) {
    const project = await createProject(context, bad);
    const result = cli(project, ["run", "checkpoint", "--input-file", project.inputFile]);
    assert.notEqual(result.status, 0, `${bad}: ${result.stdout}`);
    assert.match(result.stderr, /badKey/u, bad);
    // The run stopped at the checkpoint it could not write: the Agent's state never finished.
    assert.equal(logLines(project).some((line) => line.startsWith("second")), false, bad);
    const [record] = readRunStatuses(project.status);
    assert.equal(record?.status, "failed", bad);
    assert.match(record?.error ?? "", /badKey/u, bad);
  }
});

test("a run that reached its final state cannot be continued, nor can an unknown run", async (context) => {
  const project = await createProject(context);
  const finished = cli(project, ["run", "checkpoint", "--input-file", project.inputFile]);
  assert.equal(finished.status, 0, finished.stderr);
  const [record] = readRunStatuses(project.status);
  assert.ok(record);
  assert.equal(record.status, "completed");
  const lines = logLines(project);
  assert.deepEqual(lines, ["first", "agent", 'second {"steps":["first"],"count":11}']);

  const continued = cli(project, ["continue", record.id]);
  assert.notEqual(continued.status, 0, continued.stdout);
  assert.notEqual(continued.stderr.trim(), "");
  assert.deepEqual(logLines(project), lines);
  assert.equal(readRunStatuses(project.status)[0]?.status, "completed");

  const unknown = cli(project, ["continue", "no-such-run"]);
  assert.notEqual(unknown.status, 0, unknown.stdout);
  assert.match(unknown.stderr, /no-such-run/u);
});

test("a run whose process is still alive cannot be continued", async (context) => {
  const project = await createProject(context);
  const started = startRun(context, project);
  await eventually(() => assert.deepEqual(logLines(project), ["first", "agent"], started.output()));
  const [record] = readRunStatuses(project.status);
  assert.ok(record);

  const continued = cli(project, ["continue", record.id]);
  assert.notEqual(continued.status, 0, continued.stdout);
  assert.notEqual(continued.stderr.trim(), "");
  // Nothing ran a second time, and the live run is untouched.
  assert.deepEqual(logLines(project), ["first", "agent"]);
  assert.equal(started.child.exitCode, null);
  const [after] = readRunStatuses(project.status);
  assert.deepEqual({ id: after?.id, pid: after?.pid, status: after?.status }, { id: record.id, pid: record.pid, status: "running" });
  assert.ok(existsSync(checkpointPath(project, record.id)));
});

test("with run status publication off, machine run writes no checkpoint and machine continue is refused", async (context) => {
  const project = await createProject(context);
  const started = startRun(context, project, { MACHINES_RUN_STATUS_DIR: "off" });
  await eventually(() => assert.deepEqual(logLines(project), ["first", "agent"], started.output()));
  assert.deepEqual(await checkpointFiles(project.root), []);
  assert.equal(existsSync(project.status), false);
  assert.deepEqual(await readdir(project.home), []);
  started.child.kill("SIGKILL");
  await started.exited;

  const continued = cli(project, ["continue", "any-run"], { MACHINES_RUN_STATUS_DIR: "off" });
  assert.notEqual(continued.status, 0, continued.stdout);
  assert.match(continued.stderr, /publication is off/u);
});

test("a hosted run writes a checkpoint only when its status is published, and the host can continue it as the same run", async (context) => {
  const project = await createProject(context);
  const saved = { ...process.env };
  context.after(() => {
    for (const key of ["MACHINES_RUN_STATUS_DIR", "CHECKPOINT_LOG", "CHECKPOINT_HANG"]) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });
  process.env.MACHINES_RUN_STATUS_DIR = project.status;
  process.env.CHECKPOINT_LOG = project.log;
  process.env.CHECKPOINT_HANG = "1";
  const location = { cwd: project.project, home: project.home, machine: "checkpoint", input: project.input };

  // Not asked to publish: nothing is recorded, so nothing can be continued.
  const unpublished = await startMachineHost(location);
  await eventually(() => assert.deepEqual(logLines(project), ["first", "agent"]));
  assert.deepEqual(await checkpointFiles(project.root), []);
  unpublished.terminate();
  await assert.rejects(unpublished.result);
  await rm(project.log);

  const first = await startMachineHost({ ...location, publishRunStatus: true });
  await eventually(() => assert.deepEqual(logLines(project), ["first", "agent"]));
  await eventually(() => assert.ok(existsSync(checkpointPath(project, first.id))));
  assert.deepEqual(readCheckpoint(project, first.id).data, { steps: ["first"], count: 1 });
  first.terminate();
  await assert.rejects(first.result);
  const [stopped] = readRunStatuses(project.status);
  assert.equal(stopped?.id, first.id);
  assert.ok(existsSync(checkpointPath(project, first.id)));

  const second = await startMachineHost({ continue: first.id, publishRunStatus: true });
  assert.equal(second.id, first.id);
  assert.deepEqual(await second.result, { state: "finished" });
  assert.deepEqual(logLines(project), ["first", "agent", "agent", 'second {"steps":["first"],"count":11}']);
  const [after, ...others] = readRunStatuses(project.status);
  assert.deepEqual(others, []);
  assert.deepEqual(
    { id: after?.id, startedAt: after?.startedAt, status: after?.status, error: after?.error },
    { id: first.id, startedAt: stopped?.startedAt, status: "completed", error: undefined },
  );
  assert.deepEqual(await checkpointFiles(project.status), []);
});

async function eventually(assertion: () => void): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (true) {
    try { assertion(); return; } catch (cause) {
      if (Date.now() >= deadline) throw cause;
      await new Promise((done) => setTimeout(done, 25));
    }
  }
}

test("presenter checkpoint history survives in-process sleep and continuation, including older checkpoints", async (context) => {
  const { prepareMachineRun } = await import("../src/launcher.ts");
  const { checkpointPath } = await import("../src/run-checkpoint.ts");
  const root = await mkdtemp(join(tmpdir(), "machines-presenter-history-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, ".machines");
  const status = join(root, "status");
  await mkdir(directory);
  await writeFile(join(root, "package.json"), '{"type":"module"}');
  await writeFile(join(directory, "agents.ts"), `
    export const prompts = [];
    export default () => ({
      default: { description: "Writes", runner: () => ({ type: "completed", summary: "Approved the release." }) },
      presenter: { description: "Explains", runner: (request) => {
        prompts.push(request.prompt);
        return { type: "presented", headline: "Ready to decide." };
      } },
    });
  `);
  await writeFile(join(directory, "briefed.ts"), `
    export const description = "Checks before asking two questions.";
    export const agentRoles = { presenter: { description: "Explains", optional: true } };
    export default ({ machine, agent, human, final }) => machine({
      initial: "work",
      states: {
        work: agent("Check", { completed: "first" }),
        first: human("First?", { submitted: "second" }, { choices: ["yes"], present: "presenter" }),
        second: human("Second?", { submitted: "done" }, {
          choices: ["yes"], present: "presenter", presentWith: () => "Second question facts",
        }),
        done: final(),
      },
    });
  `);
  const { prompts } = await import(pathToFileURL(join(directory, "agents.ts")).href) as { prompts: string[] };
  const location = { machine: "briefed", cwd: root, home: root };
  const requests: import("../src/index.ts").HumanRequest[] = [];
  const checkpoint = { directory: status, id: "presenter", sleep: true };
  const start = await prepareMachineRun(location);
  await start.start({ checkpoint, onHumanSleep: (request) => requests.push(request) });
  const saved = JSON.parse(readFileSync(checkpointPath(status, checkpoint.id), "utf8")) as import("../src/run-checkpoint.ts").RunCheckpoint;
  assert.deepEqual(saved.history, {
    trail: ["work", "first"],
    summaries: [{ state: "work", role: "default", summary: "Approved the release." }],
  });
  assert.equal(prompts.length, 1);
  assert.equal(requests[0]!.headline, "Ready to decide.");

  const continued = await prepareMachineRun({ ...location, continueRun: saved });
  await continued.start({ checkpoint, answer: "yes", onHumanSleep: (request) => requests.push(request) });
  assert.equal(prompts.length, 2);
  assert.match(prompts[1]!, /Approved the release/u);
  assert.match(prompts[1]!, /Second question facts/u);
  const next = JSON.parse(readFileSync(checkpointPath(status, checkpoint.id), "utf8")) as import("../src/run-checkpoint.ts").RunCheckpoint;
  assert.deepEqual(next.history?.trail, ["work", "first", "second"]);
  const finish = await prepareMachineRun({ ...location, continueRun: next });
  assert.equal((await finish.start({ checkpoint, answer: "yes" })).value, "done");
  assert.equal(prompts.length, 2);

  const { history: _history, ...older } = saved;
  const fromOlder = await prepareMachineRun({ ...location, continueRun: older });
  await fromOlder.start({ checkpoint, answer: "yes", onHumanSleep: (request) => requests.push(request) });
  assert.equal(prompts.length, 3);
  assert.doesNotMatch(prompts[2]!, /Approved the release/u);
  assert.match(prompts[2]!, /Second question facts/u);
});
