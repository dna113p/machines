import "./environment.ts";

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, type TestContext } from "node:test";

import { readRunStatuses, type RunStatusRecord } from "../src/run-status.ts";
import {
  askerPrompt, askerSource, briefedAgentsSource, briefedFirstPrompt, briefedHeadlines, briefedSecondPrompt, briefedSource, briefedSummary,
  presentation, presentedPrompt, presentedSource, retrierSource, sleeperSource,
} from "./sleep-machines.ts";

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

/** `machine runs` output as one block of lines per run, keyed by run id; detail lines lose their indent. */
function runBlocks(stdout: string): Map<string, string[]> {
  const blocks = new Map<string, string[]>();
  let current: string[] = [];
  for (const line of stdout.trimEnd().split("\n")) {
    if (line.startsWith("  ")) current.push(line.slice(2));
    else blocks.set(line.split("\t")[0]!, current = [line]);
  }
  return blocks;
}

type ListedRun = SleepingRecord & { readonly sleep?: unknown };

function listedRuns(project: Project): ListedRun[] {
  const listed = cli(project, ["runs", "--json"], {}, askerTimeout);
  assert.equal(listed.status, 0, listed.stderr);
  return JSON.parse(listed.stdout) as ListedRun[];
}

test("machine runs lists runs sleeping at a Human request and at a timed wait, each with what it waits for", async (context) => {
  const project = await createProject(context, { every: "1h", checks: 1 });
  const asked = cli(project, askerArgs(project, true), {}, askerTimeout);
  assert.equal(asked.status, 0, asked.stderr);
  const asking = onlyRecord(project);
  const requestId = asking.human?.requestId;
  assert.ok(requestId);
  // The sleep message names the state, as the timed-wait message does.
  assert.match(asked.stdout, new RegExp(`^--> sleeping in ask for an answer\\. Answer with: machine respond ${asking.id} ${requestId} <response>$`, "mu"));
  assert.match(asked.stdout, new RegExp(`^Then wake it with: machine continue ${asking.id}$`, "mu"));

  const slept = cli(project, runArgs(project, true));
  assert.equal(slept.status, 0, slept.stderr);
  assert.match(slept.stdout, /^--> sleeping in rest until /mu);
  const resting = (readRunStatuses(project.status) as SleepingRecord[]).find((record) => record.id !== asking.id);
  assert.ok(resting?.due);

  // Without --all both are listed, and neither as lost though its process has ended.
  const text = cli(project, ["runs"], {}, askerTimeout);
  assert.deepEqual({ status: text.status, stderr: text.stderr }, { status: 0, stderr: "" });
  assert.doesNotMatch(text.stdout, /\tlost\t/u);
  const blocks = runBlocks(text.stdout);
  assert.match(blocks.get(asking.id)?.[0] ?? "", new RegExp(`^${asking.id}\t${asking.machine}\tsleeping\task\\b`, "u"), text.stdout);
  assert.match(blocks.get(resting.id)?.[0] ?? "", new RegExp(`^${resting.id}\t${resting.machine}\tsleeping\trest\\b`, "u"), text.stdout);
  const request = blocks.get(asking.id)!;
  assert.ok(request.includes(askerPrompt), text.stdout);
  assert.ok(request.includes(`request: ${requestId}`), text.stdout);
  assert.ok(request.includes("choices: approve, deny"), text.stdout);
  assert.ok(request.some((line) => line.includes(`machine respond ${asking.id} ${requestId}`)), text.stdout);
  assert.ok(blocks.get(resting.id)!.some((line) => line.startsWith(`due: ${resting.due}`)), text.stdout);

  // As JSON, with what each sleeps for.
  const byId = new Map(listedRuns(project).map((run) => [run.id, run]));
  assert.equal(byId.get(asking.id)?.status, "sleeping");
  assert.deepEqual(byId.get(asking.id)?.sleep, { for: "answer", requestId, choices: ["approve", "deny"], answered: false });
  assert.equal(byId.get(resting.id)?.status, "sleeping");
  assert.deepEqual(byId.get(resting.id)?.sleep, { for: "time", due: resting.due, isDue: false });

  // Once answered, it says so and how it wakes, and no longer how to answer it.
  const answered = cli(project, ["respond", asking.id, requestId, "approve"], {}, askerTimeout);
  assert.equal(answered.status, 0, answered.stderr);
  const after = runBlocks(cli(project, ["runs"], {}, askerTimeout).stdout).get(asking.id) ?? [];
  assert.match(after[0] ?? "", /\tsleeping\t/u, after.join("\n"));
  assert.ok(after.some((line) => /answered/u.test(line) && line.includes(`machine continue ${asking.id}`)), after.join("\n"));
  assert.ok(!after.some((line) => line.includes("machine respond")), after.join("\n"));
  assert.deepEqual(listedRuns(project).find((run) => run.id === asking.id)?.sleep, {
    for: "answer", requestId, choices: ["approve", "deny"], answered: true,
  });
  assert.deepEqual(logLines(project), []);
});

