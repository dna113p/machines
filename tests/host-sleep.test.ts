import "./environment.ts";

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, type TestContext } from "node:test";

import { startMachineHost, type HostedHumanRequest, type MachineHostOptions, type MachineHostResult, type MachineHostRun } from "../src/host.ts";
import { readRunStatuses, type RunStatusRecord } from "../src/run-status.ts";
import { askerPrompt, askerSource, sleeperSource } from "./sleep-machines.ts";

/** What a sleeping record adds, read loosely so the test names only what the ticket asks. */
type SleepingRecord = Omit<RunStatusRecord, "status" | "human"> & {
  readonly status: string;
  readonly due?: string;
  readonly human?: RunStatusRecord["human"] & { readonly answer?: string };
};

/** What the host's result says about a run that slept, read loosely in the same way. */
type HostedResult = MachineHostResult & {
  readonly sleeping?: { readonly due?: string; readonly human?: HostedHumanRequest };
};

type HostOptions = MachineHostOptions & { readonly sleep?: boolean };

interface Checkpoint {
  readonly state: { readonly value: unknown; readonly kind: string; readonly due?: string };
  readonly sleep?: boolean;
}

interface Project {
  readonly root: string;
  readonly project: string;
  readonly status: string;
  readonly home: string;
}

/** One run's input: it logs to its own file. */
interface RunInput {
  readonly log: string;
  readonly file: string;
  readonly input: { readonly every: string; readonly checks: number; readonly log: string };
}

/** A run that does not settle within this time is waiting in its process instead of sleeping or finishing. */
const settleTimeout = 20_000;

async function createProject(context: TestContext): Promise<Project> {
  const root = await mkdtemp(join(tmpdir(), "machines-host-sleep-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, "project");
  const home = join(root, "home");
  await mkdir(join(project, ".machines"), { recursive: true });
  await mkdir(home);
  writeFileSync(join(project, ".machines", "sleeper.ts"), sleeperSource);
  writeFileSync(join(project, ".machines", "asker.ts"), askerSource);
  // Hosted runs publish where this process says, and each test has its own directory.
  const status = join(root, "status");
  const saved = process.env.MACHINES_RUN_STATUS_DIR;
  process.env.MACHINES_RUN_STATUS_DIR = status;
  context.after(() => {
    if (saved === undefined) delete process.env.MACHINES_RUN_STATUS_DIR;
    else process.env.MACHINES_RUN_STATUS_DIR = saved;
  });
  return { root, project, status, home };
}

function runInput(project: Project, name: string, every: string, checks = 1): RunInput {
  const log = join(project.root, `${name}.log`);
  const file = join(project.root, `${name}.json`);
  const input = { every, checks, log };
  writeFileSync(file, JSON.stringify(input));
  return { log, file, input };
}

function environment(project: Project): NodeJS.ProcessEnv {
  const inherited = { ...process.env };
  for (const key of ["MACHINES_RUN_OWNER", "MACHINES_RUN_PARENT", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "PI_SESSION_ID"]) {
    delete inherited[key];
  }
  return { ...inherited, MACHINES_RUN_STATUS_DIR: project.status, MACHINES_USER_HOME: project.home };
}

function cli(project: Project, args: readonly string[], timeout = 60_000) {
  return spawnSync(process.execPath, [resolve("src/cli.ts"), ...args], {
    cwd: project.project, encoding: "utf8", env: environment(project), timeout,
  });
}

function logLines(run: RunInput): string[] {
  return existsSync(run.log) ? readFileSync(run.log, "utf8").split("\n").filter((line) => line !== "") : [];
}

function records(project: Project): SleepingRecord[] {
  return readRunStatuses(project.status) as SleepingRecord[];
}

function recordOf(project: Project, id: string): SleepingRecord {
  const record = records(project).find((candidate) => candidate.id === id);
  assert.ok(record, `no status record for run ${id}`);
  return record;
}

function checkpointFile(project: Project, id: string): string {
  return join(project.status, `${id}.checkpoint.json`);
}

function readCheckpoint(project: Project, id: string): Checkpoint {
  return JSON.parse(readFileSync(checkpointFile(project, id), "utf8")) as Checkpoint;
}

async function until(time: number): Promise<void> {
  const left = time - Date.now();
  if (left > 0) await new Promise((done) => setTimeout(done, left + 50));
}

async function host(context: TestContext, options: HostOptions): Promise<MachineHostRun> {
  const run = await startMachineHost(options);
  context.after(() => { run.terminate(); });
  return run;
}

function hostedSleeper(project: Project, run: RunInput, sleep: boolean): HostOptions {
  return {
    machine: "sleeper", cwd: project.project, home: project.home, input: run.input, publishRunStatus: true,
    ...(sleep ? { sleep: true } : {}),
  };
}

function hostedAsker(project: Project, run: RunInput, extra: Partial<HostOptions>): HostOptions {
  return { machine: "asker", cwd: project.project, home: project.home, input: run.input, publishRunStatus: true, ...extra };
}

/** The run's result, or a failure when it neither sleeps nor finishes in time. */
async function settled(run: MachineHostRun, what: string): Promise<HostedResult> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new assert.AssertionError({
      message: `${what} kept its process waiting instead of sleeping or finishing`,
    })), settleTimeout);
  });
  try {
    return await Promise.race([run.result, late]) as HostedResult;
  } finally { clearTimeout(timer); }
}

