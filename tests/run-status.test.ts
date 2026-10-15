import "./environment.ts";

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, type TestContext } from "node:test";

import { runStatusDirectory as statusLineDirectory, runStatusLines } from "../claude/statusline.mjs";
import { MachineSession as McpSession } from "../mcp/server.ts";
import { startMachineHost, type HostedHumanRequest } from "../src/host.ts";
import type { JsonValue } from "../src/json.ts";
import { respondToRun } from "../src/run-inbox.ts";
import {
  createRunStatusPublisher,
  readRunStatuses,
  runDeliveryPath,
  runInboxPath,
  runStatusDirectory,
  type RunStatusOutcome,
  type RunStatusRecord,
} from "../src/run-status.ts";
import { readRunWatches } from "../src/run-watch.ts";
import { MachineSession } from "../src/session.ts";

const run = { machine: "ticket", path: "/work/.machines/ticket.ts", cwd: "/work" };
const fixture = resolve("tests/fixtures/run-status.machine.ts");
/** Returns its input as its output, so a test chooses what a run ends with. */
const structured = resolve("tests/fixtures/structured.machine.ts");
/** Where a run publishes when nothing says where, under the home it is given. */
const standardDirectory = (home: string) => join(home, ".local", "state", "machines", "runs");

test("sleeping status records preserve their deadline and ignore later updates", async (context) => {
  const directory = await temporaryDirectory(context);
  const publisher = createRunStatusPublisher({ ...run, id: "sleep" }, { MACHINES_RUN_STATUS_DIR: directory });
  publisher.update({ state: "rest", limit: { text: "old limit" }, human: { prompt: "old request" } });
  const due = new Date(Date.now() + 60_000).toISOString();
  publisher.sleep(due);
  const [record] = readRunStatuses(directory);
  assert.equal(record?.status, "sleeping");
  assert.equal(record.due, due);
  assert.equal(record.state, "rest");
  assert.equal(record.human, undefined);
  assert.equal(record.limit, undefined);
  const before = await readFile(join(directory, "sleep.json"), "utf8");
  publisher.update({ status: "running", state: "wrong" });
  publisher.finish({ state: "wrong" });
  assert.equal(await readFile(join(directory, "sleep.json"), "utf8"), before);
});

test("continuation keeps a sleeping run's host ownership", async (context) => {
  const directory = await temporaryDirectory(context);
  const environment = { MACHINES_RUN_STATUS_DIR: directory };
  const publisher = createRunStatusPublisher({ ...run, id: "hosted-sleep", continuedBy: "host" }, environment);
  publisher.sleep(new Date().toISOString());
  const record = readRunStatuses(directory)[0]!;
  assert.equal(record.continuedBy, "host");
  const continued = createRunStatusPublisher({ ...run, id: record.id, continueRun: { record, machineChanged: false } }, environment);
  continued.sleep(new Date(Date.now() + 60_000).toISOString());
  assert.equal(readRunStatuses(directory)[0]?.continuedBy, "host");
});

test("a sleeping status record holds either a due time or a Human request, which may carry its answer", async (context) => {
  const directory = await temporaryDirectory(context);
  const publisher = createRunStatusPublisher({ ...run, id: "asleep" }, { MACHINES_RUN_STATUS_DIR: directory });
  publisher.update({ state: "ask" });
  publisher.sleep(new Date(Date.now() + 60_000).toISOString());
  const file = join(directory, "asleep.json");
  const base = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  delete base.due;
  const human = { prompt: "Ship it?", requestId: "request-1", choices: ["approve", "deny"] };
  const read = async (record: Record<string, unknown>) => {
    await writeFile(file, JSON.stringify(record));
    return readRunStatuses(directory) as Array<RunStatusRecord & { readonly human?: { readonly answer?: string } }>;
  };

  const [unanswered] = await read({ ...base, human });
  assert.deepEqual({ status: unanswered?.status, due: unanswered?.due, human: unanswered?.human }, { status: "sleeping", due: undefined, human });
  const [answered] = await read({ ...base, human: { ...human, answer: "approve" } });
  assert.equal(answered?.human?.answer, "approve");
  assert.deepEqual(await read({ ...base, human: { ...human, answer: 1 } }), []);
  assert.deepEqual(await read(base), []);
});

test("the directory is the user's own unless MACHINES_RUN_STATUS_DIR moves it or turns publication off", (context) => {
  const cases: ReadonlyArray<readonly [NodeJS.ProcessEnv, string | undefined]> = [
    [{}, standardDirectory(homedir())],
    [{ XDG_STATE_HOME: "/xdg/state" }, "/xdg/state/machines/runs"],
    [{ XDG_STATE_HOME: "/xdg/state/" }, "/xdg/state/machines/runs"],
    // Only an absolute XDG_STATE_HOME names a directory.
    [{ XDG_STATE_HOME: "relative/state" }, standardDirectory(homedir())],
    [{ XDG_STATE_HOME: "" }, standardDirectory(homedir())],
    // A Machines home of its own keeps its runs, whatever is said of the real home.
    [{ MACHINES_USER_HOME: "/machines/home" }, standardDirectory("/machines/home")],
    [{ MACHINES_USER_HOME: "/machines/home", XDG_STATE_HOME: "/xdg/state" }, standardDirectory("/machines/home")],
    // A home the runtime refuses publishes nowhere, and never in the real one.
    [{ MACHINES_USER_HOME: "relative/home" }, undefined],
    [{ MACHINES_USER_HOME: "", XDG_STATE_HOME: "/xdg/state" }, undefined],
    [{ MACHINES_RUN_STATUS_DIR: "off" }, undefined],
    [{ MACHINES_RUN_STATUS_DIR: "off", MACHINES_USER_HOME: "/machines/home", XDG_STATE_HOME: "/xdg/state" }, undefined],
    [{ MACHINES_RUN_STATUS_DIR: "" }, undefined],
    [{ MACHINES_RUN_STATUS_DIR: "", XDG_STATE_HOME: "/xdg/state" }, undefined],
    [{ MACHINES_RUN_STATUS_DIR: "/explicit/runs" }, "/explicit/runs"],
    [{ MACHINES_RUN_STATUS_DIR: "/explicit/runs", MACHINES_USER_HOME: "/machines/home", XDG_STATE_HOME: "/xdg/state" }, "/explicit/runs"],
    [{ MACHINES_RUN_STATUS_DIR: "relative/runs" }, resolve("relative/runs")],
    [{ MACHINES_RUN_STATUS_DIR: "./off" }, resolve("off")],
  ];
  for (const [environment, expected] of cases) {
    assert.equal(runStatusDirectory(environment), expected, JSON.stringify(environment));
    // The status line cannot load the runtime, so it has the rule a second time.
    assert.equal(statusLineDirectory(environment), expected, `status line: ${JSON.stringify(environment)}`);
  }

  // Neither falls back to the working directory when the process has no absolute home.
  const home = process.env.HOME;
  context.after(() => {
    if (home === undefined) delete process.env.HOME;
    else process.env.HOME = home;
  });
  process.env.HOME = "relative/home";
  for (const environment of [{}, { XDG_STATE_HOME: "relative/state" }]) {
    assert.equal(runStatusDirectory(environment), undefined);
    assert.equal(statusLineDirectory(environment), undefined);
  }
  assert.equal(runStatusDirectory({ XDG_STATE_HOME: "/xdg/state" }), "/xdg/state/machines/runs");
  assert.equal(statusLineDirectory({ XDG_STATE_HOME: "/xdg/state" }), "/xdg/state/machines/runs");
});

test("run status is off when MACHINES_RUN_STATUS_DIR is off or empty", async (context) => {
  const cwd = await temporaryDirectory(context);
  const home = join(cwd, "home");
  for (const off of ["off", ""]) {
    for (const environment of [{ MACHINES_USER_HOME: home }, { MACHINES_USER_HOME: home, MACHINES_RUN_OWNER: "owner" }]) {
      const publisher = createRunStatusPublisher(run, { ...environment, MACHINES_RUN_STATUS_DIR: off });
      assert.equal(publisher.directory, undefined);
      publisher.update({ state: "work" });
      publisher.finish({ state: "done" });
    }
    const input = join(cwd, "input.json");
    await writeFile(input, JSON.stringify({ observed: join(cwd, "observed.json"), secret: "unpublished" }));
    const result = runCli(["--input-file", input], cwd, { MACHINES_RUN_STATUS_DIR: off, MACHINES_USER_HOME: home });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(await readFile(join(cwd, "observed.json"), "utf8")), []);
    // Not even the home it would publish under by default is created.
    assert.deepEqual((await readdir(cwd)).sort(), ["input.json", "observed.json"]);
  }
});

test("machine run with nothing set publishes in the standard directory of its home", async (context) => {
  const root = await temporaryDirectory(context);
  const input = join(root, "input.json");
  const observed = join(root, "observed.json");
  await writeFile(input, JSON.stringify({ observed, secret: "never-published-value" }));
  const unset = { MACHINES_RUN_STATUS_DIR: undefined, MACHINES_USER_HOME: undefined, XDG_STATE_HOME: undefined };
  const homes: ReadonlyArray<readonly [string, Readonly<Record<string, string | undefined>>, string]> = [
    ["the process's home", { ...unset, HOME: join(root, "home") }, standardDirectory(join(root, "home"))],
    ["XDG_STATE_HOME", { ...unset, HOME: join(root, "unused"), XDG_STATE_HOME: join(root, "xdg") }, join(root, "xdg", "machines", "runs")],
    [
      "the Machines home",
      { ...unset, HOME: join(root, "unused"), XDG_STATE_HOME: join(root, "unused"), MACHINES_USER_HOME: join(root, "machines-home") },
      standardDirectory(join(root, "machines-home")),
    ],
  ];
  for (const [name, environment, directory] of homes) {
    const result = runCli(["--input-file", input], root, environment);
    assert.equal(result.status, 0, `${name}: ${result.stderr}`);
    assert.equal((await stat(directory)).mode & 0o777, 0o700, name);
    const [record, ...others] = readRunStatuses(directory);
    assert.deepEqual(others, [], name);
    assert.deepEqual(
      { machine: record!.machine, cwd: record!.cwd, status: record!.status, state: record!.state },
      { machine: "run-status.machine", cwd: root, status: "completed", state: "done" },
      name,
    );
    assert.deepEqual(await readdir(directory), [`${record!.id}.json`], name);
    assert.equal((await stat(join(directory, `${record!.id}.json`))).mode & 0o777, 0o600, name);
    // The run saw its own record there while it was running.
    const during = JSON.parse(await readFile(observed, "utf8")) as RunStatusRecord[];
    assert.deepEqual(during.map(({ id, status }) => ({ id, status })), [{ id: record!.id, status: "running" }], name);
  }
  assert.deepEqual((await readdir(root)).sort(), ["home", "input.json", "machines-home", "observed.json", "xdg"]);

  // The same command with the switch off leaves all of it as it was.
  const before = await readdir(standardDirectory(join(root, "home")));
  const off = runCli(["--input-file", input], root, { ...homes[0]![1], MACHINES_RUN_STATUS_DIR: "off" });
  assert.equal(off.status, 0, off.stderr);
  assert.deepEqual(JSON.parse(await readFile(observed, "utf8")), []);
  assert.deepEqual(await readdir(standardDirectory(join(root, "home"))), before);
});