test("a sleeping run publishes every presentation field of its Human request, and continuation keeps them", async (context) => {
  const project = await createProject(context, { every: "1h", checks: 1 });
  writeFileSync(join(project.project, ".machines", "presented.ts"), presentedSource);
  const ran = cli(project, ["run", "presented", "--sleep", "--input-file", project.inputFile], {}, askerTimeout);
  assert.equal(ran.error, undefined, `the run kept its process open at the Human request: ${String(ran.error)}`);
  assert.equal(ran.status, 0, ran.stderr);

  // The record's request carries every field as the state set it, and the checkpoint is at the Human state.
  const record = onlyRecord(project);
  assert.deepEqual({ status: record.status, state: record.state }, { status: "sleeping", state: "ask" });
  const requestId = record.human?.requestId;
  assert.equal(typeof requestId, "string");
  assert.deepEqual(record.human, { prompt: presentedPrompt, requestId, ...presentation });
  const checkpoint = readCheckpoint(project, record.id);
  assert.deepEqual({ value: checkpoint.state.value, kind: checkpoint.state.kind, sleep: checkpoint.sleep }, { value: "ask", kind: "human", sleep: true });

  // machine runs shows the headline and marks the recommended choice.
  const listed = cli(project, ["runs"], {}, askerTimeout);
  assert.equal(listed.status, 0, listed.stderr);
  const block = runBlocks(listed.stdout).get(record.id) ?? [];
  assert.ok(block.includes(presentation.headline), listed.stdout);
  assert.ok(block.includes(presentedPrompt), listed.stdout);
  assert.ok(block.some((line) => line.startsWith("choices: ") && line.includes("approve (recommended)")), listed.stdout);
  assert.ok(!block.some((line) => /(retry|discard) \(recommended\)/u.test(line)), listed.stdout);

  // Unanswered: continue shows the headline and the recommended choice, and changes nothing.
  const asleep = statusFiles(project);
  const early = cli(project, ["continue", record.id], {}, askerTimeout);
  assert.equal(early.status, 0, early.stderr);
  const said = `${early.stdout}${early.stderr}`;
  assert.ok(said.includes(presentation.headline), `the headline is not reported: ${said}`);
  assert.ok(said.includes(presentedPrompt), `the prompt is not reported: ${said}`);
  assert.match(said, /approve \(recommended\)/u);
  assert.deepEqual(statusFiles(project), asleep);
  assert.deepEqual(logLines(project), []);

  // An answer is still a choice's name, matched as before.
  assertRefused(project, [record.id, requestId!, "approve (recommended)"], /approve, retry, discard/u);
  const answered = cli(project, ["respond", record.id, requestId!, "approve"], {}, askerTimeout);
  assert.equal(answered.status, 0, answered.stderr);
  assert.equal(onlyRecord(project).human?.answer, "approve");

  // Continuing takes the answer and sleeps at the second ask, which carries the same fields.
  const woken = cli(project, ["continue", record.id], {}, askerTimeout);
  assert.equal(woken.error, undefined, `continue kept its process open: ${String(woken.error)}`);
  assert.equal(woken.status, 0, woken.stderr);
  assert.deepEqual(logLines(project), ["answer approve"]);
  const again = onlyRecord(project);
  assert.deepEqual({ id: again.id, status: again.status, state: again.state }, { id: record.id, status: "sleeping", state: "again" });
  const secondId = again.human?.requestId;
  assert.equal(typeof secondId, "string");
  assert.notEqual(secondId, requestId);
  assert.deepEqual(again.human, { prompt: presentedPrompt, requestId: secondId, ...presentation });
  assert.equal(readCheckpoint(project, record.id).state.kind, "human");

  const second = cli(project, ["respond", record.id, secondId!, "discard"], {}, askerTimeout);
  assert.equal(second.status, 0, second.stderr);
  const done = cli(project, ["continue", record.id], {}, askerTimeout);
  assert.equal(done.status, 0, done.stderr);
  assert.deepEqual(logLines(project), ["answer approve", "answer discard"]);
  assert.deepEqual({ status: onlyRecord(project).status, state: onlyRecord(project).state }, { status: "completed", state: "finished" });
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

/** What a retrying run's record and checkpoint add, read loosely so the test names only what the ticket asks. */
type RetryRecord = SleepingRecord & { readonly retry?: { readonly attempt: number; readonly of: number; readonly due: string } };
type RetryCheckpoint = Checkpoint & { readonly state: Checkpoint["state"] & { readonly retry?: { readonly attempt: number; readonly of: number } } };

/** Asserts the run sleeps before `attempt` of four at its push, and that its record and checkpoint both say so. */
function assertSleepingBeforeAttempt(project: Project, attempt: number): { readonly record: RetryRecord; readonly due: number } {
  const record = onlyRecord(project) as RetryRecord;
  assert.deepEqual({ status: record.status, state: record.state }, { status: "sleeping", state: "push" });
  assert.equal(typeof record.due, "string");
  const due = Date.parse(record.due ?? "");
  assert.ok(Number.isFinite(due), `due "${record.due}" is not a time`);
  assert.deepEqual(record.retry, { attempt, of: 4, due: record.due });
  const checkpoint = readCheckpoint(project, record.id) as RetryCheckpoint;
  assert.deepEqual(
    { value: checkpoint.state.value, kind: checkpoint.state.kind, due: checkpoint.state.due, retry: checkpoint.state.retry },
    { value: "push", kind: "operation", due: record.due, retry: { attempt, of: 4 } },
  );
  assert.equal(checkpoint.sleep, true);
  return { record, due };
}

test("a retrying Operation run with --sleep sleeps between attempts, and each continuation resumes the count from its checkpoint", async (context) => {
  const project = await createProject(context, { every: "1h", checks: 1 });
  writeFileSync(join(project.project, ".machines", "retrier.ts"), retrierSource);
  writeFileSync(project.inputFile, JSON.stringify({ log: project.log, passAt: 99, times: 3, wait: "1s" }));
  const started = Date.now();
  const ran = cli(project, ["run", "retrier", "--sleep", "--input-file", project.inputFile]);
  assert.equal(ran.status, 0, ran.stderr);
  assert.deepEqual(logLines(project), ["call 1"]);
  const first = assertSleepingBeforeAttempt(project, 2);
  assert.ok(first.due >= started + 500, `due ${first.record.retry?.due} is not about 1s after the first call`);

  // Before it is due: nothing changes, as for a timed wait.
  const before = statusFiles(project);
  const early = cli(project, ["continue", first.record.id]);
  assert.equal(early.status, 0, early.stderr);
  assert.deepEqual(logLines(project), ["call 1"]);
  assert.deepEqual(statusFiles(project), before);

  // Each continuation makes one attempt and sleeps before the next: attempt 3 of 4 is not attempt 1 again.
  await until(first.due);
  const second = cli(project, ["continue", first.record.id]);
  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(logLines(project), ["call 1", "call 2"]);
  const third = assertSleepingBeforeAttempt(project, 3);
  assert.equal(third.record.id, first.record.id);
  assert.ok(third.due > first.due, `the next due time ${third.record.due} is not later than ${first.record.due}`);

  await until(third.due);
  const fourth = cli(project, ["continue", first.record.id]);
  assert.equal(fourth.status, 0, fourth.stderr);
  assert.deepEqual(logLines(project), ["call 1", "call 2", "call 3"]);
  const last = assertSleepingBeforeAttempt(project, 4);

  // The last attempt fails too: the attempts are used up and `failed` is handled as without retry.
  await until(last.due);
  const done = cli(project, ["continue", first.record.id]);
  assert.equal(done.status, 0, done.stderr);
  assert.deepEqual(logLines(project), ["call 1", "call 2", "call 3", "call 4"]);
  const after = onlyRecord(project) as RetryRecord;
  assert.deepEqual(
    { id: after.id, status: after.status, state: after.state, retry: after.retry },
    { id: first.record.id, status: "completed", state: "askPush", retry: undefined },
  );
  assert.equal(existsSync(checkpointFile(project, first.record.id)), false);
});

/** A project with the briefed Machine and its presets, and where its presenter logs each input it is given. */
async function createBriefedProject(context: TestContext): Promise<Project & { readonly presenterLog: string }> {
  const project = await createProject(context, { every: "1h", checks: 1 });
  writeFileSync(join(project.project, ".machines", "briefed.ts"), briefedSource);
  writeFileSync(join(project.project, ".machines", "agents.ts"), briefedAgentsSource);
  return { ...project, presenterLog: join(project.root, "presenter.log") };
}

/** Each input the presenter was given, in order. */
function presenterInputs(project: { readonly presenterLog: string }): string[] {
  return existsSync(project.presenterLog)
    ? readFileSync(project.presenterLog, "utf8").split("\n").filter((line) => line !== "").map((line) => JSON.parse(line) as string)
    : [];
}

function briefedCli(project: Project & { readonly presenterLog: string }, args: readonly string[]) {
  const ran = cli(project, args, { PRESENTER_LOG: project.presenterLog }, askerTimeout);
  assert.equal(ran.error, undefined, `machine ${args.join(" ")} kept its process open: ${String(ran.error)}`);
  assert.equal(ran.status, 0, `${ran.stdout}${ran.stderr}`);
  return ran;
}

/** Answers the sleeping run's request and continues it. */
function answerAndContinue(project: Project & { readonly presenterLog: string }, id: string, answer: string): void {
  const requestId = onlyRecord(project).human?.requestId;
  assert.equal(typeof requestId, "string");
  briefedCli(project, ["respond", id, requestId!, answer]);
  briefedCli(project, ["continue", id]);
}

test("a sleeping run's presenter runs once before it sleeps, its fields are published, and continuation does not run it again", async (context) => {
  const project = await createBriefedProject(context);
  briefedCli(project, ["run", "briefed", "--sleep", "--input-file", project.inputFile]);

  // The presenter ran once, before the run slept, and its fields are in the published request.
  const record = onlyRecord(project);
  assert.deepEqual({ status: record.status, state: record.state }, { status: "sleeping", state: "first" });
  const requestId = record.human?.requestId;
  assert.deepEqual(record.human, {
    prompt: briefedFirstPrompt, choices: ["ship", "hold"], requestId, headline: briefedHeadlines.first, recommended: "ship",
  });
  assert.equal(presenterInputs(project).length, 1);
  assert.ok(presenterInputs(project)[0]!.includes(briefedFirstPrompt));
  // The checkpoint keeps the run's history for a presenter after continuation.
  assert.ok(readFileSync(checkpointFile(project, record.id), "utf8").includes(briefedSummary), "the checkpoint lost the Agent summary");

  // Continuation takes the answer without presenting the first question again, and presents the second once.
  answerAndContinue(project, record.id, "ship");
  assert.deepEqual(logLines(project), ["answer ship"]);
  const second = onlyRecord(project);
  assert.deepEqual({ id: second.id, status: second.status, state: second.state }, { id: record.id, status: "sleeping", state: "second" });
  assert.deepEqual(second.human, {
    prompt: briefedSecondPrompt, choices: ["tag", "skip"], requestId: second.human?.requestId,
    headline: briefedHeadlines.second, recommended: "tag",
  });
  const inputs = presenterInputs(project);
  assert.equal(inputs.length, 2);
  // The second presenter, in a later process, is given the whole run's history and the presentWith text.
  assert.ok(inputs[1]!.includes(briefedSecondPrompt), inputs[1]);
  assert.ok(inputs[1]!.includes(briefedSummary), `the Agent summary from before the sleep is missing:\n${inputs[1]}`);
  assert.ok(inputs[1]!.includes(`Evidence: ${project.log}`), inputs[1]);

  answerAndContinue(project, record.id, "tag");
  assert.deepEqual(logLines(project), ["answer ship", "answer tag"]);
  assert.deepEqual({ status: onlyRecord(project).status, state: onlyRecord(project).state }, { status: "completed", state: "finished" });
  assert.equal(presenterInputs(project).length, 2);
});

test("a checkpoint written before presenters still continues, and the next Human state is presented", async (context) => {
  const project = await createBriefedProject(context);
  briefedCli(project, ["run", "briefed", "--sleep", "--input-file", project.inputFile]);
  const record = onlyRecord(project);
  assert.equal(record.state, "first");
  assert.equal(presenterInputs(project).length, 1);

  // Keep only what a checkpoint held before this change.
  const file = checkpointFile(project, record.id);
  const saved = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown> & { state: Record<string, unknown> };
  const keep = (value: Record<string, unknown>, keys: readonly string[]) =>
    Object.fromEntries(Object.entries(value).filter(([key]) => keys.includes(key)));
  const older = {
    ...keep(saved, ["schemaVersion", "id", "machine", "input", "state", "data", "context", "children", "agents", "home", "cwd", "writtenAt", "sleep"]),
    state: keep(saved.state, ["value", "kind", "enteredAt", "due", "retry", "path"]),
  };
  assert.ok(!JSON.stringify(older).includes(briefedSummary));
  writeFileSync(file, `${JSON.stringify(older)}\n`);

  answerAndContinue(project, record.id, "hold");
  const second = onlyRecord(project);
  assert.deepEqual({ status: second.status, state: second.state }, { status: "sleeping", state: "second" });
  assert.equal(second.human?.headline, briefedHeadlines.second);
  assert.equal(presenterInputs(project).length, 2);

  answerAndContinue(project, record.id, "skip");
  assert.deepEqual(logLines(project), ["answer hold", "answer skip"]);
  assert.equal(onlyRecord(project).status, "completed");
});
