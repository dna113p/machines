import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs, { existsSync, linkSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { mock, test, type TestContext } from "node:test";

import type { HumanRequest } from "../src/index.ts";
import { inboxHuman, respondToRun, watchRunInbox } from "../src/run-inbox.ts";
import {
  createRunStatusPublisher,
  deliveryRetentionMilliseconds,
  readRunStatuses,
  runDeliveryPath,
  runInboxPath,
  type RunStatusHuman,
  type RunStatusRecord,
} from "../src/run-status.ts";

const cli = resolve("src/cli.ts");
const fixture = resolve("tests/fixtures/human-inbox.machine.ts");
const prompt = "Approve the plan?\nIt changes three files.";

test("a waiting run publishes what is needed to show and to answer its request", async (context) => {
  const expected = {
    choices: { choices: ["approve", "deny"] },
    suggestions: { suggestions: ["Use the default"] },
    discussion: { choices: ["approve"], discussion: true },
    text: {},
  };
  for (const [kind, options] of Object.entries(expected)) {
    const directory = join(await temporaryDirectory(context), "status");
    const run = startRun(context, directory, kind);
    const record = await waitingRecord(directory);

    assert.equal(record.schemaVersion, 2, kind);
    assert.match(record.human!.requestId!, /^[0-9a-f-]{36}$/u, kind);
    assert.deepEqual(record.human, { prompt, requestId: record.human!.requestId, ...options }, kind);
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(join(directory, `${record.id}.json`))).mode & 0o777, 0o600);

    const response = kind === "text" ? "a response never published" : "approve";
    assert.equal(machine(directory, "respond", record.id, record.human!.requestId!, response).status, 0);
    assert.equal((await run.exited).code, 0);
    const text = await readFile(join(directory, `${record.id}.json`), "utf8");
    assert.doesNotMatch(text, /a response never published|"human"/u, kind);
  }
});

test("machine respond answers a run that has no terminal, which continues and completes", async (context) => {
  const directory = await temporaryDirectory(context);
  const run = startRun(context, directory, "twice");
  const first = await waitingRecord(directory);
  const firstRequest = first.human!.requestId!;

  // Several words are one response, and `--` lets a response start with a dash.
  const answered = machine(directory, "respond", first.id, firstRequest, "--", "--ship", "it");
  assert.deepEqual(
    { status: answered.status, stdout: answered.stdout, stderr: answered.stderr },
    { status: 0, stdout: `Machine run ${first.id} took the response.\n`, stderr: "" },
  );
  const second = await waitingRecord(directory, firstRequest);
  assert.deepEqual({ state: second.state, prompt: second.human!.prompt }, { state: "again", prompt: "And then?" });
  assert.equal(machine(directory, "respond", first.id, second.human!.requestId!, "").status, 0);

  const exited = await run.exited;
  assert.equal(exited.code, 0, exited.stderr);
  assert.deepEqual(JSON.parse(exited.stdout.slice(exited.stdout.indexOf("[\n"))), [
    { type: "submitted", value: "--ship it" },
    { type: "submitted", value: "" },
  ]);
  assert.match(exited.stdout, /--> done/u);
  // Each request that the terminal could not answer says how to answer it.
  assert.ok(exited.stderr.includes(`No terminal input. Answer with: machine respond ${first.id} ${firstRequest} <response>\n`));
  assert.ok(exited.stderr.includes(`machine respond ${first.id} ${second.human!.requestId} <response>\n`));
  assert.deepEqual(await readdir(directory), [`${first.id}.json`]);
  const [completed] = readRunStatuses(directory);
  assert.deepEqual({ status: completed!.status, human: completed!.human }, { status: "completed", human: undefined });
});

test("a discussion question is delivered only to a request that allows it", async (context) => {
  const directory = await temporaryDirectory(context);
  const discussing = startRun(context, directory, "discussion");
  const first = await waitingRecord(directory);
  const firstRequest = first.human!.requestId!;

  for (const [question, message] of [
    ["  ", /Question must contain 1–8000 characters/u],
    ["x".repeat(8001), /Question must contain 1–8000 characters/u],
  ] as const) {
    const refused = machine(directory, "respond", "--question", first.id, firstRequest, question);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, message);
  }
  const asked = machine(directory, "respond", "--question", first.id, firstRequest, "Why", "three?");
  assert.deepEqual({ status: asked.status, stdout: asked.stdout }, {
    status: 0, stdout: `Machine run ${first.id} took the question.\n`,
  });
  // The question is not an answer: the Machine asks again, as a new request.
  const second = await waitingRecord(directory, firstRequest);
  assert.equal(second.human!.prompt, "Approve it now?");
  assert.equal(machine(directory, "respond", first.id, second.human!.requestId!, "approve").status, 0);
  const exited = await discussing.exited;
  assert.deepEqual(JSON.parse(exited.stdout.slice(exited.stdout.indexOf("[\n"))), [
    { type: "question", value: "Why three?" },
    { type: "submitted", value: "approve" },
  ]);

  const restricted = startRun(context, directory, "choices");
  const record = await waitingRecord(directory, undefined, first.id);
  const refused = machine(directory, "respond", "--question", record.id, record.human!.requestId!, "Why?");
  assert.deepEqual({ status: refused.status, stderr: refused.stderr }, {
    status: 1, stderr: "This Human request does not support discussion\n",
  });
  assert.equal(existsSync(runInboxPath(directory, record.id)), false);
  assert.equal(machine(directory, "respond", record.id, record.human!.requestId!, "deny").status, 0);
  assert.equal((await restricted.exited).code, 0);
});