test("a publisher writes one private record that identifies the run and its process", async (context) => {
  const directory = join(await temporaryDirectory(context), "nested", "status");
  const before = Date.now();
  createRunStatusPublisher({ ...run, id: "run-1" }, { MACHINES_RUN_STATUS_DIR: directory });

  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.equal((await stat(join(directory, "run-1.json"))).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(directory), ["run-1.json"]);
  const [record] = readRunStatuses(directory);
  assert.ok(record);
  const { startedAt, updatedAt, ...identity } = record;
  assert.deepEqual(identity, {
    schemaVersion: 2,
    id: "run-1",
    pid: process.pid,
    machine: "ticket",
    path: "/work/.machines/ticket.ts",
    cwd: "/work",
    status: "running",
  });
  assert.equal(new Date(startedAt).toISOString(), startedAt);
  assert.ok(Date.parse(startedAt) >= before && Date.parse(updatedAt) >= Date.parse(startedAt));
});

test("a generated id names the file, and an id that could leave the directory is not published", async (context) => {
  const root = await temporaryDirectory(context);
  const directory = join(root, "status");
  createRunStatusPublisher(run, { MACHINES_RUN_STATUS_DIR: directory });
  const [generated] = readRunStatuses(directory);
  assert.match(generated!.id, /^[0-9a-f-]{36}$/u);
  assert.deepEqual(await readdir(directory), [`${generated!.id}.json`]);

  for (const id of ["../escaped", "nested/run", ".hidden", ""]) {
    createRunStatusPublisher({ ...run, id }, { MACHINES_RUN_STATUS_DIR: directory }).finish({ state: "done" });
  }
  assert.deepEqual(await readdir(directory), [`${generated!.id}.json`]);
  assert.deepEqual(await readdir(root), ["status"]);
});

test("the owner is MACHINES_RUN_OWNER, then the Claude Code session, then omitted", async (context) => {
  const directory = await temporaryDirectory(context);
  const environment = { MACHINES_RUN_STATUS_DIR: directory };
  createRunStatusPublisher({ ...run, id: "explicit" }, {
    ...environment, MACHINES_RUN_OWNER: "explicit-owner", CLAUDE_CODE_SESSION_ID: "session",
  });
  createRunStatusPublisher({ ...run, id: "session" }, { ...environment, CLAUDE_CODE_SESSION_ID: "session" });
  createRunStatusPublisher({ ...run, id: "empty" }, {
    ...environment, MACHINES_RUN_OWNER: "", CLAUDE_CODE_SESSION_ID: "session",
  });
  createRunStatusPublisher({ ...run, id: "unowned" }, environment);

  const owners = Object.fromEntries(readRunStatuses(directory).map((record) => [record.id, record.owner]));
  assert.deepEqual(owners, { explicit: "explicit-owner", session: "session", empty: "session", unowned: undefined });
  assert.equal("owner" in JSON.parse(await readFile(join(directory, "unowned.json"), "utf8")), false);
});

test("a launcher's label is one short line, and each state records when it was entered", async (context) => {
  const directory = await temporaryDirectory(context);
  const environment = { MACHINES_RUN_STATUS_DIR: directory };
  const publisher = createRunStatusPublisher({ ...run, id: "labelled" }, {
    ...environment, MACHINES_RUN_LABEL: `\n  org-2: ${"x".repeat(300)}\nsecond line`,
  });
  createRunStatusPublisher({ ...run, id: "plain" }, { ...environment, MACHINES_RUN_LABEL: "  " });
  const read = () => Object.fromEntries(readRunStatuses(directory).map((record) => [record.id, record]));

  assert.equal(read().labelled!.label, `org-2: ${"x".repeat(153)}`);
  assert.equal(read().plain!.label, undefined);
  assert.equal(read().labelled!.stateSince, undefined);
  publisher.update({ state: "change" });
  const entered = read().labelled!.stateSince;
  assert.equal(typeof entered, "string");
  publisher.update({ state: "change", agent: { harness: "claude" } });
  assert.equal(read().labelled!.stateSince, entered);
  publisher.finish({ state: "done" });
  assert.equal(read().labelled!.stateSince, undefined);
});

test("a run started inside another run records its parent", async (context) => {
  const directory = await temporaryDirectory(context);
  const environment = { MACHINES_RUN_STATUS_DIR: directory };
  createRunStatusPublisher({ ...run, id: "inner" }, { ...environment, MACHINES_RUN_PARENT: "outer" });
  createRunStatusPublisher({ ...run, id: "top" }, { ...environment, MACHINES_RUN_PARENT: "" });

  const parents = Object.fromEntries(readRunStatuses(directory).map((record) => [record.id, record.parent]));
  assert.deepEqual(parents, { inner: "outer", top: undefined });
});

test("updates replace the record atomically until a terminal outcome", async (context) => {
  const directory = await temporaryDirectory(context);
  const read = async (id: string): Promise<RunStatusRecord> => {
    assert.deepEqual((await readdir(directory)).filter((name) => !name.endsWith(".json")), []);
    return JSON.parse(await readFile(join(directory, `${id}.json`), "utf8"));
  };
  const completed = createRunStatusPublisher({ ...run, id: "completed", startedAt: "2026-01-02T03:04:05.000Z" }, {
    MACHINES_RUN_STATUS_DIR: directory,
  });
  assert.equal((await read("completed")).startedAt, "2026-01-02T03:04:05.000Z");

  completed.update({ state: "implement" });
  const identity = { type: "identity", harness: "claude", model: "opus", thinking: "high" } as const;
  completed.update({ agent: identity });
  let record = await read("completed");
  assert.equal(record.state, "implement");
  assert.deepEqual(record.agent, { harness: "claude", model: "opus", thinking: "high" });

  const written = record.updatedAt;
  await new Promise((resolve) => setTimeout(resolve, 5));
  completed.update({ state: "implement", agent: identity });
  assert.equal((await read("completed")).updatedAt, written, "an unchanged run is not rewritten");

  completed.update({ state: { review: "checks" }, agent: undefined });
  record = await read("completed");
  assert.equal(record.state, '{"review":"checks"}');
  assert.equal("agent" in record, false);

  const request = { prompt: "Approve?\nDetails", requestId: "request-1", choices: ["yes", "no"] };
  completed.update({ status: "waiting", human: { ...request, response: "yes", input: "unpublished" } as typeof request });
  record = await read("completed");
  assert.equal(record.status, "waiting");
  assert.deepEqual(record.human, request);
  completed.update({ human: { prompt: "Which?", requestId: "request-2", suggestions: ["later"], discussion: true } });
  assert.deepEqual((await read("completed")).human, {
    prompt: "Which?", requestId: "request-2", suggestions: ["later"], discussion: true,
  });
  completed.update({ human: { prompt: "Say more", requestId: "request-3", discussion: false } });
  assert.deepEqual((await read("completed")).human, { prompt: "Say more", requestId: "request-3" });

  completed.update({ status: "running", human: undefined, agent: { harness: "codex" } });
  completed.finish({ state: "done" });
  completed.update({ state: "late" });
  completed.finish({ error: "late" });
  record = await read("completed");
  assert.deepEqual(
    { status: record.status, state: record.state, agent: record.agent, human: record.human, error: record.error },
    { status: "completed", state: "done", agent: undefined, human: undefined, error: undefined },
  );
  assert.equal((await stat(join(directory, "completed.json"))).mode & 0o777, 0o600);

  const failed = createRunStatusPublisher({ ...run, id: "failed" }, { MACHINES_RUN_STATUS_DIR: directory });
  failed.update({ state: "implement", status: "waiting", human: { prompt: "Continue?" } });
  failed.finish({ error: "Operation failed in state \"implement\"" });
  record = await read("failed");
  assert.deepEqual(
    { status: record.status, state: record.state, human: record.human, error: record.error },
    { status: "failed", state: "implement", human: undefined, error: "Operation failed in state \"implement\"" },
  );
});

test("a finished run keeps a note, cut to 2000 characters at a word boundary", async (context) => {
  const directory = await temporaryDirectory(context);
  const read = async (id: string): Promise<RunStatusRecord> => JSON.parse(await readFile(join(directory, `${id}.json`), "utf8"));
  const finished = async (id: string, outcome: RunStatusOutcome): Promise<RunStatusRecord> => {
    const published = createRunStatusPublisher({ ...run, id }, { MACHINES_RUN_STATUS_DIR: directory });
    published.update({ state: "work" });
    // A note is what a run ends with: one that is still going has none.
    assert.equal("note" in await read(id), false);
    published.finish(outcome);
    return read(id);
  };

  const note = "Parked on ticket/org-12: which base should the branch take?\nNeeds: a decision from the ticket owner.";
  const parked = await finished("parked", { state: "parked", note });
  assert.deepEqual(
    { schemaVersion: parked.schemaVersion, status: parked.status, state: parked.state, note: parked.note },
    // Every line is kept; the field is optional, so the version is the one records already have.
    { schemaVersion: 2, status: "completed", state: "parked", note },
  );
  assert.equal((await stat(join(directory, "parked.json"))).mode & 0o777, 0o600);

  assert.equal("note" in await finished("plain", { state: "done" }), false);
  assert.equal("note" in await finished("blank", { state: "done", note: " \n\t " }), false);
  assert.equal((await finished("trimmed", { state: "parked", note: ` \n${note}\n ` })).note, note);
  const failed = await finished("failed", { error: "Operation failed in state \"work\"" });
  assert.deepEqual({ status: failed.status, hasNote: "note" in failed }, { status: "failed", hasNote: false });

  const words = ["the", "ticket", "is", "parked", "until", "someone", "decides", "which", "base", "its", "branch", "takes"];
  const long = Array.from({ length: 600 }, (_, index) => words[index % words.length]).join(" ");
  // A note that fits is published as it is.
  const fits = long.slice(0, 2000).trimEnd();
  assert.equal(fits.length, 2000);
  assert.equal((await finished("fits", { state: "parked", note: fits })).note, fits);

  assert.ok(long.length > 3000);
  const cut = (await finished("cut", { state: "parked", note: long })).note;
  assert.ok(cut !== undefined && cut.endsWith("…"), cut);
  assert.ok(cut.length <= 2000, `the note is ${cut.length} characters`);
  // No further back than the last whole word that fits.
  assert.ok(cut.length >= 1985, `the note is ${cut.length} characters`);
  const kept = cut.slice(0, -1);
  assert.ok(long.startsWith(kept));
  assert.match(long.slice(kept.trimEnd().length), /^\s/u, "the note ends with a whole word");
  const boundary = `${"a".repeat(1999)} next`;
  assert.equal((await finished("boundary", { state: "parked", note: boundary })).note, `${"a".repeat(1999)}…`);
  assert.equal((await finished("unbroken", { state: "parked", note: "a".repeat(2001) })).note, `${"a".repeat(1999)}…`);
});