/** Starts a run from the CLI and returns the one record it added. */
function cliRun(project: Project, args: readonly string[]): SleepingRecord {
  const known = new Set(records(project).map((record) => record.id));
  const ran = cli(project, args, settleTimeout);
  assert.equal(ran.error, undefined, `machine ${args.join(" ")} kept its process open: ${String(ran.error)}`);
  assert.equal(ran.status, 0, ran.stderr);
  const added = records(project).filter((record) => !known.has(record.id));
  assert.equal(added.length, 1, `machine ${args.join(" ")} did not add exactly one run`);
  return added[0]!;
}

function sleepingAt(project: Project, run: RunInput, name: "sleeper" | "asker"): SleepingRecord {
  const record = cliRun(project, ["run", name, "--sleep", "--input-file", run.file]);
  assert.equal(record.status, "sleeping");
  return record;
}

function answer(project: Project, record: SleepingRecord, response: string): void {
  const requestId = record.human?.requestId;
  assert.equal(typeof requestId, "string");
  const answered = cli(project, ["respond", record.id, requestId!, response], settleTimeout);
  assert.equal(answered.status, 0, answered.stderr);
  assert.equal(recordOf(project, record.id).human?.answer, response);
}

test("a hosted run with the sleep option sleeps at a Human request, machine respond answers it, and the host continues it with that answer", async (context) => {
  const project = await createProject(context);
  const run = runInput(project, "asker", "1h");
  const asked: HostedHumanRequest[] = [];
  const onHumanRequest = (request: HostedHumanRequest) => { asked.push(request); };

  const hosted = await host(context, hostedAsker(project, run, { sleep: true, onHumanRequest }));
  const result = await settled(hosted, "the hosted run with the sleep option");
  assert.equal(result.state, "ask");
  const request = result.sleeping?.human;
  assert.ok(request, `the result does not say the run sleeps at a Human request: ${JSON.stringify(result)}`);
  assert.equal(result.sleeping?.due, undefined);
  assert.equal(request.prompt, askerPrompt);
  assert.deepEqual(request.choices, ["approve", "deny"]);
  assert.equal(typeof request.requestId, "string");
  assert.notEqual(request.requestId, "");
  assert.deepEqual(logLines(run), []);

  // The record holds the same request, and nothing marks it as answered only by the host.
  const record = recordOf(project, hosted.id);
  assert.equal(record.status, "sleeping");
  assert.equal(record.state, "ask");
  assert.equal(record.human?.prompt, askerPrompt);
  assert.equal(record.human?.requestId, request.requestId);
  assert.equal(record.human?.answer, undefined);
  assert.equal(record.answeredBy, undefined);
  const checkpoint = readCheckpoint(project, hosted.id);
  assert.equal(checkpoint.state.kind, "human");
  assert.equal(checkpoint.sleep, true);

  // `machine respond` answers it once the host's run has ended, and the answer does not start the run.
  answer(project, record, "approve");
  await new Promise((done) => setTimeout(done, 300));
  assert.deepEqual(logLines(run), []);
  assert.equal(recordOf(project, hosted.id).status, "sleeping");

  const continued = await host(context, { continue: hosted.id, onHumanRequest });
  assert.equal(continued.id, hosted.id);
  const done = await settled(continued, "the continued hosted run");
  assert.equal(done.state, "finished");
  assert.equal(done.sleeping, undefined);
  assert.deepEqual(logLines(run), ["answer approve"]);
  assert.deepEqual(asked, [], "the host asked for the Human request instead of the run sleeping or using the answer");
  const after = recordOf(project, hosted.id);
  assert.deepEqual(
    { status: after.status, state: after.state, startedAt: after.startedAt, error: after.error },
    { status: "completed", state: "finished", startedAt: record.startedAt, error: undefined },
  );
  assert.equal(existsSync(checkpointFile(project, hosted.id)), false);
});