test("a response that cannot be delivered is refused and delivers nothing", async (context) => {
  const directory = await temporaryDirectory(context);
  const run = startRun(context, directory, "choices");
  const record = await waitingRecord(directory);
  const requestId = record.human!.requestId!;
  const refuse = async (args: readonly string[], message: RegExp, target = directory) => {
    const refused = machine(target, "respond", ...args);
    assert.equal(refused.status, 1, args.join(" "));
    assert.equal(refused.stdout, "");
    assert.match(refused.stderr, message);
    assert.deepEqual(await readdir(directory), [`${record.id}.json`]);
  };

  await refuse(["unknown-run", requestId, "approve"], /Machine run "unknown-run" is not published in /u);
  await refuse(["../escaped", requestId, "approve"], /Machine run "\.\.\/escaped" is not published in /u);
  await refuse([record.id, "stale-request", "approve"], new RegExp(
    `Machine run "${record.id}" is waiting on request "${requestId}", not "stale-request"`, "u",
  ));
  await refuse([record.id, requestId, "maybe"], /^Expected one of: approve, deny\n$/u);
  await refuse([record.id, requestId], /^Usage: machine respond /u);
  await refuse([record.id, requestId, "approve"], /^Run status publication is off: set MACHINES_RUN_STATUS_DIR /u, "");

  // Written past those checks, a response the request does not allow is still discarded.
  await writeFile(runInboxPath(directory, record.id), JSON.stringify({ requestId, response: "maybe" }));
  await eventually(() => assert.equal(existsSync(runInboxPath(directory, record.id)), false));
  await writeFile(runInboxPath(directory, record.id), JSON.stringify({ requestId, response: { type: "question", text: "Why?" } }));
  await eventually(() => assert.equal(existsSync(runInboxPath(directory, record.id)), false));
  await writeFile(runInboxPath(directory, record.id), "not a response");
  await eventually(() => assert.equal(existsSync(runInboxPath(directory, record.id)), false));
  assert.equal((await waitingRecord(directory)).human!.requestId, requestId);

  assert.equal(machine(directory, "respond", record.id, requestId, "approve").status, 0);
  const exited = await run.exited;
  assert.deepEqual(JSON.parse(exited.stdout.slice(exited.stdout.indexOf("[\n"))), [{ type: "submitted", value: "approve" }]);
  await refuse([record.id, requestId, "approve"], new RegExp(`Machine run "${record.id}" is not waiting for Human input`, "u"));
});

test("a stale inbox file does not answer a later request", async (context) => {
  const directory = await temporaryDirectory(context);
  const run = startRun(context, directory, "twice");
  const first = await waitingRecord(directory);
  const firstRequest = first.human!.requestId!;
  const inbox = runInboxPath(directory, first.id);

  await writeFile(inbox, JSON.stringify({ requestId: "an-earlier-request", response: "stale" }));
  await eventually(() => assert.equal(existsSync(inbox), false));
  assert.equal((await waitingRecord(directory)).human!.requestId, firstRequest);

  assert.equal(machine(directory, "respond", first.id, firstRequest, "first").status, 0);
  const second = await waitingRecord(directory, firstRequest);
  // A response to the request that was just answered arrives late.
  await writeFile(inbox, JSON.stringify({ requestId: firstRequest, response: "late" }));
  await eventually(() => assert.equal(existsSync(inbox), false));
  const late = machine(directory, "respond", first.id, firstRequest, "late");
  assert.equal(late.status, 1);
  assert.match(late.stderr, /is waiting on request /u);
  assert.equal((await waitingRecord(directory)).human!.requestId, second.human!.requestId);

  assert.equal(machine(directory, "respond", first.id, second.human!.requestId!, "second").status, 0);
  const exited = await run.exited;
  assert.deepEqual(JSON.parse(exited.stdout.slice(exited.stdout.indexOf("[\n"))), [
    { type: "submitted", value: "first" },
    { type: "submitted", value: "second" },
  ]);
});

