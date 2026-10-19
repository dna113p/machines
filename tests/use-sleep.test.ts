import "./environment.ts";

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, type TestContext } from "node:test";

import { readRunStatuses, type RunStatusRecord } from "../src/run-status.ts";
import { approverPrompt, approverSource, composerSource, napperSource, relaySource } from "./sleep-machines.ts";

/** What a sleeping or continued record adds, read loosely so the test names only what the ticket asks. */
type SleepingRecord = Omit<RunStatusRecord, "status" | "human"> & {
  readonly status: string;
  readonly due?: string;
  readonly human?: RunStatusRecord["human"] & { readonly answer?: string };
  readonly continued?: { readonly machineChanged?: boolean };
};

interface SavedLevel {
  readonly machine: { readonly name?: string; readonly path: string; readonly sourceHash: string };
  readonly input: unknown;
  readonly state: { readonly value: unknown; readonly kind: string; readonly due?: string };
  readonly data: unknown;
  readonly context?: unknown;
  readonly children?: readonly SavedLevel[];
}

type Checkpoint = SavedLevel & { readonly schemaVersion: number; readonly sleep?: boolean };

interface Project {
  readonly root: string;
  readonly project: string;
  readonly status: string;
  readonly home: string;
  readonly log: string;
  readonly inputFile: string;
  readonly input: { readonly log: string; readonly every: string; readonly outcome: string };
  /** Each Machine file by its name, without `.ts`. */
  readonly files: Readonly<Record<string, string>>;
}

/**
 * Top-level Machines in `.machines/`, each running a child from `parts/`:
 * `nap-parent` → napper, `ask-parent` → approver, and the two-deep
 * `nap-grandparent` → nap-relay → napper and `ask-grandparent` → ask-relay → approver.
 */