test("hosted sleep requires the host to publish run status", async (context) => {
  const project = await createProject(context);
  const run = runInput(project, "refused", "1h");
  const options = hostedAsker(project, run, { sleep: true });
  await assert.rejects(startMachineHost({ ...options, publishRunStatus: false }), /Cannot sleep/);
  await assert.rejects(startMachineHost({ ...options, publishRunStatus: undefined }), /Cannot sleep/);
  await assert.rejects(startMachineHost({ ...options, publishRunStatus: "caller" }), /Cannot sleep/);
  process.env.MACHINES_RUN_STATUS_DIR = "off";
  await assert.rejects(startMachineHost(options), /Cannot sleep/);
  assert.deepEqual(logLines(run), []);
});

test("a hosted run with the sleep option and a repeating timed wait sleeps again each time the host continues it", async (context) => {
  const project = await createProject(context);
  const run = runInput(project, "sleeper", "1s", 2);

  const hosted = await host(context, hostedSleeper(project, run, true));
  const first = await settled(hosted, "the hosted run with the sleep option");
  assert.equal(first.state, "rest");
  assert.equal(first.sleeping?.human, undefined);
  assert.equal(typeof first.sleeping?.due, "string", `the result does not say when the run is due: ${JSON.stringify(first)}`);
  const firstDue = Date.parse(first.sleeping!.due!);
  assert.ok(Number.isFinite(firstDue), `due "${first.sleeping!.due}" is not a time`);
  assert.deepEqual(logLines(run), []);
  const record = recordOf(project, hosted.id);
  assert.deepEqual({ status: record.status, state: record.state, due: record.due }, { status: "sleeping", state: "rest", due: first.sleeping!.due });
  assert.equal(readCheckpoint(project, hosted.id).sleep, true);

  // Continued through the host without the option: the checkpoint's sleep setting holds, and it sleeps again.
  await until(firstDue);
  const again = await host(context, { continue: hosted.id });
  assert.equal(again.id, hosted.id);
  const second = await settled(again, "the continued hosted run");
  assert.deepEqual(logLines(run), ["check 1"]);
  assert.equal(second.state, "rest");
  assert.equal(typeof second.sleeping?.due, "string", `the continued run's result does not say it sleeps again: ${JSON.stringify(second)}`);
  const secondDue = Date.parse(second.sleeping!.due!);
  assert.ok(secondDue > firstDue, `the next due time ${second.sleeping!.due} is not later than ${first.sleeping!.due}`);
  const slept = recordOf(project, hosted.id);
  assert.deepEqual({ status: slept.status, state: slept.state, due: slept.due }, { status: "sleeping", state: "rest", due: second.sleeping!.due });
  assert.equal(readCheckpoint(project, hosted.id).sleep, true);

  await until(secondDue);
  const last = await host(context, { continue: hosted.id });
  const done = await settled(last, "the last continuation");
  assert.equal(done.state, "finished");
  assert.equal(done.sleeping, undefined);
  assert.deepEqual(logLines(run), ["check 1", "check 2"]);
  assert.equal(recordOf(project, hosted.id).status, "completed");
  assert.equal(existsSync(checkpointFile(project, hosted.id)), false);
});

test("without the sleep option, a hosted run's Human request is answered through its host", async (context) => {
  const project = await createProject(context);
  const run = runInput(project, "asker", "1h");
  let asked!: (request: HostedHumanRequest) => void;
  const requested = new Promise<HostedHumanRequest>((done) => { asked = done; });

  const hosted = await host(context, hostedAsker(project, run, { onHumanRequest: (request) => asked(request) }));
  const request = await Promise.race([
    requested,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("the host never asked")), settleTimeout)),
  ]);
  assert.equal(request.prompt, askerPrompt);
  const record = recordOf(project, hosted.id);
  assert.deepEqual({ status: record.status, answeredBy: record.answeredBy }, { status: "waiting", answeredBy: "host" });

  // Only the host answers it.
  const refused = cli(project, ["respond", hosted.id, request.requestId, "approve"], settleTimeout);
  assert.equal(refused.status, 1, `machine respond answered a hosted run: ${refused.stdout}`);
  assert.deepEqual(logLines(run), []);

  await hosted.respond("approve", request.requestId);
  const done = await settled(hosted, "the hosted run");
  assert.equal(done.state, "finished");
  assert.equal(done.sleeping, undefined);
  assert.deepEqual(logLines(run), ["answer approve"]);
  assert.equal(recordOf(project, hosted.id).status, "completed");
});