test("a wait for an Agent usage limit is published until the Agent resumes or the state is left", async (context) => {
  const directory = await temporaryDirectory(context);
  const read = async (): Promise<RunStatusRecord> => JSON.parse(await readFile(join(directory, "limited.json"), "utf8"));
  const publisher = createRunStatusPublisher({ ...run, id: "limited" }, { MACHINES_RUN_STATUS_DIR: directory });
  const waiting = { text: "claude reached its usage limit; waiting for the reset at 2026-10-10T21:00:00Z", until: "2026-10-10T21:00:00Z" };

  publisher.update({ state: "implement", agent: { harness: "claude" } });
  assert.equal("limit" in await read(), false);
  publisher.update({ limit: { ...waiting, status: "waiting", agent: "claude" } as typeof waiting });
  let record = await read();
  assert.deepEqual(record.limit, waiting);
  // The run is working, not asking: `waiting` is reserved for Human input.
  assert.deepEqual({ status: record.status, schemaVersion: record.schemaVersion }, { status: "running", schemaVersion: 2 });
  assert.deepEqual(readRunStatuses(directory).map((found) => found.limit), [waiting]);

  publisher.update({ state: "implement", agent: { harness: "claude" } });
  assert.deepEqual((await read()).limit, waiting, "an update within the state keeps the wait");
  publisher.update({ limit: undefined });
  assert.equal("limit" in await read(), false, "resuming clears it");

  publisher.update({ limit: { text: "codex reached its usage limit; no reset is stated, retrying until 2026-10-11T02:00:00Z" } });
  assert.deepEqual(Object.keys((await read()).limit!), ["text"]);
  publisher.update({ state: "review" });
  record = await read();
  assert.equal("limit" in record, false, "leaving the state clears it");

  publisher.update({ limit: waiting });
  publisher.finish({ error: "Agent failed" });
  assert.equal("limit" in await read(), false);
});

test("a hosted run that waits for a usage limit shows it in its snapshot, its record, and machine runs", async (context) => {
  const directory = await temporaryDirectory(context);
  const previous = process.env.MACHINES_RUN_STATUS_DIR;
  process.env.MACHINES_RUN_STATUS_DIR = directory;
  const session = new McpSession();
  context.after(() => {
    session.close();
    if (previous === undefined) delete process.env.MACHINES_RUN_STATUS_DIR;
    else process.env.MACHINES_RUN_STATUS_DIR = previous;
  });
  const started = await session.start({
    cwd: resolve("tests/fixtures/agent-limit-project"), machine: "work", agents: { default: "waits" },
  });
  const { id } = (started.structuredContent as { run: { id: string } }).run;
  const published = () => readRunStatuses(directory).find((record) => record.id === id);

  await eventually(() => assert.ok(published()?.limit !== undefined));
  const record = published()!;
  assert.deepEqual({ status: record.status, state: record.state }, { status: "running", state: "work" });
  assert.match(record.limit!.text, /^waits \(role default\) reached its usage limit; waiting for the reset at \d{4}-.*Z$/u);
  assert.ok(Date.parse(record.limit!.until!) > Date.now());

  const status = session.status({ runId: id });
  assert.deepEqual((status.structuredContent as { runs: Array<{ status: string; limit: unknown }> }).runs.map(
    ({ status: reported, limit }) => ({ status: reported, limit }),
  ), [{ status: "running", limit: record.limit }]);
  assert.ok((status.content[0] as { text: string }).text.includes(`\nLimit: ${record.limit!.text}`));

  const listed = spawnSync(process.execPath, [resolve("src/cli.ts"), "runs"], {
    encoding: "utf8", env: { ...process.env, MACHINES_RUN_STATUS_DIR: directory },
  });
  assert.equal(listed.stdout, `${id}\twork\trunning\twork\n  ${record.limit!.text}\n`, listed.stderr);

  session.close();
  assert.deepEqual(
    { status: published()!.status, limit: published()!.limit },
    { status: "failed", limit: undefined },
  );
});