test("the terminal and the inbox race, and exactly one response is applied", async (context) => {
  const directory = await temporaryDirectory(context);
  const run = startRun(context, directory, "text", "pipe");
  const record = await waitingRecord(directory);

  const responding = spawn(
    process.execPath,
    [cli, "respond", record.id, record.human!.requestId!, "from the inbox"],
    { env: environment(directory), stdio: ["ignore", "ignore", "pipe"] },
  );
  let refusal = "";
  responding.stderr.setEncoding("utf8").on("data", (chunk: string) => { refusal += chunk; });
  // The run may be gone before the line is written.
  run.child.stdin!.on("error", () => {});
  run.child.stdin!.end("from the terminal\n");
  const [responded] = await Promise.all([
    new Promise<number | null>((done) => responding.on("close", done)),
    run.exited,
  ]);

  const exited = await run.exited;
  assert.equal(exited.code, 0, exited.stderr);
  const answers: Array<{ value: string }> = JSON.parse(exited.stdout.slice(exited.stdout.indexOf("[\n")));
  assert.equal(answers.length, 1);
  assert.ok(["from the terminal", "from the inbox"].includes(answers[0]!.value), answers[0]!.value);
  // The responder is told the truth about which of the two the run took.
  assert.equal(responded === 0, answers[0]!.value === "from the inbox", refusal);
  if (responded !== 0) assert.match(refusal, /not confirmed|is not waiting for Human input/u);
  // Nothing that could be applied is left. A response that arrived after the run last looked,
  // which only the run could remove, stays behind emptied by the responder that took it back.
  const left = (await readdir(directory)).filter((name) => name !== `${record.id}.json`);
  if (left.length > 0) {
    assert.deepEqual({ left, responded, text: readFileSync(runInboxPath(directory, record.id), "utf8") }, {
      left: [`${record.id}.inbox`], responded: 1, text: "",
    });
  }
});

test("whichever of the terminal and the inbox answers first wins, and the other is ignored", async (context) => {
  const directory = await temporaryDirectory(context);
  const published: Array<RunStatusHuman & { requestId: string }> = [];
  const acknowledged: string[] = [];
  const terminals: Array<{ request: HumanRequest; signal: AbortSignal; answer(text: string): void }> = [];
  const human = inboxHuman({
    directory,
    runId: "run",
    publish: (request) => published.push(request),
    acknowledge: (delivery) => acknowledged.push(delivery),
    terminal: (request, signal) => new Promise((answer, reject) => {
      terminals.push({ request, signal, answer });
      signal.addEventListener("abort", () => reject(signal.reason));
    }),
  });
  const inbox = runInboxPath(directory, "run");
  const request = { prompt: "Approve?", choices: ["approve", "deny"] };

  // The inbox answers while the terminal is still asking: the terminal question is withdrawn.
  await writeFile(inbox, JSON.stringify({ requestId: "before-the-request", response: "deny" }));
  const first = human(request);
  assert.deepEqual(published, [{ ...request, requestId: published[0]!.requestId }]);
  assert.equal(existsSync(inbox), false, "what was pending before the request is dropped");
  assert.deepEqual({ asked: terminals[0]!.request, withdrawn: terminals[0]!.signal.aborted }, { asked: request, withdrawn: false });
  send(directory, { delivery: "taken", requestId: published[0]!.requestId, response: "approve" });
  assert.equal(await first, "approve");
  assert.deepEqual(acknowledged, ["taken"]);
  assert.equal(terminals[0]!.signal.aborted, true);
  assert.equal(existsSync(inbox), false);
  terminals[0]!.answer("deny");

  // The terminal answers first: a response already in the inbox is never applied, now or later.
  const second = human(request);
  assert.notEqual(published[1]!.requestId, published[0]!.requestId);
  send(directory, { delivery: "ignored", requestId: published[1]!.requestId, response: "approve" });
  terminals[1]!.answer("deny");
  assert.equal(await second, "deny");
  assert.equal(existsSync(inbox), true);
  const third = human(request);
  assert.deepEqual(await readdir(directory), []);
  const outcome = await Promise.race([third, new Promise((done) => setTimeout(done, 300, "still asking"))]);
  assert.equal(outcome, "still asking");
  terminals[2]!.answer("approve");
  assert.equal(await third, "approve");
  assert.deepEqual(acknowledged, ["taken"]);
});

