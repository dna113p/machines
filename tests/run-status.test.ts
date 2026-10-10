import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, type TestContext } from "node:test";

import { MachineSession as McpSession } from "../mcp/server.ts";
import { respondToRun } from "../src/run-inbox.ts";
import {
  createRunStatusPublisher,
  readRunStatuses,
  runDeliveryPath,
  runInboxPath,
  type RunStatusRecord,
} from "../src/run-status.ts";

const run = { machine: "ticket", path: "/work/.machines/ticket.ts", cwd: "/work" };
const fixture = resolve("tests/fixtures/run-status.machine.ts");

test("run status is disabled unless MACHINES_RUN_STATUS_DIR names a directory", async (context) => {
  const cwd = await temporaryDirectory(context);
  for (const environment of [{}, { MACHINES_RUN_STATUS_DIR: "" }, { MACHINES_RUN_OWNER: "owner" }]) {
    const publisher = createRunStatusPublisher(run, environment);
    publisher.update({ state: "work" });
    publisher.finish({ state: "done" });
  }
  const input = join(cwd, "input.json");
  await writeFile(input, JSON.stringify({ observed: join(cwd, "observed.json"), secret: "unpublished" }));
  const result = runCli(["--input-file", input], cwd, {});
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(await readFile(join(cwd, "observed.json"), "utf8")), []);
  assert.deepEqual((await readdir(cwd)).sort(), ["input.json", "observed.json"]);
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

test("an unusable directory never fails the run it describes", async (context) => {
  const root = await temporaryDirectory(context);
  await writeFile(join(root, "file"), "not a directory");
  const publisher = createRunStatusPublisher(run, { MACHINES_RUN_STATUS_DIR: join(root, "file", "status") });
  publisher.update({ state: "work" });
  publisher.finish({ error: "failed" });
  assert.deepEqual(await readdir(root), ["file"]);
  assert.deepEqual(readRunStatuses(join(root, "file", "status")), []);
  assert.deepEqual(readRunStatuses(join(root, "missing")), []);
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

test("reading skips unreadable and malformed files", async (context) => {
  const directory = await temporaryDirectory(context);
  await writeRecord(directory, { id: "valid", owner: "session", state: "review", agent: { harness: "claude" } });
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
    { owner: 7 },
  ];
  for (const [index, change] of invalid.entries()) {
    await writeRecord(directory, { id: `invalid-${index}`, ...change } as Partial<RunStatusRecord>);
  }

  assert.deepEqual(readRunStatuses(directory).map((record) => record.id).sort(), ["valid", "valid-1", "valid-2"]);
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
    { ...completed, stateSince: undefined, updatedAt: undefined },
    { ...running, status: "completed", state: "done", stateSince: undefined, updatedAt: undefined },
  );
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

function runCli(
  args: readonly string[],
  cwd: string,
  environment: Readonly<Record<string, string>>,
  machine = fixture,
) {
  const inherited = { ...process.env };
  for (const key of ["MACHINES_RUN_STATUS_DIR", "MACHINES_RUN_OWNER", "CLAUDE_CODE_SESSION_ID"]) delete inherited[key];
  return spawnSync(process.execPath, [resolve("src/cli.ts"), "run", machine, ...args], {
    cwd, encoding: "utf8", env: { ...inherited, ...environment },
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