async function createProject(context: TestContext, input: { readonly every: string; readonly outcome: string }): Promise<Project> {
  const root = await mkdtemp(join(tmpdir(), "machines-use-sleep-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, "project");
  const home = join(root, "home");
  await mkdir(join(project, ".machines"), { recursive: true });
  await mkdir(join(project, "parts"));
  await mkdir(home);
  writeFileSync(join(project, "package.json"), '{"type":"module"}');
  const files = {
    "nap-parent": join(project, ".machines", "nap-parent.ts"),
    "ask-parent": join(project, ".machines", "ask-parent.ts"),
    "nap-grandparent": join(project, ".machines", "nap-grandparent.ts"),
    "ask-grandparent": join(project, ".machines", "ask-grandparent.ts"),
    napper: join(project, "parts", "napper.ts"),
    approver: join(project, "parts", "approver.ts"),
    "nap-relay": join(project, "parts", "nap-relay.ts"),
    "ask-relay": join(project, "parts", "ask-relay.ts"),
  };
  writeFileSync(files["nap-parent"], composerSource("../parts/napper.ts", "rested", "restless"));
  writeFileSync(files["ask-parent"], composerSource("../parts/approver.ts", "approved", "denied"));
  writeFileSync(files["nap-grandparent"], composerSource("../parts/nap-relay.ts", "passed", "stopped"));
  writeFileSync(files["ask-grandparent"], composerSource("../parts/ask-relay.ts", "passed", "stopped"));
  writeFileSync(files.napper, napperSource);
  writeFileSync(files.approver, approverSource);
  writeFileSync(files["nap-relay"], relaySource("./napper.ts", "rested", "restless"));
  writeFileSync(files["ask-relay"], relaySource("./approver.ts", "approved", "denied"));
  const log = join(root, "log");
  const inputFile = join(root, "input.json");
  const saved = { log, ...input };
  writeFileSync(inputFile, JSON.stringify(saved));
  return { root, project, status: join(root, "status"), home, log, inputFile, input: saved, files };
}

function environment(project: Project): NodeJS.ProcessEnv {
  const inherited = { ...process.env };
  for (const key of ["MACHINES_RUN_OWNER", "MACHINES_RUN_PARENT", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "PI_SESSION_ID"]) {
    delete inherited[key];
  }
  return { ...inherited, MACHINES_RUN_STATUS_DIR: project.status, MACHINES_USER_HOME: project.home };
}

/** A run that does not end within this time is waiting in its process instead of sleeping or finishing. */
const timeout = 30_000;

function cli(project: Project, args: readonly string[]) {
  return spawnSync(process.execPath, [resolve("src/cli.ts"), ...args], {
    cwd: project.project, encoding: "utf8", env: environment(project), timeout,
  });
}

function runSleeping(project: Project, machine: string): void {
  const ran = cli(project, ["run", machine, "--sleep", "--input-file", project.inputFile]);
  assert.equal(ran.error, undefined, `the run kept its process open inside its child: ${String(ran.error)}`);
  assert.equal(ran.status, 0, ran.stderr);
}

function logLines(project: Project): string[] {
  return existsSync(project.log) ? readFileSync(project.log, "utf8").split("\n").filter((line) => line !== "") : [];
}

function onlyRecord(project: Project): SleepingRecord {
  const [record, ...others] = readRunStatuses(project.status) as SleepingRecord[];
  assert.ok(record, "no status record");
  assert.deepEqual(others, []);
  return record;
}

function checkpointFile(project: Project, id: string): string {
  return join(project.status, `${id}.checkpoint.json`);
}

function readCheckpoint(project: Project, id: string): Checkpoint {
  return JSON.parse(readFileSync(checkpointFile(project, id), "utf8")) as Checkpoint;
}

/** Every file in the status directory with its contents. */
function statusFiles(project: Project): Record<string, string> {
  if (!existsSync(project.status)) return {};
  const names = readdirSync(project.status, { recursive: true, encoding: "utf8" }).sort();
  return Object.fromEntries(names.flatMap((name) => {
    const path = join(project.status, name);
    try { return [[name, readFileSync(path, "utf8")]]; } catch { return []; }
  }));
}

function sourceHash(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** The one saved child of a level, with the path and source hash of its Machine file. */
function onlyChild(level: SavedLevel, path: string): SavedLevel {
  assert.ok(Array.isArray(level.children), `no children saved under ${JSON.stringify(level.state.value)}: ${JSON.stringify(level)}`);
  assert.equal(level.children.length, 1);
  const [child] = level.children;
  assert.ok(child);
  assert.equal(child.machine.path, path);
  assert.equal(child.machine.sourceHash, sourceHash(path));
  assert.ok("context" in child, "the child's context is not saved");
  return child;
}

/** The parent's own level at its use state, as the top of a version 2 sleeping checkpoint. */
function assertParentLevel(project: Project, id: string, machine: string): Checkpoint {
  const checkpoint = readCheckpoint(project, id);
  assert.equal(checkpoint.schemaVersion, 2);
  assert.equal(checkpoint.sleep, true);
  assert.equal(checkpoint.machine.path, project.files[machine]);
  assert.equal(checkpoint.state.value, "delegate");
  assert.deepEqual(checkpoint.data, { steps: ["before"], received: null });
  return checkpoint;
}

/** Asserts the run is asleep until a valid due time, with its process ended. */
function assertSleepingUntilDue(project: Project): { readonly record: SleepingRecord; readonly due: number } {
  const record = onlyRecord(project);
  assert.equal(record.status, "sleeping");
  assert.equal(record.human, undefined);
  assert.equal(typeof record.due, "string");
  const due = Date.parse(record.due ?? "");
  assert.ok(Number.isFinite(due), `due "${record.due}" is not a time`);
  return { record, due };
}

/** Asserts the run is asleep at the child's Human request, and returns the request's id. */
function assertSleepingForAnswer(project: Project): { readonly record: SleepingRecord; readonly requestId: string } {
  const record = onlyRecord(project);
  assert.equal(record.status, "sleeping");
  assert.equal(record.due, undefined);
  assert.equal(record.human?.prompt, approverPrompt);
  assert.deepEqual(record.human?.choices, ["approve", "deny"]);
  const requestId = record.human?.requestId;
  assert.equal(typeof requestId, "string");
  assert.notEqual(requestId, "");
  return { record, requestId: requestId! };
}

/** Asserts the run finished as the same run, in `state`, on an unchanged Machine, and kept no checkpoint. */
function assertFinished(project: Project, before: SleepingRecord, state: string, machineChanged = false): void {
  const after = onlyRecord(project);
  assert.equal(after.id, before.id);
  assert.equal(after.startedAt, before.startedAt);
  assert.deepEqual({ status: after.status, state: after.state, error: after.error }, { status: "completed", state, error: undefined });
  assert.equal(after.continued?.machineChanged, machineChanged);
  assert.equal(existsSync(checkpointFile(project, before.id)), false);
}

async function until(time: number): Promise<void> {
  const left = time - Date.now();
  if (left > 0) await new Promise((done) => setTimeout(done, left + 50));
}

/** Answers the run's request with `answer`; the run stays asleep and nothing runs. */
function respond(project: Project, record: SleepingRecord, requestId: string, answer: string): void {
  const lines = logLines(project);
  const answered = cli(project, ["respond", record.id, requestId, answer]);
  assert.equal(answered.status, 0, answered.stderr);
  const marked = onlyRecord(project);
  assert.equal(marked.status, "sleeping");
  assert.equal(marked.human?.answer, answer);
  assert.deepEqual(logLines(project), lines);
}

test("a run sleeps at a child's timed wait, refuses to wake early, continues there when due and routes on the child's ending", async (context) => {
  const project = await createProject(context, { every: "3s", outcome: "rested" });
  const started = Date.now();
  runSleeping(project, "nap-parent");
  // Nothing ran past the child's wait, and the process ended without waiting for it.
  assert.deepEqual(logLines(project), ["parent start", "child start"]);
  const { record, due } = assertSleepingUntilDue(project);
  assert.ok(due >= started + 2_500, `due ${record.due} is not about 3s after the run started`);
  assert.ok(Date.now() < due, "the run waited in its process instead of sleeping");

  // The parent is saved at its use state, and the child under children at its wait.
  const checkpoint = assertParentLevel(project, record.id, "nap-parent");
  const child = onlyChild(checkpoint, project.files.napper!);
  assert.deepEqual(child.input, project.input);
  assert.deepEqual({ value: child.state.value, kind: child.state.kind, due: child.state.due }, { value: "rest", kind: "wait", due: record.due });
  assert.deepEqual(child.data, { naps: 1, note: "child before" });
  assert.equal(child.children, undefined);

  // Before it is due: the due time is reported, and nothing changes.
  const before = statusFiles(project);
  const early = cli(project, ["continue", record.id]);
  assert.ok(Date.now() < due, "this machine was too slow to continue before the wait was due");
  assert.equal(early.status, 0, early.stderr);
  assert.ok(`${early.stdout}${early.stderr}`.includes(record.due ?? ""), `the due time is not reported: ${early.stdout}${early.stderr}`);
  assert.deepEqual(logLines(project), ["parent start", "child start"]);
  assert.deepEqual(statusFiles(project), before);

  // Once due: the child takes `due` from its saved state, ends `rested`, and the parent routes on that ending.
  await until(due);
  const woken = cli(project, ["continue", record.id]);
  assert.equal(woken.status, 0, woken.stderr);
  assert.deepEqual(logLines(project), [
    "parent start", "child start",
    'child wake {"naps":1,"note":"child before"}',
    'parent after {"steps":["before"],"received":{"naps":1}}',
  ]);
  assertFinished(project, record, "finished");
});

test("a run sleeps at a child's Human request; the record holds the child's request, and respond and continue deliver the answer to the child", async (context) => {
  const project = await createProject(context, { every: "1h", outcome: "" });
  runSleeping(project, "ask-parent");
  assert.deepEqual(logLines(project), ["parent start", "child start"]);
  const { record, requestId } = assertSleepingForAnswer(project);

  const checkpoint = assertParentLevel(project, record.id, "ask-parent");
  const child = onlyChild(checkpoint, project.files.approver!);
  assert.deepEqual(child.input, project.input);
  assert.deepEqual({ value: child.state.value, kind: child.state.kind }, { value: "ask", kind: "human" });
  assert.deepEqual(child.data, { answer: "", note: "child before" });

  // Unanswered: continue reports the child's request and changes nothing.
  const asleep = statusFiles(project);
  const early = cli(project, ["continue", record.id]);
  assert.equal(early.status, 0, early.stderr);
  assert.ok(`${early.stdout}${early.stderr}`.includes(approverPrompt), `the child's request is not reported: ${early.stdout}${early.stderr}`);
  assert.deepEqual(statusFiles(project), asleep);

  respond(project, record, requestId, "approve");
  const woken = cli(project, ["continue", record.id]);
  assert.equal(woken.error, undefined, `continue asked again instead of using the answer: ${String(woken.error)}`);
  assert.equal(woken.status, 0, woken.stderr);
  assert.ok(!`${woken.stdout}${woken.stderr}`.includes(approverPrompt), `the prompt was shown again: ${woken.stdout}${woken.stderr}`);
  assert.deepEqual(logLines(project), [
    "parent start", "child start",
    'child answer {"answer":"approve","note":"child before"}',
    'parent after {"steps":["before"],"received":{"answer":"approve"}}',
  ]);
  assertFinished(project, record, "finished");
});

test("a run sleeps at a timed wait two levels down and continues there when due, routing each level on its child's ending", async (context) => {
  const project = await createProject(context, { every: "3s", outcome: "restless" });
  runSleeping(project, "nap-grandparent");
  assert.deepEqual(logLines(project), ["parent start", "middle start", "child start"]);
  const { record, due } = assertSleepingUntilDue(project);
  assert.ok(Date.now() < due, "the run waited in its process instead of sleeping");

  const checkpoint = assertParentLevel(project, record.id, "nap-grandparent");
  const middle = onlyChild(checkpoint, project.files["nap-relay"]!);
  assert.equal(middle.state.value, "inner");
  const child = onlyChild(middle, project.files.napper!);
  assert.deepEqual({ value: child.state.value, kind: child.state.kind, due: child.state.due }, { value: "rest", kind: "wait", due: record.due });

  const early = cli(project, ["continue", record.id]);
  assert.ok(Date.now() < due, "this machine was too slow to continue before the wait was due");
  assert.equal(early.status, 0, early.stderr);
  assert.deepEqual(logLines(project), ["parent start", "middle start", "child start"]);

  await until(due);
  const woken = cli(project, ["continue", record.id]);
  assert.equal(woken.status, 0, woken.stderr);
  // The child ends `restless`, the middle `stopped`, and the parent gives up.
  assert.deepEqual(logLines(project), [
    "parent start", "middle start", "child start",
    'child wake {"naps":1,"note":"child before"}',
    'middle after {"relays":1,"outcome":"stopped"}',
    'parent gave up {"steps":["before"],"received":null}',
  ]);
  assertFinished(project, record, "stopped");
});

test("a run sleeps at a Human request two levels down; respond and continue deliver the answer to the deepest child", async (context) => {
  const project = await createProject(context, { every: "1h", outcome: "" });
  runSleeping(project, "ask-grandparent");
  assert.deepEqual(logLines(project), ["parent start", "middle start", "child start"]);
  const { record, requestId } = assertSleepingForAnswer(project);

  const checkpoint = assertParentLevel(project, record.id, "ask-grandparent");
  const middle = onlyChild(checkpoint, project.files["ask-relay"]!);
  assert.equal(middle.state.value, "inner");
  const child = onlyChild(middle, project.files.approver!);
  assert.deepEqual({ value: child.state.value, kind: child.state.kind }, { value: "ask", kind: "human" });

  respond(project, record, requestId, "deny");
  const woken = cli(project, ["continue", record.id]);
  assert.equal(woken.error, undefined, `continue asked again instead of using the answer: ${String(woken.error)}`);
  assert.equal(woken.status, 0, woken.stderr);
  assert.deepEqual(logLines(project), [
    "parent start", "middle start", "child start",
    'child answer {"answer":"deny","note":"child before"}',
    'middle after {"relays":1,"outcome":"stopped"}',
    'parent gave up {"steps":["before"],"received":null}',
  ]);
  assertFinished(project, record, "stopped");
});

test("each child's p.data() is restored after continuation, separately from its parent's", async (context) => {
  const project = await createProject(context, { every: "1s", outcome: "rested" });
  runSleeping(project, "nap-grandparent");
  const { record, due } = assertSleepingUntilDue(project);

  // Each level saves only its own data.
  const checkpoint = assertParentLevel(project, record.id, "nap-grandparent");
  const middle = onlyChild(checkpoint, project.files["nap-relay"]!);
  assert.deepEqual(middle.data, { relays: 1, outcome: "" });
  const child = onlyChild(middle, project.files.napper!);
  assert.deepEqual(child.data, { naps: 1, note: "child before" });

  await until(due);
  const woken = cli(project, ["continue", record.id]);
  assert.equal(woken.status, 0, woken.stderr);
  // Each level sees its own saved data, not its factory's initial data nor another level's.
  assert.deepEqual(logLines(project), [
    "parent start", "middle start", "child start",
    'child wake {"naps":1,"note":"child before"}',
    'middle after {"relays":1,"outcome":"passed"}',
    'parent after {"steps":["before"],"received":null}',
  ]);
  assertFinished(project, record, "finished");
});

test("continuing after a child's source changed reports the Machine changed, at one level and two levels down", async (context) => {
  for (const machine of ["ask-parent", "ask-grandparent"]) {
    const project = await createProject(context, { every: "1h", outcome: "" });
    runSleeping(project, machine);
    const { record, requestId } = assertSleepingForAnswer(project);
    respond(project, record, requestId, "approve");
    // Only the deepest child's file changes; the top-level Machine is unchanged.
    appendFileSync(project.files.approver!, "\n// Changed while the run slept.\n");

    const woken = cli(project, ["continue", record.id]);
    assert.equal(woken.status, 0, `${machine}: ${woken.stderr}`);
    assert.match(woken.stderr, /changed Machine/u, machine);
    assert.ok(logLines(project).includes('child answer {"answer":"approve","note":"child before"}'), machine);
    assertFinished(project, record, "finished", true);
  }
});