test("a response overtaken by a terminal answer is not confirmed, even when the next request starts at once", async (context) => {
  const directory = await temporaryDirectory(context);
  const inbox = runInboxPath(directory, "run");
  const publisher = createRunStatusPublisher(
    { id: "run", machine: "ticket", path: "/work/.machines/ticket.ts", cwd: "/work" },
    { MACHINES_RUN_STATUS_DIR: directory },
  );
  const terminals: Array<(text: string) => void> = [];
  const human = inboxHuman({
    directory,
    runId: "run",
    publish: (request) => publisher.update({ status: "waiting", human: request }),
    acknowledge: (delivery) => publisher.update({ delivery }),
    terminal: (_request, signal) => new Promise((answer, reject) => {
      terminals.push(answer);
      signal.addEventListener("abort", () => reject(signal.reason));
    }),
  });
  const pending = () => readRunStatuses(directory)[0]!.human!.requestId!;

  // The next request drops the response as it starts.
  const first = human({ prompt: "Approve?" });
  const firstRequest = pending();
  const dropped = respondToRun({ directory, runId: "run", requestId: firstRequest, response: "from the inbox" });
  assert.equal(existsSync(inbox), true);
  terminals[0]!("from the terminal");
  assert.equal(await first, "from the terminal");
  const second = human({ prompt: "And then?" });
  assert.equal(existsSync(inbox), false);
  await assert.rejects(dropped, new RegExp(`was not confirmed: the run left request "${firstRequest}" without taking it`, "u"));

  // The next request is already waiting when the response arrives, and discards it on reading it.
  const secondRequest = pending();
  terminals[1]!("from the terminal");
  assert.equal(await second, "from the terminal");
  const third = human({ prompt: "And finally?" });
  const thirdRequest = pending();
  send(directory, { delivery: "late", requestId: secondRequest, response: "from the inbox" });
  await eventually(() => assert.equal(existsSync(inbox), false));
  assert.deepEqual({ request: pending(), deliveries: readRunStatuses(directory)[0]!.deliveries }, { request: thirdRequest, deliveries: undefined });

  // A response the run does take is confirmed, and the record names it without containing it.
  const taken = respondToRun({ directory, runId: "run", requestId: thirdRequest, response: "from the inbox" });
  assert.equal(await third, "from the inbox");
  publisher.update({ status: "running", human: undefined });
  await taken;
  const text = await readFile(join(directory, "run.json"), "utf8");
  assert.equal(JSON.parse(text).deliveries.length, 1);
  assert.match(JSON.parse(text).deliveries[0], /^[0-9a-f-]{36}$/u);
  assert.doesNotMatch(text, /from the inbox|from the terminal/u);
});

test("a response the run took stays confirmed when a later one is taken before its sender looks again", async (context) => {
  const directory = await temporaryDirectory(context);
  const inbox = runInboxPath(directory, "run");
  const publisher = createRunStatusPublisher(
    { id: "run", machine: "ticket", path: "/work/.machines/ticket.ts", cwd: "/work" },
    { MACHINES_RUN_STATUS_DIR: directory },
  );
  const ask = (requestId: string) => publisher.update({ status: "waiting", human: { prompt: "Approve?", requestId } });
  const respond = (requestId: string) => respondToRun({ directory, runId: "run", requestId, response: "from the inbox" });
  // The run's side without its polling, so that no sender looks at the record in between.
  const take = (): string => {
    const { delivery } = JSON.parse(readFileSync(inbox, "utf8")) as { delivery: string };
    rmSync(inbox);
    rmSync(runDeliveryPath(directory, "run", delivery));
    publisher.update({ delivery });
    return delivery;
  };

  ask("request-1");
  const first = respond("request-1");
  const firstDelivery = take();
  ask("request-2");
  const second = respond("request-2");
  const secondDelivery = take();
  publisher.finish({ state: "done" });
  await Promise.all([first, second]);
  assert.deepEqual(readRunStatuses(directory)[0]!.deliveries, [firstDelivery, secondDelivery]);

  // A record stops naming a response only after any sender has stopped waiting for it. One
  // that looks later still is not confirmed, but is not told that its response was not taken.
  const lasting = createRunStatusPublisher(
    { id: "run", machine: "ticket", path: "/work/.machines/ticket.ts", cwd: "/work" },
    { MACHINES_RUN_STATUS_DIR: directory },
  );
  context.mock.timers.enable({ apis: ["Date"] });
  lasting.update({ status: "waiting", human: { prompt: "Approve?", requestId: "request-3" } });
  const stalled = respond("request-3");
  const stalledDelivery = (JSON.parse(readFileSync(inbox, "utf8")) as { delivery: string }).delivery;
  rmSync(inbox);
  rmSync(runDeliveryPath(directory, "run", stalledDelivery));
  lasting.update({ delivery: stalledDelivery, status: "waiting", human: { prompt: "And then?", requestId: "request-4" } });
  context.mock.timers.tick(deliveryRetentionMilliseconds - 1);
  lasting.update({ delivery: "later" });
  assert.deepEqual(readRunStatuses(directory)[0]!.deliveries, [stalledDelivery, "later"]);
  context.mock.timers.tick(1);
  lasting.update({ delivery: "latest" });
  assert.deepEqual(readRunStatuses(directory)[0]!.deliveries, ["later", "latest"]);
  await assert.rejects(stalled, /Response to Machine run "run" was not confirmed within 5s$/u);
});