test("a host can explicitly disable sleep when continuing a sleeping run", async (context) => {
  const project = await createProject(context);
  const run = runInput(project, "override", "1s", 2);
  const hosted = await host(context, hostedSleeper(project, run, true));
  const first = await settled(hosted, "the hosted run with the sleep option");
  assert.ok(first.sleeping?.due);
  await until(Date.parse(first.sleeping.due));
  const continued = await host(context, { continue: hosted.id, sleep: false });
  const done = await settled(continued, "the continued run with sleep disabled");
  assert.equal(done.state, "finished");
  assert.equal(done.sleeping, undefined);
  assert.deepEqual(logLines(run), ["check 1", "check 2"]);
});

test("machine continue --due succeeds when no sleeping runs are eligible", async (context) => {
  const project = await createProject(context);
  const result = cli(project, ["continue", "--due"]);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /No sleeping runs are due/);
});

test("machine continue --due continues every answered or due sleeping run, and none that is neither or that a host started", async (context) => {
  const project = await createProject(context);
  const answeredRun = runInput(project, "answered", "1h");
  const dueRun = runInput(project, "due", "1s");
  const unansweredRun = runInput(project, "unanswered", "1h");
  const laterRun = runInput(project, "later", "1h");
  const hostedRun = runInput(project, "hosted", "1s");

  const answered = sleepingAt(project, answeredRun, "asker");
  answer(project, answered, "approve");
  const due = sleepingAt(project, dueRun, "sleeper");
  const unanswered = sleepingAt(project, unansweredRun, "asker");
  const later = sleepingAt(project, laterRun, "sleeper");
  const hosted = await host(context, hostedSleeper(project, hostedRun, true));
  const slept = await settled(hosted, "the hosted run with the sleep option");
  assert.equal(typeof slept.sleeping?.due, "string", `the hosted run did not sleep: ${JSON.stringify(slept)}`);
  assert.equal(recordOf(project, hosted.id).status, "sleeping");

  await until(Math.max(Date.parse(due.due!), Date.parse(slept.sleeping!.due!)));
  const untouched = [unanswered.id, later.id, hosted.id];
  const before = untouched.map((id) => ({ record: recordOf(project, id), checkpoint: readFileSync(checkpointFile(project, id), "utf8") }));

  const woken = cli(project, ["continue", "--due"], 120_000);
  assert.equal(woken.error, undefined, String(woken.error));
  assert.equal(woken.status, 0, `${woken.stdout}${woken.stderr}`);

  assert.deepEqual(logLines(answeredRun), ["answer approve"]);
  assert.deepEqual(logLines(dueRun), ["check 1"]);
  for (const id of [answered.id, due.id]) {
    const after = recordOf(project, id);
    assert.deepEqual({ status: after.status, state: after.state }, { status: "completed", state: "finished" }, `run ${id}`);
  }
  assert.deepEqual(logLines(unansweredRun), []);
  assert.deepEqual(logLines(laterRun), []);
  assert.deepEqual(logLines(hostedRun), [], "machine continue --due woke a run its host started");
  assert.deepEqual(
    untouched.map((id) => ({ record: recordOf(project, id), checkpoint: readFileSync(checkpointFile(project, id), "utf8") })),
    before,
  );
});

test("machine continue --due goes on past a run that fails, reports it, and exits nonzero", async (context) => {
  const project = await createProject(context);
  const failingRun = runInput(project, "failing", "1h");
  const dueRun = runInput(project, "due", "1s");

  // The failing run comes first, so the other is continued after the failure.
  const failing = sleepingAt(project, failingRun, "asker");
  answer(project, failing, "approve");
  writeFileSync(checkpointFile(project, failing.id), "{}");
  const due = sleepingAt(project, dueRun, "sleeper");

  await until(Date.parse(due.due!));
  const woken = cli(project, ["continue", "--due"], 120_000);
  assert.equal(woken.error, undefined, String(woken.error));
  assert.notEqual(woken.status, 0, `a failed continuation was not reported in the exit status: ${woken.stdout}${woken.stderr}`);
  assert.ok(woken.stderr.includes(failing.id), `the failed run is not named: ${woken.stderr}`);

  assert.deepEqual(logLines(failingRun), []);
  assert.deepEqual(logLines(dueRun), ["check 1"]);
  const after = recordOf(project, due.id);
  assert.deepEqual({ status: after.status, state: after.state }, { status: "completed", state: "finished" });
});
