import "./environment.ts";

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, type TestContext } from "node:test";

import { readRunStatuses, type RunStatusRecord } from "../src/run-status.ts";

/** What a sleeping record adds, read loosely so the test names only what the ticket asks. */
type SleepingRecord = Omit<RunStatusRecord, "status"> & { readonly status: string; readonly due?: string };

interface Checkpoint {
  readonly state: { readonly value: unknown; readonly kind: string; readonly due?: string };
  readonly sleep?: boolean;
  readonly data: unknown;
}

/**
 * Rests in a timed wait, then a check Operation logs and counts. It goes back
 * to rest until it has made `input.checks` checks, then finishes.
 */
const machineSource = `import { appendFileSync } from "node:fs";

export const description = "Rests in a timed wait between checks.";

export default function sleeper(p, input) {
  const saved = p.data({ checks: 0 });
  return p.machine({
    initial: "rest",
    states: {
      rest: p.wait({ every: input.every }, { due: "check" }),
      check: p.operation(() => {
        saved.checks += 1;
        appendFileSync(input.log, "check " + saved.checks + "\\n");
        return { type: saved.checks >= input.checks ? "enough" : "again" };
      }, { again: "rest", enough: "finished" }),
      finished: p.final(),
    },
  });
}
`;

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
  writeFileSync(join(project, ".machines", "sleeper.ts"), machineSource);
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

function cli(project: Project, args: readonly string[], extra: Readonly<Record<string, string | undefined>> = {}) {
  return spawnSync(process.execPath, [resolve("src/cli.ts"), ...args], {
    cwd: project.project, encoding: "utf8", env: environment(project, extra), timeout: 60_000,
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