test("terminal input outside the choices does not answer the request, which keeps waiting", async (context) => {
  const directory = await temporaryDirectory(context);
  const published: string[] = [];
  const refused: string[] = [];
  const terminals: Array<(text: string) => void> = [];
  const human = inboxHuman({
    directory,
    runId: "run",
    publish: (request) => published.push(request.requestId),
    acknowledge() {},
    onTerminalRefused: (reason) => refused.push(reason),
    terminal: (_request, signal) => new Promise((answer, reject) => {
      terminals.push(answer);
      signal.addEventListener("abort", () => reject(signal.reason));
    }),
  });
  const request = { prompt: "Approve?", choices: ["approve", "deny"] };

  // The terminal is asked again, about the same request, until it gives a valid answer.
  const first = human(request);
  terminals[0]!("maybe");
  await eventually(() => assert.equal(terminals.length, 2));
  terminals[1]!("");
  await eventually(() => assert.equal(terminals.length, 3));
  assert.deepEqual(refused, ["Expected one of: approve, deny", "Expected one of: approve, deny"]);
  terminals[2]!("deny");
  assert.equal(await first, "deny");

  // The inbox can still answer a request whose terminal answer was refused.
  const second = human(request);
  terminals[3]!("maybe");
  await eventually(() => assert.equal(terminals.length, 5));
  await writeFile(runInboxPath(directory, "run"), JSON.stringify({ requestId: published[1], response: "approve" }));
  assert.equal(await second, "approve");
  assert.equal(published.length, 2);

  // Through the CLI: the refused line is reported, input then ends, and the run waits for its inbox.
  const run = startRun(context, directory, "choices", "pipe");
  let stderr = "";
  run.child.stderr!.on("data", (chunk: string) => { stderr += chunk; });
  const record = await waitingRecord(directory);
  const hint = `No terminal input. Answer with: machine respond ${record.id} ${record.human!.requestId} <response>\n`;
  run.child.stdin!.end("maybe\n");
  await eventually(() => assert.ok(stderr.endsWith(hint), stderr));
  assert.equal((await waitingRecord(directory)).human!.requestId, record.human!.requestId);
  assert.equal(machine(directory, "respond", record.id, record.human!.requestId!, "approve").status, 0);
  const exited = await run.exited;
  assert.equal(exited.code, 0, exited.stderr);
  assert.ok(exited.stderr.includes(`Expected one of: approve, deny\n${hint}`), exited.stderr);
  assert.deepEqual(JSON.parse(exited.stdout.slice(exited.stdout.indexOf("[\n"))), [{ type: "submitted", value: "approve" }]);
});

test("with publication off, a run without terminal input fails as before", async (context) => {
  const root = await temporaryDirectory(context);
  await writeFile(join(root, "file"), "not a directory");
  // Nobody can see a request that could not be published, so it is not waited on either.
  for (const directory of ["", join(root, "file", "status")]) {
    const exited = await startRun(context, directory, "choices").exited;
    assert.equal(exited.code, 1);
    assert.match(exited.stderr, /Human failed in state "ask": Terminal input closed before a response/u);
    assert.doesNotMatch(exited.stderr, /machine respond/u);
  }
  assert.deepEqual(await readdir(root), ["file"]);
});