test("a published wait survives the swaps of its probes, in a hosted run and in machine run", async (context) => {
  const root = await temporaryDirectory(context);
  const release = join(root, "release");
  await mkdir(join(root, ".machines"));
  // Both presets are limited with no stated reset, so the wait ends in one probe of each when the wait limit is
  // up. The fallback then answers, and holds its turn until the test has looked at what is published.
  await writeFile(join(root, ".machines", "agents.ts"), [
    'import { existsSync } from "node:fs";',
    "export default function agents({ AgentLimitError }) {",
    "  let calls = 0;",
    '  const limit = (harness) => new AgentLimitError("Out of quota", { harness });',
    "  return {",
    '    default: { description: "Stays limited.", fallback: ["spare"], runner: () => { throw limit("fixture"); } },',
    '    spare: { description: "Answers its second call.", runner: async (_request, report) => {',
    '      if (++calls === 1) throw limit("spare");',
    '      report?.({ type: "identity", harness: "spare-again" });',
    `      while (!existsSync(${JSON.stringify(release)})) await new Promise((resolve) => setTimeout(resolve, 10));`,
    '      return { type: "completed" };',
    "    } },",
    "  };",
    "}",
  ].join("\n"));
  await writeFile(join(root, ".machines", "work.ts"), [
    'export const description = "Runs one Agent whose presets are at a usage limit.";',
    "export default function work({ agent, final, machine }) {",
    '  return machine({ initial: "work", states: { work: agent("Do the work.", { completed: "done" }), done: final() } });',
    "}",
  ].join("\n"));
  const waiting = /^default and its fallback \(spare\) reached their usage limits; no reset is stated, retrying until .*Z$/u;
  const swapped = "default reached its usage limit (reset unknown); continuing with spare";
  const hosted = join(root, "hosted");
  const previous = { ...process.env };
  process.env.MACHINES_RUN_STATUS_DIR = hosted;
  process.env.MACHINES_AGENT_LIMIT_WAIT_MINUTES = "0.01";
  process.env.HOME = join(root, "home");
  const session = new McpSession();
  context.after(() => {
    session.close();
    for (const key of ["MACHINES_RUN_STATUS_DIR", "MACHINES_AGENT_LIMIT_WAIT_MINUTES", "HOME"]) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  });

  const started = await session.start({ cwd: root, machine: "work" });
  const { id } = (started.structuredContent as { run: { id: string } }).run;
  type Shown = { status: string; agent?: { harness: string }; limit?: { text: string } };
  const shown = () => (session.status({ runId: id }).structuredContent as { runs: Shown[] }).runs[0]!;
  // The fallback is running again: the probe has swapped to it, and it has yet to resume.
  await eventually(() => assert.equal(shown().agent?.harness, "spare-again"));
  assert.match(shown().limit?.text ?? "", waiting);
  let record = readRunStatuses(hosted).find((found) => found.id === id)!;
  assert.deepEqual({ status: record.status, agent: record.agent }, { status: "running", agent: { harness: "spare-again" } });
  assert.equal(record.limit?.text, shown().limit!.text);
  await writeFile(release, "");
  await eventually(() => assert.equal(shown().status, "completed"));
  assert.equal(shown().limit, undefined);
  assert.equal("limit" in JSON.parse(await readFile(join(hosted, `${id}.json`), "utf8")), false);

  await rm(release);
  const direct = join(root, "direct");
  const inherited = { ...process.env };
  for (const key of ["MACHINES_RUN_OWNER", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "PI_SESSION_ID"]) delete inherited[key];
  const child = spawn(process.execPath, [resolve("src/cli.ts"), "run", "work"], {
    cwd: root, env: { ...inherited, MACHINES_RUN_STATUS_DIR: direct }, stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (text: string) => { stderr += text; });
  const exited = new Promise<number | null>((done) => { child.on("close", done); });
  context.after(() => { child.kill(); });
  await eventually(() => assert.equal(readRunStatuses(direct)[0]?.agent?.harness, "spare-again", stderr));
  record = readRunStatuses(direct)[0]!;
  assert.equal(record.status, "running");
  assert.match(record.limit?.text ?? "", waiting);
  await writeFile(release, "");
  assert.equal(await exited, 0, stderr);
  const lines = stderr.split("\n").filter((line) => line.includes("usage limit"));
  assert.deepEqual([lines[0], lines[2], lines[3]], [swapped, swapped, "default waited for a usage limit to reset; continuing with spare"]);
  assert.match(lines[1]!, waiting);
  assert.equal(lines.length, 4, stderr);
  assert.equal("limit" in JSON.parse(await readFile(join(direct, `${record.id}.json`), "utf8")), false);
});

test("an unusable directory never fails the run it describes", async (context) => {
  const root = await temporaryDirectory(context);
  await writeFile(join(root, "file"), "not a directory");
  const publisher = createRunStatusPublisher(run, { MACHINES_RUN_STATUS_DIR: join(root, "file", "status") });
  // It is a run that is not published, as with publication off.
  assert.equal(publisher.directory, undefined);
  publisher.update({ state: "work" });
  assert.deepEqual(await readdir(root), ["file"]);
  // Nor is the directory tried again at each change: the run stays unpublished throughout.
  await rm(join(root, "file"));
  publisher.update({ state: "review" });
  publisher.finish({ error: "failed" });
  assert.deepEqual(await readdir(root), []);
  assert.deepEqual(readRunStatuses(join(root, "file", "status")), []);
  assert.deepEqual(readRunStatuses(join(root, "missing")), []);

  const published = createRunStatusPublisher(run, { MACHINES_RUN_STATUS_DIR: join(root, "status") });
  assert.equal(published.directory, join(root, "status"));
});

test("a run whose directory cannot be created runs exactly as one with publication off", async (context) => {
  const root = await temporaryDirectory(context);
  const home = join(root, "home");
  await mkdir(home);
  // The home is there, and the standard directory cannot be made inside it.
  await writeFile(join(home, ".local"), "not a directory");
  await writeFile(join(root, "file"), "not a directory");
  const input = join(root, "input.json");
  const observed = join(root, "observed.json");
  const unusable = [
    { MACHINES_RUN_STATUS_DIR: undefined, MACHINES_USER_HOME: home },
    { MACHINES_RUN_STATUS_DIR: join(root, "file", "status"), MACHINES_USER_HOME: home },
  ];
  for (const fail of [false, true]) {
    await writeFile(input, JSON.stringify({ observed, secret: "the output", fail }));
    const off = runCli(["--input-file", input], root, { MACHINES_RUN_STATUS_DIR: "off", MACHINES_USER_HOME: home });
    assert.equal(off.status, fail ? 1 : 0, off.stderr);
    for (const environment of unusable) {
      await rm(observed);
      const result = runCli(["--input-file", input], root, environment);
      // The same outcome and output, and nothing said about the directory at any state.
      assert.deepEqual(
        { status: result.status, stdout: result.stdout, stderr: result.stderr },
        { status: off.status, stdout: off.stdout, stderr: off.stderr },
        JSON.stringify(environment),
      );
      assert.deepEqual(JSON.parse(await readFile(observed, "utf8")), []);
    }
  }
  assert.deepEqual((await readdir(root)).sort(), ["file", "home", "input.json", "observed.json"]);
  assert.deepEqual(await readdir(home), [".local"]);

  // A host asked to publish there completes its run all the same.
  publishFrom(context, unusable[0]!);
  const hosted = await startMachineHost({
    publishRunStatus: true, cwd: root, home: resolve("tests/fixtures/empty-home"), machine: fixture,
    input: { observed, secret: "the output" },
  });
  assert.deepEqual(await hosted.result, { state: "done", output: "the output" });
  assert.deepEqual(await readdir(home), [".local"]);
});

test("creating a publisher prunes settled records older than one hour", async (context) => {
  const directory = await temporaryDirectory(context);
  const exited = spawnSync(process.execPath, ["-e", ""]).pid;
  const old = new Date(Date.now() - 61 * 60 * 1_000).toISOString();
  const recent = new Date(Date.now() - 59 * 60 * 1_000).toISOString();
  const records: Array<Partial<RunStatusRecord>> = [
    { id: "old-completed", status: "completed", updatedAt: old },
    { id: "old-failed", status: "failed", updatedAt: old },
    { id: "old-lost", status: "running", pid: exited, updatedAt: old },
    { id: "old-lost-waiting", status: "waiting", pid: exited, updatedAt: old },
    { id: "old-running", status: "running", updatedAt: old },
    { id: "old-waiting", status: "waiting", updatedAt: old },
    { id: "recent-completed", status: "completed", updatedAt: recent },
    { id: "recent-lost", status: "running", pid: exited, updatedAt: recent },
  ];
  for (const record of records) await writeRecord(directory, record);
  await writeFile(join(directory, "malformed.json"), "{");
  await writeFile(join(directory, "notes.txt"), "not a record");
  // A response nobody collected is pruned with its run, and kept with a run that stays.
  for (const id of ["old-completed", "old-lost-waiting", "old-waiting"]) await writeFile(runInboxPath(directory, id), "{}");
  // So are the other names of a response whose sender or run was stopped while holding one.
  for (const id of ["old-completed", "old-waiting"]) {
    await writeFile(runDeliveryPath(directory, id, "8b5f0b0e-3c0a-4f57-9a55-0d6a2f6f6f01"), "{}");
    await writeFile(join(directory, `.${id}.8b5f0b0e-3c0a-4f57-9a55-0d6a2f6f6f02.inbox.taken`), "{}");
  }
  await writeFile(runDeliveryPath(directory, "old-completed.other", "8b5f0b0e-3c0a-4f57-9a55-0d6a2f6f6f01"), "{}");

  createRunStatusPublisher({ ...run, id: "new" }, { MACHINES_RUN_STATUS_DIR: directory });

  assert.deepEqual((await readdir(directory)).sort(), [
    ".old-completed.other.8b5f0b0e-3c0a-4f57-9a55-0d6a2f6f6f01.inbox.sent",
    ".old-waiting.8b5f0b0e-3c0a-4f57-9a55-0d6a2f6f6f01.inbox.sent",
    ".old-waiting.8b5f0b0e-3c0a-4f57-9a55-0d6a2f6f6f02.inbox.taken",
    "malformed.json",
    "new.json",
    "notes.txt",
    "old-running.json",
    "old-waiting.inbox",
    "old-waiting.json",
    "recent-completed.json",
    "recent-lost.json",
  ]);
});

test("pruning retains records with checkpoints and readers do not mistake checkpoints for records", async (context) => {
  const directory = await temporaryDirectory(context);
  const old = new Date(Date.now() - 61 * 60 * 1_000).toISOString();
  await writeRecord(directory, { id: "saved", status: "failed", updatedAt: old });
  await writeFile(join(directory, "saved.checkpoint.json"), JSON.stringify({ schemaVersion: 1, id: "saved", data: {} }));
  createRunStatusPublisher({ ...run, id: "new" }, { MACHINES_RUN_STATUS_DIR: directory });
  assert.deepEqual(readRunStatuses(directory).map((record) => record.id).sort(), ["new", "saved"]);
  assert.ok((await readdir(directory)).includes("saved.checkpoint.json"));
});

test("creating a publisher removes what stopped processes and ended sessions left, and nothing else", async (context) => {
  const directory = await temporaryDirectory(context);
  const minute = 60 * 1_000;
  const day = 24 * 60 * minute;
  const aged = async (name: string, age: number) => {
    await writeFile(join(directory, name), "{}");
    const then = new Date(Date.now() - age);
    await utimes(join(directory, name), then, then);
  };
  // A write or a response that its process never finished has no record to be pruned with.
  await aged(".gone.4242.1.tmp", 61 * minute);
  await aged(".watch.session.4242.1.tmp", 61 * minute);
  await aged(".gone.8b5f0b0e-3c0a-4f57-9a55-0d6a2f6f6f01.inbox.sent", 61 * minute);
  await aged(".gone.8b5f0b0e-3c0a-4f57-9a55-0d6a2f6f6f02.inbox.taken", 61 * minute);
  await aged(".recent.4242.1.tmp", 59 * minute);
  await aged(".recent.8b5f0b0e-3c0a-4f57-9a55-0d6a2f6f6f01.inbox.sent", 59 * minute);
  // A watch list outlives its session by a month, whether or not anyone watches anything again.
  await aged(".watch.forgotten.json", 31 * day);
  await aged(".watch.dormant.json", 29 * day);
  // An inbox goes with its record. One whose run was pruned without it has none, and waits no longer.
  await aged("orphan.inbox", 61 * minute);
  await aged("orphan.other.inbox", 61 * minute);
  await aged("recent-orphan.inbox", 59 * minute);
  // Files Machines did not name are left alone, however old, and so is an inbox beside a file of its run's name.
  for (const name of [".notes.tmp", ".hidden", "notes.txt", "malformed.json", "malformed.inbox", ".orphan.inbox", ".watch.txt"]) {
    await aged(name, 31 * day);
  }
  await mkdir(join(directory, ".directory.4242.1.tmp"));
  await mkdir(join(directory, "directory.inbox"));
  await utimes(join(directory, "directory.inbox"), new Date(Date.now() - 31 * day), new Date(Date.now() - 31 * day));

  createRunStatusPublisher({ ...run, id: "new" }, { MACHINES_RUN_STATUS_DIR: directory });

  assert.deepEqual((await readdir(directory)).sort(), [
    ".directory.4242.1.tmp",
    ".hidden",
    ".notes.tmp",
    ".orphan.inbox",
    ".recent.4242.1.tmp",
    ".recent.8b5f0b0e-3c0a-4f57-9a55-0d6a2f6f6f01.inbox.sent",
    ".watch.dormant.json",
    ".watch.txt",
    "directory.inbox",
    "malformed.inbox",
    "malformed.json",
    "new.json",
    "notes.txt",
    "recent-orphan.inbox",
  ]);
});

test("a settled record is pruned although a file of its run cannot be removed, and what that leaves is pruned later", async (context) => {
  const directory = await temporaryDirectory(context);
  const old = new Date(Date.now() - 61 * 60 * 1_000);
  const delivery = "8b5f0b0e-3c0a-4f57-9a55-0d6a2f6f6f01";
  // Something that is not a file stands where each of the run's other files would be.
  for (const id of ["blocked-inbox", "blocked-name"]) await writeRecord(directory, { id, status: "completed", updatedAt: old.toISOString() });
  await mkdir(runInboxPath(directory, "blocked-inbox"));
  await writeFile(runDeliveryPath(directory, "blocked-inbox", delivery), "{}");
  await mkdir(runDeliveryPath(directory, "blocked-name", delivery));
  await writeFile(runInboxPath(directory, "blocked-name"), "{}");

  createRunStatusPublisher({ ...run, id: "first" }, { MACHINES_RUN_STATUS_DIR: directory });

  // Neither record is kept for good by what could not be removed, and everything that could be has gone.
  assert.deepEqual((await readdir(directory)).sort(), [
    `.blocked-name.${delivery}.inbox.sent`,
    "blocked-inbox.inbox",
    "first.json",
  ]);

  // A publisher stopped after a record went, and before its inbox, leaves the inbox for a later one.
  await rm(runInboxPath(directory, "blocked-inbox"), { recursive: true });
  await writeFile(runInboxPath(directory, "blocked-inbox"), "{}");
  createRunStatusPublisher({ ...run, id: "second" }, { MACHINES_RUN_STATUS_DIR: directory });
  assert.equal((await readdir(directory)).includes("blocked-inbox.inbox"), true);
  await utimes(runInboxPath(directory, "blocked-inbox"), old, old);
  createRunStatusPublisher({ ...run, id: "third" }, { MACHINES_RUN_STATUS_DIR: directory });
  assert.deepEqual((await readdir(directory)).sort(), [
    `.blocked-name.${delivery}.inbox.sent`,
    "first.json",
    "second.json",
    "third.json",
  ]);
});

test("reading skips unreadable and malformed files", async (context) => {
  const directory = await temporaryDirectory(context);
  await writeRecord(directory, {
    id: "valid", owner: "session", state: "review", agent: { harness: "claude" }, answeredBy: "host", continuedBy: "host",
  });
  await writeRecord(directory, { id: "valid-1", schemaVersion: 1, status: "waiting", human: { prompt: "Approve?" } });
  await writeRecord(directory, {
    id: "valid-2", status: "waiting",
    human: { prompt: "Approve?", requestId: "request-1", choices: ["yes"], suggestions: [], discussion: true },
  });
  await writeFile(runInboxPath(directory, "valid"), JSON.stringify({ requestId: "request-1", response: "yes" }));
  await writeFile(join(directory, "truncated.json"), '{"schemaVersion":1,"id":"trunc');
  await writeFile(join(directory, "array.json"), "[]");
  await writeFile(join(directory, "null.json"), "null");
  await writeFile(join(directory, "readme.txt"), "not a record");
  await mkdir(join(directory, "directory.json"));
  const invalid: Array<Record<string, unknown>> = [
    { schemaVersion: 3 },
    { status: "paused" },
    { pid: 0 },
    { pid: "1" },
    { machine: 7 },
    { updatedAt: "yesterday-ish" },
    { startedAt: undefined },
    { state: { nested: "value" } },
    { agent: { model: "opus" } },
    { human: "Approve?" },
    { human: { prompt: "Approve?", requestId: 7 } },
    { human: { prompt: "Approve?", choices: "yes" } },
    { human: { prompt: "Approve?", suggestions: [7] } },
    { human: { prompt: "Approve?", discussion: "yes" } },
    { deliveries: "delivery-1" },
    { answeredBy: "inbox" },
    { continuedBy: "scheduler" },
    { owner: 7 },
    { limit: "soon" },
    { limit: { until: "2026-10-10T21:00:00Z" } },
    { limit: { text: "Waiting", until: 7 } },
  ];
  for (const [index, change] of invalid.entries()) {
    await writeRecord(directory, { id: `invalid-${index}`, ...change } as Partial<RunStatusRecord>);
  }

  assert.deepEqual(readRunStatuses(directory).map((record) => record.id).sort(), ["valid", "valid-1", "valid-2"]);
});

test("reading accepts a record with or without a note, and skips one whose note is not text", async (context) => {
  const directory = await temporaryDirectory(context);
  const note = "Parked on ticket/org-12: which base should the branch take?\nNeeds: a decision from the ticket owner.";
  await writeRecord(directory, { id: "with-note", status: "completed", state: "parked", note });
  await writeRecord(directory, { id: "without-note", status: "completed", state: "done" });
  for (const [index, invalid] of [7, ["Parked"], { text: "Parked" }].entries()) {
    await writeRecord(directory, { id: `invalid-${index}`, status: "completed", note: invalid } as unknown as Partial<RunStatusRecord>);
  }

  const records = readRunStatuses(directory).sort((left, right) => left.id.localeCompare(right.id));
  assert.deepEqual(
    records.map((record) => ({ id: record.id, schemaVersion: record.schemaVersion, note: record.note })),
    [{ id: "with-note", schemaVersion: 2, note }, { id: "without-note", schemaVersion: 2, note: undefined }],
  );
  assert.equal("note" in records[1]!, false);
});

test("machine run publishes a running record and then its completion", async (context) => {
  const root = await temporaryDirectory(context);
  const directory = join(root, "status");
  const input = join(root, "input.json");
  await writeFile(input, JSON.stringify({ observed: join(root, "observed.json"), secret: "never-published-value" }));

  const result = runCli(["--input-file", input], process.cwd(), {
    MACHINES_RUN_STATUS_DIR: directory, CLAUDE_CODE_SESSION_ID: "claude-session",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /never-published-value/u);
  assert.equal(result.stderr, "● run-status.machine · observe\n● run-status.machine · done\n");

  const observed: RunStatusRecord[] = JSON.parse(await readFile(join(root, "observed.json"), "utf8"));
  assert.equal(observed.length, 1);
  const running = observed[0]!;
  assert.deepEqual(
    { status: running.status, state: running.state, owner: running.owner, machine: running.machine },
    { status: "running", state: "observe", owner: "claude-session", machine: "run-status.machine" },
  );
  assert.deepEqual({ path: running.path, cwd: running.cwd }, { path: fixture, cwd: process.cwd() });

  const files = await readdir(directory);
  assert.deepEqual(files, [`${running.id}.json`]);
  const text = await readFile(join(directory, files[0]!), "utf8");
  assert.doesNotMatch(text, /never-published-value|observed\.json/u);
  const completed = readRunStatuses(directory)[0]!;
  assert.deepEqual(
    { ...completed, stateSince: undefined, updatedAt: undefined, trail: undefined },
    { ...running, status: "completed", state: "done", stateSince: undefined, updatedAt: undefined, trail: undefined },
  );
  // The trail grows by the state the run ended in; the graph was published with the first record.
  assert.deepEqual(completed.trail?.map((step) => step.state), ["observe", "done"]);
  assert.deepEqual(completed.trail?.[0], running.trail?.[0]);
  assert.deepEqual(completed.graph?.states.map((state) => state.id), ["observe", "done"]);
  assert.ok(Date.parse(completed.updatedAt) >= Date.parse(running.updatedAt));
  assert.equal((await stat(join(directory, files[0]!))).mode & 0o777, 0o600);
});

test("machine run publishes a failure with its message", async (context) => {
  const root = await temporaryDirectory(context);
  const directory = join(root, "status");
  const input = join(root, "input.json");
  await writeFile(input, JSON.stringify({ observed: join(root, "observed.json"), fail: true, secret: "unpublished" }));

  const result = runCli(["--input-file", input], process.cwd(), {
    MACHINES_RUN_STATUS_DIR: directory, MACHINES_RUN_OWNER: "explicit-owner", CLAUDE_CODE_SESSION_ID: "claude-session",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /run-status fixture failed/u);

  const observed: RunStatusRecord[] = JSON.parse(await readFile(join(root, "observed.json"), "utf8"));
  assert.equal(observed[0]?.status, "running");
  const records = readRunStatuses(directory);
  assert.equal(records.length, 1);
  assert.deepEqual(
    { status: records[0]!.status, state: records[0]!.state, owner: records[0]!.owner, error: records[0]!.error },
    {
      status: "failed",
      state: "observe",
      owner: "explicit-owner",
      error: 'Operation failed in state "observe": run-status fixture failed',
    },
  );
});

test("machine run publishes the summary of its final output as the run's note", async (context) => {
  const root = await temporaryDirectory(context);
  /** The one record a run of the fixture leaves, as it is in its file, having ended with `output`. */
  const finished = async (name: string, output: JsonValue): Promise<{ record: RunStatusRecord; text: string }> => {
    const directory = join(root, name);
    const input = join(root, `${name}.json`);
    await writeFile(input, JSON.stringify(output));
    const result = runCli(["--input-file", input], process.cwd(), { MACHINES_RUN_STATUS_DIR: directory }, structured);
    assert.equal(result.status, 0, result.stderr);
    const files = await readdir(directory);
    assert.equal(files.length, 1);
    const text = await readFile(join(directory, files[0]!), "utf8");
    return { record: JSON.parse(text), text };
  };

  const summary = "Parked on ticket/org-12: which base should the branch take?\nNeeds: a decision from the ticket owner.";
  const parked = await finished("parked", { summary, branch: "ticket/org-12", secret: "never-published-value" });
  assert.deepEqual(
    { schemaVersion: parked.record.schemaVersion, status: parked.record.status, state: parked.record.state, note: parked.record.note },
    { schemaVersion: 2, status: "completed", state: "done", note: summary },
  );
  // The summary is all of the output that is published.
  assert.doesNotMatch(parked.text, /never-published-value|ticket\/org-12"/u);

  const without: Array<[string, JsonValue]> = [
    ["text", "Parked: only text, not an object with a summary"],
    ["other", { result: "Parked", secret: "never-published-value" }],
    ["empty", { summary: "" }],
    ["blank", { summary: " \n\t " }],
    ["number", { summary: 7 }],
    ["list", { summary: ["Parked"] }],
    ["null", null],
  ];
  for (const [name, output] of without) {
    const { record, text } = await finished(name, output);
    assert.deepEqual(
      { status: record.status, state: record.state, hasNote: "note" in record },
      { status: "completed", state: "done", hasNote: false },
      name,
    );
    assert.doesNotMatch(text, /Parked|never-published-value/u, name);
  }
});

test("machine run publishes the identity of an Agent entered by a transition, and clears it on leaving", async (context) => {
  const root = await temporaryDirectory(context);
  const directory = join(root, "status");
  const home = join(root, "home");
  const observed = join(root, "observed");
  await mkdir(home);
  await mkdir(observed);

  const result = runCli([], resolve("tests/fixtures/run-status-agent"), {
    MACHINES_RUN_STATUS_DIR: directory, MACHINES_USER_HOME: home, RUN_STATUS_OBSERVED: observed,
  }, "work");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "● work · prepare\n● work · work\n● work · settle\n● work · done\n");

  const during = async (state: string): Promise<RunStatusRecord[]> =>
    JSON.parse(await readFile(join(observed, `${state}.json`), "utf8"));
  assert.deepEqual(
    (await during("work")).map(({ status, state, agent }) => ({ status, state, agent })),
    [{ status: "running", state: "work", agent: { harness: "fixture", model: "tiny", thinking: "low" } }],
  );
  // The runner's last identity arrived just before the state changed and must not outlive it.
  const settling = await during("settle");
  assert.deepEqual(settling.map(({ status, state }) => ({ status, state })), [{ status: "running", state: "settle" }]);
  assert.equal("agent" in settling[0]!, false);
  const completed = readRunStatuses(directory);
  assert.deepEqual(completed.map(({ status, state }) => ({ status, state })), [{ status: "completed", state: "done" }]);
  assert.equal("agent" in completed[0]!, false);
});

test("the MCP session publishes its runs under their snapshot ids", async (context) => {
  const directory = await temporaryDirectory(context);
  const previous = process.env.MACHINES_RUN_STATUS_DIR;
  process.env.MACHINES_RUN_STATUS_DIR = directory;
  const session = new McpSession();
  context.after(() => {
    session.close();
    if (previous === undefined) delete process.env.MACHINES_RUN_STATUS_DIR;
    else process.env.MACHINES_RUN_STATUS_DIR = previous;
  });
  const cwd = resolve("tests/fixtures/mcp-project");
  const published = (id: string) => readRunStatuses(directory).find((record) => record.id === id);
  const start = async () => {
    const started = await session.start({ cwd, machine: "review" });
    return (started.structuredContent as { run: { id: string; startedAt: string } }).run;
  };

  const answered = await start();
  await eventually(() => assert.equal(published(answered.id)?.status, "waiting"));
  const waiting = published(answered.id)!;
  assert.deepEqual(
    { pid: waiting.pid, machine: waiting.machine, cwd: waiting.cwd, startedAt: waiting.startedAt },
    { pid: process.pid, machine: "review", cwd, startedAt: answered.startedAt },
  );
  const snapshot = (session.status({ runId: answered.id }).structuredContent as {
    runs: Array<{ human: { requestId: string; prompt: string } }>;
  }).runs[0]!;
  assert.deepEqual(waiting.human, {
    prompt: snapshot.human.prompt, requestId: snapshot.human.requestId, choices: ["approve", "deny"],
  });
  await session.respond({ runId: answered.id, requestId: snapshot.human.requestId, response: "approve" });
  await eventually(() => assert.equal(published(answered.id)?.status, "completed"));
  assert.deepEqual(
    { state: published(answered.id)!.state, human: published(answered.id)!.human },
    { state: "done", human: undefined },
  );

  // A published request is also answerable through the run's inbox, by any process of the same user.
  const outside = await start();
  await eventually(() => assert.equal(published(outside.id)?.status, "waiting"));
  const requestId = published(outside.id)!.human!.requestId!;
  const delivery = { directory, runId: outside.id, requestId };
  await assert.rejects(respondToRun({ ...delivery, response: "maybe" }), /Expected one of: approve, deny/u);
  await assert.rejects(
    respondToRun({ ...delivery, response: { type: "question", text: "Why?" } }),
    /does not support discussion/u,
  );
  await respondToRun({ ...delivery, response: "approve" });
  await eventually(() => assert.equal(published(outside.id)?.status, "completed"));
  await assert.rejects(session.respond({ runId: outside.id, requestId, response: "approve" }), /not waiting/u);
  assert.deepEqual((await readdir(directory)).filter((name) => !name.endsWith(".json")), []);

  const abandoned = await start();
  await eventually(() => assert.equal(published(abandoned.id)?.status, "waiting"));
  session.close();
  assert.deepEqual(
    { status: published(abandoned.id)!.status, error: published(abandoned.id)!.error },
    { status: "failed", error: "Machine session closed" },
  );
  assert.equal(published(answered.id)?.status, "completed");
});

test("an MCP-hosted run publishes a discussion request and takes a question through its inbox", async (context) => {
  const directory = await temporaryDirectory(context);
  const previous = process.env.MACHINES_RUN_STATUS_DIR;
  process.env.MACHINES_RUN_STATUS_DIR = directory;
  const session = new McpSession();
  context.after(() => {
    session.close();
    if (previous === undefined) delete process.env.MACHINES_RUN_STATUS_DIR;
    else process.env.MACHINES_RUN_STATUS_DIR = previous;
  });
  const started = await session.start({
    cwd: resolve("tests/fixtures"), machine: resolve("tests/fixtures/human-inbox.machine.ts"), input: "discussion",
  });
  const { id } = (started.structuredContent as { run: { id: string } }).run;
  const waiting = async (after?: string) => {
    let human: RunStatusRecord["human"];
    await eventually(() => {
      human = readRunStatuses(directory).find((record) => record.id === id && record.status === "waiting")?.human;
      assert.ok(human?.requestId !== undefined && human.requestId !== after);
    });
    return human!;
  };

  const first = await waiting();
  assert.deepEqual(first, {
    prompt: "Approve the plan?\nIt changes three files.", requestId: first.requestId, choices: ["approve"], discussion: true,
  });
  const delivery = { directory, runId: id, requestId: first.requestId! };
  await assert.rejects(respondToRun({ ...delivery, response: { type: "question", text: " " } }), /Question must contain/u);
  await respondToRun({ ...delivery, response: { type: "question", text: "Why three?" } });

  // The question is not an answer: the Machine asks again, as a new request that also allows discussion.
  const second = await waiting(first.requestId);
  assert.deepEqual(second, { prompt: "Approve it now?", requestId: second.requestId, choices: ["approve"], discussion: true });
  await assert.rejects(
    respondToRun({ ...delivery, response: { type: "question", text: "Why?" } }),
    /is waiting on request /u,
  );
  await respondToRun({ ...delivery, requestId: second.requestId!, response: "approve" });
  await eventually(() => assert.equal(readRunStatuses(directory)[0]?.status, "completed"));
  const [completed] = (session.status({ runId: id }).structuredContent as { runs: Array<{ output: unknown }> }).runs;
  assert.deepEqual(completed!.output, [
    { type: "question", value: "Why three?" },
    { type: "submitted", value: "approve" },
  ]);
  const text = await readFile(join(directory, `${id}.json`), "utf8");
  assert.doesNotMatch(text, /Why three\?|"human"/u);
  assert.deepEqual(await readdir(directory), [`${id}.json`]);
});

test("a hosted run publishes what machine run does, from its first state to its outcome", async (context) => {
  const root = await temporaryDirectory(context);
  const directory = join(root, "status");
  const release = join(root, "release");
  await mkdir(join(root, ".machines"));
  await writeFile(join(root, ".machines", "agents.ts"), [
    'import { existsSync } from "node:fs";',
    "export default function agents() {",
    '  return { default: { description: "Says who it is, then holds its turn.", runner: async (_request, report) => {',
    '    report?.({ type: "identity", harness: "fixture", model: "tiny", thinking: "low" });',
    `    while (!existsSync(${JSON.stringify(release)})) await new Promise((resolve) => setTimeout(resolve, 10));`,
    '    return { type: "completed" };',
    "  } } };",
    "}",
  ].join("\n"));
  // The Agent state is entered by a transition, so its identity is reported before the state is.
  await writeFile(join(root, ".machines", "work.ts"), [
    'export const description = "Prepares, runs one Agent, and asks for approval.";',
    "export default function work({ agent, final, human, machine, operation }) {",
    '  return machine({ initial: "prepare", states: {',
    '    prepare: operation(() => ({ type: "prepared" }), { prepared: "work" }),',
    '    work: agent("Do the work.", { completed: "review" }),',
    '    review: human("Approve the work?\\nIt changes three files.", { submitted: "done" }, { choices: ["approve", "deny"] }),',
    "    done: final(),",
    "  } });",
    "}",
  ].join("\n"));
  publishFrom(context, {
    MACHINES_RUN_STATUS_DIR: directory, MACHINES_RUN_LABEL: "org-9 → machines: Watch runs\nsecond line",
    MACHINES_RUN_OWNER: "session-9",
  });
  const human = deferred<HostedHumanRequest>();
  const hosted = await startMachineHost({
    cwd: root, publishRunStatus: true, home: join(root, "home"), machine: "work", onHumanRequest: human.resolve,
  });
  context.after(() => hosted.terminate());
  const published = () => readRunStatuses(directory)[0];
  const identity = { harness: "fixture", model: "tiny", thinking: "low" };

  await eventually(() => assert.deepEqual(published()?.agent, identity));
  const { id, startedAt, updatedAt, stateSince, graph, trail, ...running } = published()!;
  assert.equal(id, hosted.id);
  assert.deepEqual(running, {
    schemaVersion: 2, pid: process.pid, owner: "session-9", label: "org-9 → machines: Watch runs",
    machine: "work", path: hosted.path, cwd: root, status: "running", state: "work", agent: identity, answeredBy: "host",
  });
  // The hosted process reads the graph and the host publishes it, with the states entered so far.
  assert.deepEqual(graph, {
    initial: "prepare",
    states: [{ id: "prepare", kind: "operation" }, { id: "work", kind: "agent", role: "default" }, { id: "review", kind: "human" }, { id: "done", kind: "final" }],
    edges: [{ from: "prepare", to: "work", event: "prepared" }, { from: "work", to: "review", event: "completed" }, { from: "review", to: "done", event: "submitted" }],
  });
  assert.deepEqual(trail?.map((step) => step.state), ["prepare", "work"]);
  assert.ok(Date.parse(stateSince!) >= Date.parse(startedAt) && Date.parse(updatedAt) >= Date.parse(stateSince!));
  assert.deepEqual((await readdir(directory)).sort(), [`${id}.checkpoint.json`, `${id}.json`]);
  assert.equal((await stat(join(directory, `${id}.json`))).mode & 0o777, 0o600);

  await writeFile(release, "");
  const request = await human.promise;
  await eventually(() => assert.equal(published()?.status, "waiting"));
  assert.deepEqual(
    { state: published()!.state, agent: published()!.agent, human: published()!.human },
    // The request id is the host's to use, so the record does not offer it.
    { state: "review", agent: undefined, human: { prompt: "Approve the work?\nIt changes three files.", choices: ["approve", "deny"] } },
  );

  // Nothing reads an inbox for this run, so a response is refused instead of being left in one.
  const refused = /Machine run "[^"]+" is answered through the program hosting it, not by machine respond/u;
  await assert.rejects(respondToRun({ directory, runId: id, requestId: request.requestId, response: "approve" }), refused);
  const responded = spawnSync(process.execPath, [resolve("src/cli.ts"), "respond", id, request.requestId, "approve"], {
    encoding: "utf8", env: { ...process.env, MACHINES_RUN_STATUS_DIR: directory },
  });
  assert.equal(responded.status, 1);
  assert.match(responded.stderr, refused);
  assert.equal(published()!.status, "waiting");
  assert.deepEqual((await readdir(directory)).sort(), [`${id}.checkpoint.json`, `${id}.json`]);
  const listed = spawnSync(process.execPath, [resolve("src/cli.ts"), "runs"], {
    encoding: "utf8", env: { ...process.env, MACHINES_RUN_STATUS_DIR: directory },
  });
  assert.equal(listed.stdout, [
    `${id}\twork\twaiting\treview\torg-9 → machines: Watch runs`,
    "  Approve the work?", "  It changes three files.", "  answered through its host", "  choices: approve, deny", "",
  ].join("\n"), listed.stderr);

  await hosted.respond("approve", request.requestId);
  assert.deepEqual(await hosted.result, { state: "done" });
  // Like machine run, it leaves its outcome behind for readers, and later runs prune it.
  const { updatedAt: finishedAt, graph: _graph, trail: finalTrail, ...completed } = published()!;
  assert.deepEqual(finalTrail?.map((step) => step.state), ["prepare", "work", "review", "done"]);
  assert.deepEqual(completed, {
    schemaVersion: 2, id, pid: process.pid, owner: "session-9", label: "org-9 → machines: Watch runs",
    machine: "work", path: hosted.path, cwd: root, status: "completed", state: "done", answeredBy: "host", startedAt,
  });
  assert.ok(Date.parse(finishedAt) >= Date.parse(updatedAt));
  assert.deepEqual(await readdir(directory), [`${id}.json`]);
});

test("a hosted run's label and owner options replace the environment's, and every ending is recorded", async (context) => {
  const directory = await temporaryDirectory(context);
  publishFrom(context, {
    MACHINES_RUN_STATUS_DIR: directory, MACHINES_RUN_LABEL: "from the environment", MACHINES_RUN_OWNER: "environment-owner",
  });
  const hostFixture = resolve("tests/fixtures/host.machine.ts");
  const only = () => {
    const records = readRunStatuses(directory);
    assert.equal(records.length, 1);
    return records[0]!;
  };
  const clear = async () => { for (const name of await readdir(directory)) await rm(join(directory, name)); };

  const failing = await startMachineHost({
    machine: hostFixture, publishRunStatus: true, input: "fail", label: `\n  org-9: ${"x".repeat(300)}\nsecond line`, owner: "session-9",
  });
  await assert.rejects(failing.result, /host fixture failed/u);
  assert.deepEqual(
    { label: only().label, owner: only().owner, status: only().status, state: only().state, error: only().error },
    {
      label: `org-9: ${"x".repeat(153)}`, owner: "session-9", status: "failed", state: "work",
      error: 'Operation failed in state "work": host fixture failed',
    },
  );
  assert.deepEqual({ machine: only().machine, path: only().path, cwd: only().cwd, pid: only().pid }, {
    machine: "host.machine", path: hostFixture, cwd: process.cwd(), pid: process.pid,
  });

  // An empty option says the run has none, whatever the environment names.
  await clear();
  const human = deferred<HostedHumanRequest>();
  const terminated = await startMachineHost({ machine: hostFixture, publishRunStatus: true, label: "", owner: "", onHumanRequest: human.resolve });
  await human.promise;
  await eventually(() => assert.equal(only().status, "waiting"));
  assert.deepEqual({ label: only().label, owner: only().owner }, { label: undefined, owner: undefined });
  terminated.terminate();
  await assert.rejects(terminated.result, /terminated/u);
  assert.deepEqual(
    { status: only().status, human: only().human, error: only().error },
    { status: "failed", human: undefined, error: "Machine host was terminated" },
  );

  // The hosted process cannot record its own death; the host that outlives it does.
  await clear();
  const exited = await startMachineHost({ machine: hostFixture, publishRunStatus: true, input: "exit" });
  await assert.rejects(exited.result, /exited before completion/u);
  assert.deepEqual(
    { label: only().label, owner: only().owner, status: only().status, error: only().error },
    {
      label: "from the environment", owner: "environment-owner", status: "failed",
      error: "Machine host exited before completion (code 17)",
    },
  );
});

test("a hosted run publishes the summary of its final output as the run's note, as machine run does", async (context) => {
  const directory = await temporaryDirectory(context);
  publishFrom(context, { MACHINES_RUN_STATUS_DIR: directory });
  const finished = async (output: JsonValue): Promise<RunStatusRecord> => {
    for (const name of await readdir(directory)) await rm(join(directory, name));
    const hosted = await startMachineHost({ machine: structured, publishRunStatus: true, input: output });
    assert.deepEqual(await hosted.result, { state: "done", output });
    assert.deepEqual(await readdir(directory), [`${hosted.id}.json`]);
    return JSON.parse(await readFile(join(directory, `${hosted.id}.json`), "utf8"));
  };

  const summary = "Parked on ticket/org-12: which base should the branch take?\nNeeds: a decision from the ticket owner.";
  const parked = await finished({ summary, branch: "ticket/org-12" });
  assert.deepEqual(
    { schemaVersion: parked.schemaVersion, status: parked.status, state: parked.state, note: parked.note, branch: "branch" in parked },
    { schemaVersion: 2, status: "completed", state: "done", note: summary, branch: false },
  );

  const without: JsonValue[] = ["Parked: only text", { result: "Parked" }, { summary: "" }, { summary: " \n\t " }, { summary: 7 }, null];
  for (const output of without) {
    const record = await finished(output);
    assert.deepEqual(
      { status: record.status, state: record.state, hasNote: "note" in record },
      { status: "completed", state: "done", hasNote: false },
      JSON.stringify(output),
    );
  }
});

test("a run started through the MCP server publishes the summary of its final output as the run's note, as machine run does", async (context) => {
  const root = await temporaryDirectory(context);
  const directory = join(root, "mcp");
  publishFrom(context, { MACHINES_RUN_STATUS_DIR: directory });
  const session = new McpSession();
  context.after(() => session.close());
  /** The record a run of the fixture leaves, as it is in its file, having ended with `output`. */
  const finished = async (output: JsonValue): Promise<{ record: RunStatusRecord; text: string }> => {
    const started = await session.start({ cwd: process.cwd(), machine: structured, input: output });
    const { id } = (started.structuredContent as { run: { id: string } }).run;
    await eventually(() => assert.equal(readRunStatuses(directory).find((record) => record.id === id)?.status, "completed"));
    const text = await readFile(join(directory, `${id}.json`), "utf8");
    return { record: JSON.parse(text), text };
  };

  const summary = "Parked on ticket/org-16: which base should the branch take?\nNeeds: a decision from the ticket owner.";
  const parked = await finished({ summary, branch: "ticket/org-16", secret: "never-published-value" });
  assert.deepEqual(
    { schemaVersion: parked.record.schemaVersion, status: parked.record.status, state: parked.record.state, note: parked.record.note },
    { schemaVersion: 2, status: "completed", state: "done", note: summary },
  );
  // The summary is all of the output that is published.
  assert.doesNotMatch(parked.text, /never-published-value|ticket\/org-16"/u);

  // Trimmed and cut as machine run cuts it: the same output leaves the same note either way.
  const long = { summary: ` \n${"word ".repeat(500)}\n ` };
  const input = join(root, "long.json");
  await writeFile(input, JSON.stringify(long));
  const cli = runCli(["--input-file", input], process.cwd(), { MACHINES_RUN_STATUS_DIR: join(root, "cli") }, structured);
  assert.equal(cli.status, 0, cli.stderr);
  const cut = (await finished(long)).record.note;
  assert.equal(cut, `${"word ".repeat(400).trimEnd()}…`);
  assert.deepEqual(readRunStatuses(join(root, "cli")).map((record) => record.note), [cut]);
  assert.equal((await finished({ summary: "a".repeat(2001) })).record.note, `${"a".repeat(1999)}…`);

  const without: JsonValue[] = [
    "Parked: only text, not an object with a summary",
    { result: "Parked", secret: "never-published-value" },
    { summary: "" },
    { summary: " \n\t " },
    { summary: 7 },
    { summary: ["Parked"] },
    null,
  ];
  for (const output of without) {
    const { record, text } = await finished(output);
    assert.deepEqual(
      { status: record.status, state: record.state, hasNote: "note" in record },
      { status: "completed", state: "done", hasNote: false },
      JSON.stringify(output),
    );
    assert.doesNotMatch(text, /Parked|never-published-value/u, JSON.stringify(output));
  }
});

test("a host asked to publish, with nothing set, publishes in the standard directory of its home", async (context) => {
  const root = await temporaryDirectory(context);
  const home = join(root, "home");
  const directory = standardDirectory(home);
  publishFrom(context, { MACHINES_RUN_STATUS_DIR: undefined, MACHINES_USER_HOME: home, XDG_STATE_HOME: join(root, "unused") });
  const start = async (publishRunStatus: boolean) => {
    const hosted = await startMachineHost({
      publishRunStatus, cwd: root, home: resolve("tests/fixtures/empty-home"), machine: fixture,
      input: { observed: join(root, "observed.json"), secret: "never-published-value" },
    });
    return hosted.result;
  };

  // An embedding program still has to ask: the default alone publishes nothing for it.
  assert.deepEqual(await start(false), { state: "done", output: "never-published-value" });
  assert.deepEqual(await readdir(root), ["observed.json"]);

  assert.deepEqual(await start(true), { state: "done", output: "never-published-value" });
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  const records = readRunStatuses(directory);
  assert.deepEqual(
    records.map(({ pid, machine, cwd, status, state, answeredBy }) => ({ pid, machine, cwd, status, state, answeredBy })),
    [{ pid: process.pid, machine: "run-status.machine", cwd: root, status: "completed", state: "done", answeredBy: "host" }],
  );
  assert.deepEqual(await readdir(directory), [`${records[0]!.id}.json`]);
  assert.equal((await stat(join(directory, `${records[0]!.id}.json`))).mode & 0o777, 0o600);
  assert.deepEqual((await readdir(root)).sort(), ["home", "observed.json"]);

  publishFrom(context, { MACHINES_RUN_STATUS_DIR: "off" });
  assert.deepEqual(await start(true), { state: "done", output: "never-published-value" });
  assert.deepEqual(await readdir(directory), [`${records[0]!.id}.json`]);
});

test("a hosted run publishes a wait for a usage limit", async (context) => {
  const directory = await temporaryDirectory(context);
  publishFrom(context, { MACHINES_RUN_STATUS_DIR: directory });
  const hosted = await startMachineHost({
    publishRunStatus: true, cwd: resolve("tests/fixtures/agent-limit-project"), home: resolve("tests/fixtures/empty-home"),
    machine: "work", agents: { default: "waits" },
  });
  context.after(() => hosted.terminate());

  await eventually(() => assert.ok(readRunStatuses(directory)[0]?.limit !== undefined));
  const record = readRunStatuses(directory)[0]!;
  assert.deepEqual({ status: record.status, state: record.state }, { status: "running", state: "work" });
  assert.match(record.limit!.text, /^waits \(role default\) reached its usage limit; waiting for the reset at \d{4}-.*Z$/u);
  assert.ok(Date.parse(record.limit!.until!) > Date.now());
  hosted.terminate();
  assert.deepEqual(
    { status: readRunStatuses(directory)[0]!.status, limit: readRunStatuses(directory)[0]!.limit },
    { status: "failed", limit: undefined },
  );
});

test("a hosted run is the parent of the runs it starts, and publishes nothing while publication is off", async (context) => {
  const root = await temporaryDirectory(context);
  const directory = join(root, "status");
  await mkdir(join(root, ".machines"));
  await mkdir(join(root, "home"));
  await writeFile(join(root, ".machines", "inner.ts"), [
    'export const description = "Finishes at once.";',
    "export default function inner({ final, machine, operation }) {",
    '  return machine({ initial: "work", states: { work: operation(() => ({ type: "worked" }), { worked: "done" }), done: final() } });',
    "}",
  ].join("\n"));
  await writeFile(join(root, ".machines", "outer.ts"), [
    'import { spawnSync } from "node:child_process";',
    'export const description = "Starts another Machine from an Operation, and outputs the run that one belongs to.";',
    "export default function outer({ final, machine, operation }, input) {",
    '  return machine({ initial: "start", output: () => process.env.MACHINES_RUN_PARENT ?? null, states: {',
    "    start: operation(() => {",
    '      if (input !== "nested") return { type: "started" };',
    `      const started = spawnSync(process.execPath, [${JSON.stringify(resolve("src/cli.ts"))}, "run", "inner"], { encoding: "utf8" });`,
    "      if (started.status !== 0) throw new Error(started.stderr);",
    '      return { type: "started" };',
    '    }, { started: "done" }),',
    "    done: final(),",
    "  } });",
    "}",
  ].join("\n"));
  const start = async (input: string) => {
    const hosted = await startMachineHost({
      cwd: root, publishRunStatus: true, home: join(root, "home"), machine: "outer", input, label: "org-9: Watch runs", owner: "session-9",
    });
    return hosted.result;
  };

  // Off: the options alone publish nothing, and the hosted process is told of no run.
  for (const off of ["off", ""]) {
    publishFrom(context, { MACHINES_RUN_STATUS_DIR: off });
    assert.deepEqual(await start("alone"), { state: "done", output: null });
  }
  assert.deepEqual((await readdir(root)).sort(), [".machines", "home"]);
  assert.deepEqual(await readdir(join(root, "home")), []);

  // On: the run itself belongs to whatever run started its host, and its own id is what it hands down.
  publishFrom(context, {
    MACHINES_RUN_STATUS_DIR: directory, MACHINES_RUN_PARENT: "enclosing-run", MACHINES_USER_HOME: join(root, "home"),
  });
  const { output } = await start("nested");
  const records = Object.fromEntries(readRunStatuses(directory).map((record) => [record.machine, record]));
  assert.deepEqual(Object.keys(records).sort(), ["inner", "outer"]);
  assert.deepEqual(
    { id: records.outer!.id, parent: records.outer!.parent, status: records.outer!.status, answeredBy: records.outer!.answeredBy },
    { id: output, parent: "enclosing-run", status: "completed", answeredBy: "host" },
  );
  assert.deepEqual(
    { parent: records.inner!.parent, status: records.inner!.status, answeredBy: records.inner!.answeredBy },
    { parent: records.outer!.id, status: "completed", answeredBy: undefined },
  );
  assert.equal(process.env.MACHINES_RUN_PARENT, "enclosing-run");

  // A host that does not ask publishes nothing and hands nothing down, whatever its environment says.
  await rm(directory, { recursive: true });
  const unasked = await startMachineHost({ cwd: root, home: join(root, "home"), machine: "outer", input: "nested" });
  assert.deepEqual(await unasked.result, { state: "done", output: "enclosing-run" });
  assert.deepEqual(
    readRunStatuses(directory).map((record) => ({ machine: record.machine, parent: record.parent })),
    [{ machine: "inner", parent: "enclosing-run" }],
  );

  // A caller that publishes the record itself, as the MCP server does, still has its run's id handed down.
  await rm(directory, { recursive: true });
  const unpublished = await startMachineHost({
    cwd: root, home: join(root, "home"), machine: "outer", input: "nested", publishRunStatus: "caller",
  });
  assert.deepEqual(await unpublished.result, { state: "done", output: unpublished.id });
  assert.deepEqual(
    readRunStatuses(directory).map((record) => ({ machine: record.machine, parent: record.parent })),
    [{ machine: "inner", parent: unpublished.id }],
  );
});

test("a session's run is published under the id the session gives it, which another session can watch", async (context) => {
  const directory = join(await temporaryDirectory(context), "status");
  publishFrom(context, { MACHINES_RUN_STATUS_DIR: directory });
  const session = new MachineSession();
  context.after(() => session.close());
  const run = await session.start({
    publishRunStatus: true, machine: resolve("tests/fixtures/host-sequential.machine.ts"), label: "org-9: Watch runs", owner: "session-9",
  });
  const waiting = async (after?: string) => {
    await eventually(() => {
      const [current] = session.status(run.id);
      assert.ok(current?.human !== undefined && current.human.requestId !== after);
      assert.equal(readRunStatuses(directory)[0]?.status, "waiting");
    });
    return session.status(run.id)[0]!.human!.requestId;
  };

  const first = await waiting();
  const [published] = readRunStatuses(directory);
  assert.deepEqual(
    {
      id: published!.id, pid: published!.pid, owner: published!.owner, label: published!.label, state: published!.state,
      human: published!.human, answeredBy: published!.answeredBy,
    },
    {
      id: run.id, pid: process.pid, owner: "session-9", label: "org-9: Watch runs", state: "first",
      human: { prompt: "Continue?" }, answeredBy: "host",
    },
  );
  assert.deepEqual((await readdir(directory)).sort(), [`${run.id}.checkpoint.json`, `${run.id}.json`]);

  // The id a session reports for its run is the one to watch it by.
  const watcher = { PATH: process.env.PATH, MACHINES_RUN_STATUS_DIR: directory, MACHINES_RUN_OWNER: "watcher" };
  const lines = () => runStatusLines(readRunStatuses(directory), {
    sessionId: "watcher", projectDir: "/elsewhere", watches: readRunWatches(directory, "watcher"), color: false,
  });
  assert.deepEqual(lines(), []);
  const watched = spawnSync(process.execPath, [resolve("src/cli.ts"), "watch", run.id], { encoding: "utf8", env: watcher });
  assert.equal(
    watched.stdout,
    `Watching ${run.id}\n  ${run.id}\thost-sequential.machine\twaiting\tfirst\torg-9: Watch runs\n`,
    watched.stderr,
  );
  assert.equal(lines()[0], "◆ org-9: Watch runs");
  assert.equal(lines().at(-1), "  Continue?");

  // It stays that one record while the session answers it, to its outcome.
  await session.respond({ runId: run.id, requestId: first, response: "yes" });
  await session.respond({ runId: run.id, requestId: await waiting(first), response: "yes" });
  await eventually(() => assert.equal(session.status(run.id)[0]?.status, "completed"));
  assert.deepEqual(
    readRunStatuses(directory).map((record) => ({ id: record.id, status: record.status, state: record.state })),
    [{ id: run.id, status: "completed", state: "done" }],
  );
  assert.deepEqual((await readdir(directory)).sort(), [".watch.watcher.json", `${run.id}.json`]);
});

test("the integrations guide describes a finished run's note for hosts that read the directory", async () => {
  const guide = await readFile(resolve("docs/integrations.md"), "utf8");
  // Where the record is described field by field, before the commands that read it.
  const described = guide.slice(
    guide.indexOf("\n## Run status for host status lines\n"),
    guide.indexOf("\n### Answering a waiting run from outside\n"),
  );
  assert.match(described, /`status` is `running`, `waiting`, `sleeping`, `completed`, or `failed`/u);
  const paragraphs = described.split(/\n{2,}/u).filter((paragraph) => paragraph.includes("`note`"));
  assert.notDeepEqual(paragraphs, [], "the record description names `note`");
  // What a host needs to use it: where it comes from, and how long it can be.
  assert.ok(paragraphs.some((paragraph) => /`summary`/u.test(paragraph)), "it says the note is the final output's `summary`");
  assert.ok(paragraphs.some((paragraph) => /\b2,?000\b/u.test(paragraph)), "it says the note is at most 2000 characters");
});

test("the integrations guide says every way of starting a run that publishes a record publishes its note", async () => {
  const guide = await readFile(resolve("docs/integrations.md"), "utf8");
  const described = guide.slice(
    guide.indexOf("\n## Run status for host status lines\n"),
    guide.indexOf("\n### Answering a waiting run from outside\n"),
  );
  // The paragraph that says where the note comes from, read as one line whatever its wrapping.
  const sources = described.split(/\n{2,}/u)
    .filter((paragraph) => paragraph.includes("`note`") && paragraph.includes("`summary`"))
    .map((paragraph) => paragraph.replace(/\s+/gu, " "));
  assert.equal(sources.length, 1, "one paragraph says the note is the final output's `summary`");
  // The three that keep a record, as the guide lists them where it introduces the record.
  assert.match(described.replace(/\s+/gu, " "), /`machine run`, the MCP server, and a host that asks for it/u);
  assert.match(sources[0]!, /`machine run`/u, "it names machine run");
  assert.match(sources[0]!, /\bMCP server\b/u, "it names the MCP server");
  assert.match(sources[0]!, /\bhost\b/u, "it names a host that publishes");
  assert.match(sources[0]!, /\b(?:all three|each of the three|any of the three|every one of the three)\b/iu, "it says all three publish the note");
});

const publishedFrom = new WeakMap<TestContext, Map<string, string | undefined>>();

/**
 * Sets what this process, as a host, publishes from; an undefined value unsets
 * its variable. After the test each variable is as it was before the test's
 * first call, however many times the test changed it.
 */
function publishFrom(context: TestContext, environment: Readonly<Record<string, string | undefined>>): void {
  const assign = (values: Iterable<readonly [string, string | undefined]>) => {
    for (const [key, value] of values) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  let original = publishedFrom.get(context);
  if (original === undefined) {
    const before = new Map<string, string | undefined>();
    original = before;
    publishedFrom.set(context, before);
    context.after(() => assign(before));
  }
  for (const key of Object.keys(environment)) {
    if (!original.has(key)) original.set(key, process.env[key]);
  }
  assign(Object.entries(environment));
}

function deferred<T>() {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

/** Runs `machine run` with publication off unless `environment` says where; an undefined value unsets its variable. */
function runCli(
  args: readonly string[],
  cwd: string,
  environment: Readonly<Record<string, string | undefined>>,
  machine = fixture,
) {
  const inherited = { ...process.env };
  for (const key of ["MACHINES_RUN_OWNER", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "PI_SESSION_ID"]) delete inherited[key];
  return spawnSync(process.execPath, [resolve("src/cli.ts"), "run", machine, ...args], {
    cwd, encoding: "utf8", env: { ...inherited, MACHINES_RUN_STATUS_DIR: "off", ...environment },
  });
}

async function writeRecord(directory: string, change: Partial<RunStatusRecord>): Promise<void> {
  const now = new Date().toISOString();
  const record = {
    schemaVersion: 2,
    id: "run",
    pid: process.pid,
    machine: "ticket",
    path: "/work/.machines/ticket.ts",
    cwd: "/work",
    status: "running",
    startedAt: now,
    updatedAt: now,
    ...change,
  };
  await writeFile(join(directory, `${record.id}.json`), JSON.stringify(record));
}

async function temporaryDirectory(context: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "machines-run-status-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function eventually(assertion: () => void): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (true) {
    try { assertion(); return; } catch (cause) {
      if (Date.now() >= deadline) throw cause;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}
