import "./environment.ts";

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, type TestContext } from "node:test";

import { readRunStatuses, type RunStatusRecord } from "../src/run-status.ts";
import { askerPrompt, askerSource, sleeperSource } from "./sleep-machines.ts";

/** What a sleeping record adds, read loosely so the test names only what the ticket asks. */
type SleepingRecord = Omit<RunStatusRecord, "status" | "human"> & {
  readonly status: string;
  readonly due?: string;
  readonly human?: RunStatusRecord["human"] & { readonly answer?: string };
};

interface Checkpoint {
  readonly state: { readonly value: unknown; readonly kind: string; readonly due?: string };
  readonly sleep?: boolean;
  readonly data: unknown;
}

interface Project {
  readonly root: string;
  readonly project: string;
  readonly status: string;
  readonly home: string;
  readonly log: string;
  readonly inputFile: string;
}

async function createProject(context: TestContext, input: { readonly every: string | number; readonly checks: number }): Promise<Project> {
  const root = await mkdtemp(join(tmpdir(), "machines-sleep-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, "project");
  const home = join(root, "home");
  await mkdir(join(project, ".machines"), { recursive: true });
  await mkdir(home);
  writeFileSync(join(project, ".machines", "sleeper.ts"), sleeperSource);
  writeFileSync(join(project, ".machines", "asker.ts"), askerSource);
  const log = join(root, "log");
  const inputFile = join(root, "input.json");
  writeFileSync(inputFile, JSON.stringify({ ...input, log }));
  return { root, project, status: join(root, "status"), home, log, inputFile };
}

function environment(project: Project, extra: Readonly<Record<string, string | undefined>> = {}): NodeJS.ProcessEnv {
  const inherited = { ...process.env };
  for (const key of ["MACHINES_RUN_OWNER", "MACHINES_RUN_PARENT", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "PI_SESSION_ID"]) {
    delete inherited[key];
  }
  return { ...inherited, MACHINES_RUN_STATUS_DIR: project.status, MACHINES_USER_HOME: project.home, ...extra };
}

function cli(project: Project, args: readonly string[], extra: Readonly<Record<string, string | undefined>> = {}, timeout = 60_000) {
  return spawnSync(process.execPath, [resolve("src/cli.ts"), ...args], {
    cwd: project.project, encoding: "utf8", env: environment(project, extra), timeout,
  });
}

function runArgs(project: Project, sleep: boolean): string[] {
  return ["run", "sleeper", ...(sleep ? ["--sleep"] : []), "--input-file", project.inputFile];
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

/** Asserts the run is asleep at its wait: its process has ended, and it is due at a valid time. */
function assertSleeping(project: Project): { readonly record: SleepingRecord; readonly due: number } {
  const record = onlyRecord(project);
  assert.equal(record.status, "sleeping");
  assert.equal(record.state, "rest");
  assert.equal(typeof record.due, "string");
  const due = Date.parse(record.due ?? "");
  assert.ok(Number.isFinite(due), `due "${record.due}" is not a time`);
  assert.equal(new Date(due).toISOString(), record.due);
  const checkpoint = readCheckpoint(project, record.id);
  assert.equal(checkpoint.state.value, "rest");
  assert.equal(checkpoint.state.kind, "wait");
  assert.equal(checkpoint.state.due, record.due);
  assert.equal(checkpoint.sleep, true);
  return { record, due };
}

async function until(time: number): Promise<void> {
  const left = time - Date.now();
  if (left > 0) await new Promise((done) => setTimeout(done, left + 50));
}

test("a run started with --sleep ends its process at a timed wait, refuses to wake early, and takes `due` once it is due", async (context) => {
  const project = await createProject(context, { every: "3s", checks: 1 });
  const started = Date.now();
  const ran = cli(project, runArgs(project, true));
  assert.equal(ran.status, 0, ran.stderr);
  // Nothing ran past the wait, and the process ended without waiting for it.
  assert.deepEqual(logLines(project), []);
  const { record, due } = assertSleeping(project);
  assert.ok(due >= started + 2_500, `due ${record.due} is not about 3s after the run started`);
  assert.ok(Date.now() < due, "the run waited in its process instead of sleeping");

  // Before it is due: the due time is reported, and nothing changes.
  const before = statusFiles(project);
  const early = cli(project, ["continue", record.id]);
  assert.ok(Date.now() < due, "this machine was too slow to continue before the wait was due");
  assert.equal(early.status, 0, early.stderr);
  assert.ok(`${early.stdout}${early.stderr}`.includes(record.due ?? ""), `the due time is not reported: ${early.stdout}${early.stderr}`);
  assert.deepEqual(logLines(project), []);
  assert.deepEqual(statusFiles(project), before);

  // Once it is due: the `due` transition is taken, and the run completes as the same run.
  await until(due);
  const woken = cli(project, ["continue", record.id]);
  assert.equal(woken.status, 0, woken.stderr);
  assert.deepEqual(logLines(project), ["check 1"]);
  const after = onlyRecord(project);
  assert.equal(after.id, record.id);
  assert.equal(after.startedAt, record.startedAt);
  assert.deepEqual({ status: after.status, state: after.state, error: after.error }, { status: "completed", state: "finished", error: undefined });
  assert.equal(existsSync(checkpointFile(project, record.id)), false);
});

test("a repeating timed wait sleeps again after each wake, with a later due time, until the run finishes", async (context) => {
  const project = await createProject(context, { every: "1s", checks: 2 });
  const ran = cli(project, runArgs(project, true));
  assert.equal(ran.status, 0, ran.stderr);
  const first = assertSleeping(project);
  assert.deepEqual(logLines(project), []);

  await until(first.due);
  const woken = cli(project, ["continue", first.record.id]);
  assert.equal(woken.status, 0, woken.stderr);
  // The check ran, and the continuation slept again at the next wait instead of waiting in its process.
  assert.deepEqual(logLines(project), ["check 1"]);
  const second = assertSleeping(project);
  assert.equal(second.record.id, first.record.id);
  assert.ok(second.due > first.due, `the next due time ${second.record.due} is not later than ${first.record.due}`);

  await until(second.due);
  const last = cli(project, ["continue", first.record.id]);
  assert.equal(last.status, 0, last.stderr);
  assert.deepEqual(logLines(project), ["check 1", "check 2"]);
  const done = onlyRecord(project);
  assert.deepEqual({ id: done.id, status: done.status, state: done.state }, { id: first.record.id, status: "completed", state: "finished" });
  assert.equal(existsSync(checkpointFile(project, first.record.id)), false);
});

test("without --sleep, a timed wait finishes in one process and the run is never sleeping", async (context) => {
  const project = await createProject(context, { every: "400ms", checks: 2 });
  const started = Date.now();
  const child = spawn(process.execPath, [resolve("src/cli.ts"), ...runArgs(project, false)], {
    cwd: project.project, env: environment(project), stdio: ["ignore", "pipe", "pipe"],
  });
  context.after(() => { child.kill("SIGKILL"); });
  let output = "";
  child.stdout.setEncoding("utf8").on("data", (text: string) => { output += text; });
  child.stderr.setEncoding("utf8").on("data", (text: string) => { output += text; });
  const exited = new Promise<number | null>((done) => { child.on("close", (code) => done(code)); });

  const statuses = new Set<string>();
  const kinds = new Set<string>();
  let finished = false;
  void exited.then(() => { finished = true; });
  while (!finished) {
    for (const record of readRunStatuses(project.status) as SleepingRecord[]) {
      statuses.add(record.status);
      try {
        const checkpoint = readCheckpoint(project, record.id);
        kinds.add(checkpoint.state.kind);
        assert.notEqual(checkpoint.sleep, true);
      } catch (cause) {
        if (cause instanceof assert.AssertionError) throw cause;
      }
    }
    await new Promise((done) => setTimeout(done, 20));
  }

  assert.equal(await exited, 0, output);
  assert.ok(Date.now() - started >= 800, "the run did not wait at its timed waits");
  assert.deepEqual(logLines(project), ["check 1", "check 2"]);
  const record = onlyRecord(project);
  assert.deepEqual({ status: record.status, state: record.state }, { status: "completed", state: "finished" });
  assert.ok(kinds.has("wait"), `no checkpoint was seen at the wait: ${[...kinds].join(", ")}`);
  assert.equal(statuses.has("sleeping"), false);
});

test("--sleep is refused when run status publication is off, before anything runs", async (context) => {
  const project = await createProject(context, { every: "100ms", checks: 1 });
  const ran = cli(project, runArgs(project, true), { MACHINES_RUN_STATUS_DIR: "off" });
  assert.equal(ran.status, 1, ran.stdout);
  assert.match(ran.stderr, /publication is off/u);
  assert.deepEqual(logLines(project), []);
  assert.equal(existsSync(project.status), false);
  assert.deepEqual(readdirSync(project.home), []);
});

test("a due sleeping run continues even when its recorded process id now belongs to a live process", async (context) => {
  const project = await createProject(context, { every: "1s", checks: 1 });
  const ran = cli(project, runArgs(project, true));
  assert.equal(ran.status, 0, ran.stderr);
  const { record, due } = assertSleeping(project);
  // Over a long sleep the pid can be reused: here it names this test's own process.
  const file = join(project.status, `${record.id}.json`);
  const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  writeFileSync(file, JSON.stringify({ ...raw, pid: process.pid }));

  await until(due);
  const woken = cli(project, ["continue", record.id]);
  assert.equal(woken.status, 0, woken.stderr);
  assert.deepEqual(logLines(project), ["check 1"]);
  assert.equal(onlyRecord(project).status, "completed");
});

/** A run that does not end within this time is waiting in its process instead of sleeping or finishing. */
const askerTimeout = 20_000;

function askerArgs(project: Project, sleep: boolean): string[] {
  return ["run", "asker", ...(sleep ? ["--sleep"] : []), "--input-file", project.inputFile];
}

/** A refused `machine respond`: it fails, says why, and changes no file. */
function assertRefused(project: Project, args: readonly string[], reason?: RegExp): void {
  const before = statusFiles(project);
  const refused = cli(project, ["respond", ...args], {}, askerTimeout);
  assert.equal(refused.status, 1, `respond ${args.join(" ")} was not refused: ${refused.stdout}${refused.stderr}`);
  assert.notEqual(refused.stderr.trim(), "", `respond ${args.join(" ")} did not say why it was refused`);
  if (reason !== undefined) assert.match(refused.stderr, reason);
  assert.deepEqual(statusFiles(project), before, `respond ${args.join(" ")} changed the run's files`);
  assert.deepEqual(logLines(project), []);
}

test("a run started with --sleep sleeps at a Human request, takes one valid answer while asleep, and uses it when continued", async (context) => {
  const project = await createProject(context, { every: "1h", checks: 1 });
  const ran = cli(project, askerArgs(project, true), {}, askerTimeout);
  assert.equal(ran.error, undefined, `the run kept its process open at the Human request: ${String(ran.error)}`);
  assert.equal(ran.status, 0, ran.stderr);
  assert.deepEqual(logLines(project), []);

  // The process ended, and the record holds the request.
  const record = onlyRecord(project);
  assert.equal(record.status, "sleeping");
  assert.equal(record.state, "ask");
  assert.equal(record.due, undefined);
  assert.equal(record.human?.prompt, askerPrompt);
  assert.deepEqual(record.human?.choices, ["approve", "deny"]);
  const requestId = record.human?.requestId;
  assert.equal(typeof requestId, "string");
  assert.notEqual(requestId, "");
  assert.equal(record.human?.answer, undefined);
  const checkpoint = readCheckpoint(project, record.id);
  assert.equal(checkpoint.state.value, "ask");
  assert.equal(checkpoint.state.kind, "human");
  assert.equal(checkpoint.sleep, true);

  // Unanswered: continue says what the run waits for and how to answer it, and changes nothing.
  const asleep = statusFiles(project);
  const early = cli(project, ["continue", record.id], {}, askerTimeout);
  assert.equal(early.error, undefined, `continue started the unanswered run: ${String(early.error)}`);
  assert.equal(early.status, 0, early.stderr);
  const said = `${early.stdout}${early.stderr}`;
  assert.ok(said.includes(askerPrompt), `the request is not reported: ${said}`);
  assert.ok(said.includes(requestId!), `the request id is not reported: ${said}`);
  assert.ok(said.includes("machine respond"), `how to answer is not reported: ${said}`);
  assert.deepEqual(statusFiles(project), asleep);
  assert.deepEqual(logLines(project), []);

  // Answers the request does not take are refused, and the request stays open.
  assertRefused(project, [record.id, "not-the-request", "approve"]);
  assertRefused(project, [record.id, requestId!, "maybe"], /approve, deny/u);
  assertRefused(project, ["--question", record.id, requestId!, "Why now?"], /plain response/u);

  // The right answer is recorded; the run stays asleep and nothing starts it.
  const answered = cli(project, ["respond", record.id, requestId!, "approve"], {}, askerTimeout);
  assert.equal(answered.status, 0, answered.stderr);
  await new Promise((done) => setTimeout(done, 300));
  assert.deepEqual(logLines(project), []);
  const marked = onlyRecord(project);
  assert.equal(marked.id, record.id);
  assert.equal(marked.status, "sleeping");
  assert.equal(marked.human?.requestId, requestId);
  assert.equal(marked.human?.answer, "approve");
  assert.ok(existsSync(checkpointFile(project, record.id)));

  // A second answer is refused, whatever it is.
  assertRefused(project, [record.id, requestId!, "deny"]);
  assertRefused(project, [record.id, requestId!, "approve"]);
  assert.equal(onlyRecord(project).human?.answer, "approve");

  // Continue gives the Human state that answer without asking again.
  const woken = cli(project, ["continue", record.id], {}, askerTimeout);
  assert.equal(woken.error, undefined, `continue asked again instead of using the answer: ${String(woken.error)}`);
  assert.equal(woken.status, 0, woken.stderr);
  assert.ok(!`${woken.stdout}${woken.stderr}`.includes(askerPrompt), `the prompt was shown again: ${woken.stdout}${woken.stderr}`);
  assert.deepEqual(logLines(project), ["answer approve"]);
  const done = onlyRecord(project);
  assert.equal(done.id, record.id);
  assert.equal(done.startedAt, record.startedAt);
  assert.deepEqual({ status: done.status, state: done.state, error: done.error }, { status: "completed", state: "finished", error: undefined });
  assert.equal(existsSync(checkpointFile(project, record.id)), false);
});

test("a run sleeping at a timed wait takes no response", async (context) => {
  const project = await createProject(context, { every: "1h", checks: 1 });
  const ran = cli(project, runArgs(project, true));
  assert.equal(ran.status, 0, ran.stderr);
  const { record } = assertSleeping(project);
  assertRefused(project, [record.id, "any-request", "approve"]);
  assert.equal(onlyRecord(project).status, "sleeping");
});

test("without --sleep, a Human request is answered by machine respond while its process runs", async (context) => {
  const project = await createProject(context, { every: "1h", checks: 1 });
  const child = spawn(process.execPath, [resolve("src/cli.ts"), ...askerArgs(project, false)], {
    cwd: project.project, env: environment(project), stdio: ["ignore", "pipe", "pipe"],
  });
  context.after(() => { child.kill("SIGKILL"); });
  let output = "";
  child.stdout.setEncoding("utf8").on("data", (text: string) => { output += text; });
  child.stderr.setEncoding("utf8").on("data", (text: string) => { output += text; });
  let finished = false;
  const exited = new Promise<number | null>((done) => { child.on("close", (code) => { finished = true; done(code); }); });

  const statuses = new Set<string>();
  let waiting: SleepingRecord | undefined;
  const deadline = Date.now() + askerTimeout;
  while (waiting === undefined && !finished && Date.now() < deadline) {
    for (const record of readRunStatuses(project.status) as SleepingRecord[]) {
      statuses.add(record.status);
      if (record.status === "waiting" && record.human?.requestId !== undefined) waiting = record;
    }
    if (waiting === undefined) await new Promise((done) => setTimeout(done, 20));
  }
  assert.ok(waiting, `the run never waited for an answer in its process: ${output}`);
  assert.equal(finished, false, "the run's process ended at the Human request");

  const answered = cli(project, ["respond", waiting.id, waiting.human!.requestId!, "deny"], {}, askerTimeout);
  assert.equal(answered.status, 0, answered.stderr);
  assert.equal(await exited, 0, output);
  assert.deepEqual(logLines(project), ["answer deny"]);
  const record = onlyRecord(project);
  assert.deepEqual({ id: record.id, status: record.status, state: record.state }, { id: waiting.id, status: "completed", state: "finished" });
  assert.equal(statuses.has("sleeping"), false);
  assert.equal(existsSync(checkpointFile(project, record.id)), false);
});