test("machine runs lists the running and waiting runs as text and as JSON", async (context) => {
  const directory = await temporaryDirectory(context);
  const empty = machine(directory, "runs");
  assert.deepEqual({ status: empty.status, stdout: empty.stdout }, { status: 0, stdout: "No Machine runs are running or waiting.\n" });
  assert.equal(machine(directory, "runs", "--json").stdout, "[]\n");

  const exited = spawnSync(process.execPath, ["-e", ""]).pid;
  const records: Array<Partial<RunStatusRecord>> = [
    { id: "running-run", state: "re\x1b[2Jview", agent: { harness: "claude" }, startedAt: "2020-03-04T05:06:07.000Z" },
    { id: "completed-run", status: "completed", state: "done" },
    { id: "failed-run", status: "failed", error: "boom" },
    { id: "lost-run", status: "waiting", pid: exited, human: { prompt: "Gone?", requestId: "lost" } },
    { id: "starting-run", schemaVersion: 1, status: "waiting", human: { prompt: "Old?" }, startedAt: "2020-03-04T05:06:08.000Z" },
  ];
  for (const record of records) await writeRecord(directory, record);
  const run = startRun(context, directory, "discussion");
  const waiting = await waitingRecord(directory);
  const suggesting = startRun(context, directory, "suggestions");
  const suggested = await waitingRecord(directory, undefined, waiting.id);

  const listed = machine(directory, "runs");
  assert.equal(listed.status, 0, listed.stderr);
  assert.equal(listed.stdout, [
    "running-run\tticket\trunning\tre [2Jview",
    "starting-run\tticket\twaiting\tstarting",
    "  Old?",
    `${waiting.id}\thuman-inbox.machine\twaiting\task`,
    "  Approve the plan?",
    "  It changes three files.",
    `  request: ${waiting.human!.requestId}`,
    "  choices: approve",
    "  discussion: questions allowed",
    `${suggested.id}\thuman-inbox.machine\twaiting\task`,
    "  Approve the plan?",
    "  It changes three files.",
    `  request: ${suggested.human!.requestId}`,
    "  suggestions: Use the default",
    "",
  ].join("\n"));

  const json = machine(directory, "runs", "--json");
  assert.equal(json.status, 0, json.stderr);
  const active = readRunStatuses(directory).filter((record) => (
    ["running-run", "starting-run", waiting.id, suggested.id].includes(record.id)
  ));
  assert.deepEqual(
    (JSON.parse(json.stdout) as RunStatusRecord[]).map((record) => record.id),
    ["running-run", "starting-run", waiting.id, suggested.id],
  );
  assert.deepEqual(
    [...JSON.parse(json.stdout) as RunStatusRecord[]].sort((left, right) => left.id.localeCompare(right.id)),
    active.sort((left, right) => left.id.localeCompare(right.id)),
  );

  for (const args of [["runs"], ["runs", "--json"]]) {
    const off = machine("", ...args);
    assert.deepEqual({ status: off.status, stdout: off.stdout }, { status: 1, stdout: "" });
    assert.match(off.stderr, /^Run status publication is off: set MACHINES_RUN_STATUS_DIR /u);
  }
  assert.match(machine(directory, "runs", "--verbose").stderr, /machine runs \[--json\]/u);

  assert.equal(machine(directory, "respond", waiting.id, waiting.human!.requestId!, "approve").status, 0);
  assert.equal(machine(directory, "respond", suggested.id, suggested.human!.requestId!, "anything else").status, 0);
  assert.deepEqual([(await run.exited).code, (await suggesting.exited).code], [0, 0]);
});

test("the inbox holds one private response, taken back when the run does not take it", async (context) => {
  const directory = await temporaryDirectory(context);
  const inbox = runInboxPath(directory, "run");
  const publisher = createRunStatusPublisher(
    { id: "run", machine: "ticket", path: "/work/.machines/ticket.ts", cwd: "/work" },
    { MACHINES_RUN_STATUS_DIR: directory },
  );
  publisher.update({ status: "waiting", human: { prompt: "Approve?", requestId: "request-1" } });
  const delivery = { directory, runId: "run", requestId: "request-1", timeoutMilliseconds: 1_000 };
  // The run's side: reading its inbox removes what is there, here for a request that is not waiting.
  const applied: unknown[] = [];
  const read = () => watchRunInbox(directory, "run", { requestId: "none" }, (response) => applied.push(response))();

  // Nothing reads this run's inbox, so the response is never confirmed.
  const unconfirmed = assert.rejects(
    respondToRun({ ...delivery, response: "approve" }),
    /Response to Machine run "run" was not confirmed within 1s; it was withdrawn and will not be applied/u,
  );
  // One file, which its sender also holds under a name of its own until the run or the sender removes that.
  const [sent, ...others] = (await readdir(directory)).sort();
  assert.match(sent!, /^\.run\.[0-9a-f-]{36}\.inbox\.sent$/u);
  assert.deepEqual(others, ["run.inbox", "run.json"]);
  assert.deepEqual({ same: (await stat(join(directory, sent!))).ino === (await stat(inbox)).ino, names: (await stat(inbox)).nlink }, {
    same: true, names: 2,
  });
  assert.equal((await stat(inbox)).mode & 0o777, 0o600);
  assert.equal((await stat(join(directory, "run.json"))).mode & 0o777, 0o600);
  const pending = await readFile(inbox, "utf8");
  assert.equal(JSON.parse(pending).response, "approve");
  // A second response cannot replace or join the one that is pending.
  await assert.rejects(respondToRun({ ...delivery, response: "deny" }), /Machine run "run" already has a response pending/u);
  assert.equal(await readFile(inbox, "utf8"), pending);
  await unconfirmed;
  // Only the run empties its inbox. Until it reads again, what was taken back stays there without the response.
  assert.deepEqual((await readdir(directory)).sort(), ["run.inbox", "run.json"]);
  assert.equal(await readFile(inbox, "utf8"), "");
  await assert.rejects(respondToRun({ ...delivery, response: "deny" }), /Machine run "run" already has a response pending/u);
  assert.deepEqual((await readdir(directory)).sort(), ["run.inbox", "run.json"]);
  read();
  assert.deepEqual(await readdir(directory), ["run.json"]);

  // The request is answered elsewhere while a response is pending: that response is not applied later.
  const overtaken = assert.rejects(
    respondToRun({ ...delivery, response: "approve" }),
    /was not confirmed: the run left request "request-1" without taking it/u,
  );
  assert.equal(existsSync(inbox), true);
  publisher.update({ status: "waiting", human: { prompt: "And then?", requestId: "request-2" } });
  await overtaken;
  assert.deepEqual({ names: (await readdir(directory)).sort(), text: await readFile(inbox, "utf8") }, {
    names: ["run.inbox", "run.json"], text: "",
  });

  publisher.update({ status: "waiting", human: { prompt: "Approve?" } });
  await assert.rejects(respondToRun({ ...delivery, response: "approve" }), /does not take a response from outside its host/u);
  // A run that finishes leaves nothing in its inbox.
  publisher.finish({ state: "done" });
  assert.deepEqual(await readdir(directory), ["run.json"]);
  await assert.rejects(respondToRun({ ...delivery, response: "approve" }), /is not waiting for Human input/u);
  await writeRecord(directory, {
    id: "lost", status: "waiting", pid: spawnSync(process.execPath, ["-e", ""]).pid,
    human: { prompt: "Approve?", requestId: "request-1" },
  });
  await assert.rejects(respondToRun({ ...delivery, runId: "lost", response: "approve" }), /is not waiting for Human input/u);
  assert.deepEqual((await readdir(directory)).sort(), ["lost.json", "run.json"]);
  assert.deepEqual(applied, []);
});

