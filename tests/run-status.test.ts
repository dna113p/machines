import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, type TestContext } from "node:test";

import { runStatusLines } from "../claude/statusline.mjs";
import { MachineSession as McpSession } from "../mcp/server.ts";
import { startMachineHost, type HostedHumanRequest } from "../src/host.ts";
import { respondToRun } from "../src/run-inbox.ts";
import {
  createRunStatusPublisher,
  readRunStatuses,
  runDeliveryPath,
  runInboxPath,
  type RunStatusRecord,
} from "../src/run-status.ts";
import { readRunWatches } from "../src/run-watch.ts";
import { MachineSession } from "../src/session.ts";

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
  for (const key of ["MACHINES_RUN_OWNER", "CLAUDE_CODE_SESSION_ID"]) delete inherited[key];
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
  await writeRecord(directory, {
    id: "valid", owner: "session", state: "review", agent: { harness: "claude" }, answeredBy: "host",
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
  const { id, startedAt, updatedAt, stateSince, ...running } = published()!;
  assert.equal(id, hosted.id);
  assert.deepEqual(running, {
    schemaVersion: 2, pid: process.pid, owner: "session-9", label: "org-9 → machines: Watch runs",
    machine: "work", path: hosted.path, cwd: root, status: "running", state: "work", agent: identity, answeredBy: "host",
  });
  assert.ok(Date.parse(stateSince!) >= Date.parse(startedAt) && Date.parse(updatedAt) >= Date.parse(stateSince!));
  assert.deepEqual(await readdir(directory), [`${id}.json`]);
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
  assert.deepEqual(await readdir(directory), [`${id}.json`]);
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
  const { updatedAt: finishedAt, ...completed } = published()!;
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
  assert.equal(process.env.MACHINES_RUN_STATUS_DIR, undefined);
  assert.deepEqual(await start("alone"), { state: "done", output: null });
  publishFrom(context, { MACHINES_RUN_STATUS_DIR: "" });
  assert.deepEqual(await start("alone"), { state: "done", output: null });
  assert.deepEqual((await readdir(root)).sort(), [".machines", "home"]);

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
  assert.deepEqual(await readdir(directory), [`${run.id}.json`]);

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

/** Sets what this process, as a host, publishes from, and restores it after the test. */
function publishFrom(context: TestContext, environment: Readonly<Record<string, string>>): void {
  const previous = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
  Object.assign(process.env, environment);
  context.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

function deferred<T>() {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

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