test("a sender that gives up never removes a later response, whenever that one arrives", async (context) => {
  const later = `${JSON.stringify({ requestId: "request-1", response: "later" })}\n`;
  for (let step = 1; ; step += 1) {
    const directory = await temporaryDirectory(context);
    const inbox = runInboxPath(directory, "run");
    await writeRecord(directory, { status: "waiting", human: { prompt: "Approve?", requestId: "request-1" } });
    // Between two of the sender's steps the run takes what is pending, and another response arrives.
    const interleaved = interleave(context, directory, step, () => {
      rmSync(inbox, { force: true });
      writeFileSync(inbox, later);
    });
    const earlier = respondToRun({ directory, runId: "run", requestId: "request-1", response: "earlier", timeoutMilliseconds: 0 });
    interleaved.stop();
    await assert.rejects(earlier, /was not confirmed within 0s|already has a response pending/u);
    if (!interleaved.happened) {
      assert.ok(step > 3, `the sender took ${step - 1} steps`);
      break;
    }
    assert.equal(readFileSync(inbox, "utf8"), later, `before step ${step}`);
  }
});

test("a run applies only a response it removed from its inbox and its sender did not take back", async (context) => {
  for (let step = 1; ; step += 1) {
    const directory = await temporaryDirectory(context);
    const inbox = runInboxPath(directory, "run");
    const applied: unknown[] = [];
    const stop = watchRunInbox(directory, "run", { requestId: "request-1" }, (response) => applied.push(response));
    context.after(stop);
    send(directory, { delivery: "earlier", requestId: "request-1", response: "earlier" });
    // Between two of the run's steps the sender gives up, and another sender tries to deliver.
    let tookBack = false;
    let arrived = false;
    const interleaved = interleave(context, directory, step, () => {
      try {
        rmSync(runDeliveryPath(directory, "run", "earlier"));
        tookBack = true;
      } catch {
        // The run already has it.
      }
      try {
        send(directory, { delivery: "later", requestId: "request-1", response: "later" });
        arrived = true;
      } catch {
        // Refused: a response is still pending.
        rmSync(runDeliveryPath(directory, "run", "later"));
      }
    });
    // Until the run has applied a response, or has discarded the only one there was.
    await eventually(() => assert.ok(applied.length > 0 || (interleaved.happened && !readdirSync(directory).includes("run.inbox"))));
    interleaved.stop();
    stop();
    if (!interleaved.happened) {
      assert.ok(step > 2, `the run took ${step - 1} steps`);
      break;
    }
    // The run never applies what was taken back, and never loses what arrived: it is applied or still pending.
    const outcome = { applied, pending: existsSync(inbox) ? JSON.parse(readFileSync(inbox, "utf8")).response : undefined };
    assert.deepEqual(outcome, tookBack
      ? { applied: arrived ? ["later"] : [], pending: undefined }
      : { applied: ["earlier"], pending: arrived ? "later" : undefined }, `before step ${step}`);
  }
});

test("the terminal picker leaves the terminal as it found it when its question is withdrawn", async () => {
  const picker = spawn(process.execPath, [resolve("tests/fixtures/terminal-picker.ts")], { stdio: "pipe" });
  let stdout = "";
  let stderr = "";
  picker.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  // Its input stays open until it has reported: the question ends by being withdrawn, not by end of input.
  picker.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
    picker.stdin.end();
  });
  const code = await new Promise<number | null>((done) => picker.on("close", done));

  assert.equal(code, 0, stderr);
  assert.deepEqual(JSON.parse(stderr), {
    outcome: "rejected: answered elsewhere",
    rawModes: [true, false],
    keypressListeners: 0,
    paused: true,
  });
  // The menu is drawn, then cleared from its first line down, and nothing is confirmed.
  assert.ok(stdout.includes("approve") && stdout.includes("↑↓ select · enter confirm"), stdout);
  assert.ok(stdout.replace(/\x1b\[\d*m/gu, "").endsWith("\x1b[3A\x1b[1G\x1b[0Janswered elsewhere\n"), JSON.stringify(stdout));
  assert.doesNotMatch(stdout, /✔/u);
});

function environment(directory: string): NodeJS.ProcessEnv {
  const inherited = { ...process.env };
  for (const key of ["MACHINES_RUN_STATUS_DIR", "MACHINES_RUN_OWNER", "MACHINES_RUN_PARENT", "CLAUDE_CODE_SESSION_ID"]) {
    delete inherited[key];
  }
  return directory === "" ? inherited : { ...inherited, MACHINES_RUN_STATUS_DIR: directory };
}

/** Runs one `machine` command with publication in `directory`, or off when it is empty. */
function machine(directory: string, ...args: readonly string[]) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", env: environment(directory) });
}

/** Starts the fixture Machine with no terminal input unless `stdin` is a pipe. */
function startRun(context: TestContext, directory: string, kind: string, stdin: "ignore" | "pipe" = "ignore") {
  const child = spawn(process.execPath, [cli, "run", fixture, kind], {
    env: environment(directory), stdio: [stdin, "pipe", "pipe"],
  });
  context.after(() => { child.kill(); });
  let stdout = "";
  let stderr = "";
  child.stdout!.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  child.stderr!.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  const exited = new Promise<{ code: number | null; stdout: string; stderr: string }>((done, fail) => {
    child.on("error", fail);
    child.on("close", (code) => done({ code, stdout, stderr }));
  });
  return { child, exited };
}

/** The waiting record of a fixture run, once it shows a request other than `after`. */
async function waitingRecord(directory: string, after?: string, otherThan?: string): Promise<RunStatusRecord> {
  let found: RunStatusRecord | undefined;
  await eventually(() => {
    found = readRunStatuses(directory).find((record) => (
      record.machine === "human-inbox.machine" && record.id !== otherThan && record.status === "waiting"
      && record.human?.requestId !== undefined && record.human.requestId !== after
    ));
    assert.ok(found, "no run is waiting on a new request");
  });
  return found!;
}

/** Puts a response in the inbox of "run" as `machine respond` does, under a delivery the test names. */
function send(directory: string, message: { delivery: string; requestId: string; response: string }): void {
  const sent = runDeliveryPath(directory, "run", message.delivery);
  writeFileSync(sent, `${JSON.stringify(message)}\n`, { mode: 0o600 });
  linkSync(sent, runInboxPath(directory, "run"));
}

/**
 * Runs `action` just before the `step`th filesystem call that names an inbox file in `directory`:
 * the points at which another process can act between two steps of the code under test.
 */
function interleave(
  context: TestContext,
  directory: string,
  step: number,
  action: () => void,
): { happened: boolean; stop(): void } {
  const calls = fs as unknown as Record<string, (...args: unknown[]) => unknown>;
  let count = 0;
  let acting = false;
  const mocked = Object.keys(calls).filter((name) => name.endsWith("Sync") && typeof calls[name] === "function").map((name) => {
    const original = calls[name]!;
    return mock.method(calls, name, function (this: unknown, ...args: unknown[]) {
      const names = args.some((argument) => typeof argument === "string" && argument.startsWith(directory) && argument.includes(".inbox"));
      if (names && !acting && (count += 1) === step) {
        acting = true;
        try { action(); } finally { acting = false; }
        interleaved.happened = true;
      }
      return original.apply(this, args);
    });
  });
  const interleaved = {
    happened: false,
    stop() {
      for (const method of mocked) method.mock.restore();
      syncBuiltinESMExports();
    },
  };
  // Modules that import these functions by name see the replacements too.
  syncBuiltinESMExports();
  context.after(() => interleaved.stop());
  return interleaved;
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
  const directory = await mkdtemp(join(tmpdir(), "machines-run-inbox-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function eventually(assertion: () => void): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (true) {
    try { assertion(); return; } catch (cause) {
      if (Date.now() >= deadline) throw cause;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}
