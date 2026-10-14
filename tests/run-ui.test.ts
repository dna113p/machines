import "./environment.ts";

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, type TestContext } from "node:test";

import { createMachine, fromPromise } from "xstate";

import { agent, final, human, machine, operation } from "../src/index.ts";
import { machineGraph, statePaths } from "../src/run-graph.ts";
import { createRunStatusPublisher, readRunStatuses, trailLimit } from "../src/run-status.ts";
import { parsePanelOutput, readPanelSources, startRunUi, uiProjectDir, uiRuns } from "../src/run-ui.ts";

const run = { machine: "ticket", path: "/work/.machines/ticket.ts", cwd: "/work" };

async function temporary(context: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "machines-ui-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("a definition's graph names each state's kind, its Agent role, and every transition with its event", () => {
  const graph = machineGraph(machine({
    initial: "plan",
    states: {
      plan: agent("Plan.", { planned: "check", stuck: "parked" }, { using: "investigator" }),
      check: operation(() => ({ type: "passed" }), { passed: "approve", failed: "plan" }),
      approve: human("Ship it?", { submitted: "nested" }, { choices: ["yes", "no"] }),
      nested: { initial: "inner", states: { inner: operation(() => ({ type: "go" }), { go: "end" }), end: { type: "final" } }, onDone: "done" },
      parked: final(),
      done: final(),
    },
  }));
  assert.ok(graph);
  assert.equal(graph.initial, "plan");
  assert.deepEqual(graph.states, [
    { id: "plan", kind: "agent", role: "investigator" },
    { id: "check", kind: "operation" },
    { id: "approve", kind: "human" },
    { id: "nested", kind: "group" },
    { id: "nested.inner", parent: "nested", kind: "operation" },
    { id: "nested.end", parent: "nested", kind: "final" },
    { id: "parked", kind: "final" },
    { id: "done", kind: "final" },
  ]);
  assert.deepEqual(graph.edges, [
    { from: "plan", to: "check", event: "planned" },
    { from: "plan", to: "parked", event: "stuck" },
    { from: "check", to: "approve", event: "passed" },
    { from: "check", to: "plan", event: "failed" },
    { from: "approve", to: "nested", event: "submitted" },
    { from: "nested", to: "done", event: "done" },
    { from: "nested.inner", to: "nested.end", event: "go" },
  ]);
});

test("a plain XState definition's invoke, delay, and eventless transitions read as done, error, after, and always", () => {
  const graph = machineGraph(createMachine({
    initial: "fetch",
    states: {
      fetch: { invoke: { src: fromPromise(async () => 1), onDone: "wait", onError: "failed" } },
      wait: { after: { 1_000: "settle" } },
      settle: { always: "done" },
      failed: { type: "final" },
      done: { type: "final" },
    },
  }));
  assert.deepEqual(graph?.edges, [
    { from: "fetch", to: "wait", event: "done" },
    { from: "fetch", to: "failed", event: "error" },
    { from: "wait", to: "settle", event: "after" },
    { from: "settle", to: "done", event: "always" },
  ]);
  assert.deepEqual(graph?.states.map((state) => state.kind), ["operation", "state", "state", "final", "final"]);
});

test("a state value reads as the dotted paths of its active states", () => {
  assert.deepEqual(statePaths("plan"), ["plan"]);
  assert.deepEqual(statePaths(JSON.stringify({ review: "round" })), ["review.round"]);
  assert.deepEqual(statePaths({ a: { b: "c" }, d: "e" }), ["a.b.c", "d.e"]);
  assert.deepEqual(statePaths(undefined), []);
});

test("a published run carries its graph and the trail of states it entered, which readers accept", async (context) => {
  const directory = await temporary(context);
  const graph = { initial: "plan", states: [{ id: "plan", kind: "agent" as const, role: "investigator" }, { id: "done", kind: "final" as const }], edges: [{ from: "plan", to: "done", event: "planned" }] };
  const published = createRunStatusPublisher({ ...run, id: "run-1", graph }, { MACHINES_RUN_STATUS_DIR: directory });
  published.update({ state: "plan" });
  published.update({ state: "plan" });
  published.update({ state: "check" });
  published.update({ state: "plan" });
  published.update({ state: { review: "round" } });
  published.finish({ state: "done", note: "Delivered." });
  const [record] = readRunStatuses(directory);
  assert.deepEqual(record?.graph, graph);
  // A repeated report of the same state is one step, a return to it is another, and nested states read as paths.
  assert.deepEqual(record?.trail?.map((step) => step.state), ["plan", "check", "plan", "review.round", "done"]);
  assert.ok(record?.trail?.every((step) => !Number.isNaN(Date.parse(step.at))));
});

test("a record keeps only the latest trail steps, and a malformed graph or trail is not read as a record", async (context) => {
  const directory = await temporary(context);
  const published = createRunStatusPublisher({ ...run, id: "long" }, { MACHINES_RUN_STATUS_DIR: directory });
  for (let step = 0; step < trailLimit + 25; step += 1) published.update({ state: `s${step}` });
  const trail = readRunStatuses(directory)[0]?.trail ?? [];
  assert.equal(trail.length, trailLimit);
  assert.equal(trail.at(-1)?.state, `s${trailLimit + 24}`);
  assert.equal(trail[0]?.state, "s25");

  const record = { schemaVersion: 2, id: "bad", pid: process.pid, machine: "m", path: "/m.ts", cwd: "/", status: "running", startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  await writeFile(join(directory, "bad-graph.json"), JSON.stringify({ ...record, id: "bad-graph", graph: { states: "no", edges: [] } }));
  await writeFile(join(directory, "bad-trail.json"), JSON.stringify({ ...record, id: "bad-trail", trail: [{ state: 1, at: "x" }] }));
  assert.deepEqual(readRunStatuses(directory).map((found) => found.id).sort(), ["long"]);
});

test("machine run publishes its Machine's graph with the trail", async (context) => {
  const directory = await temporary(context);
  const child = spawn(process.execPath, [resolve("machine"), "run", resolve("tests/fixtures/run-status.machine.ts")], {
    env: { ...process.env, MACHINES_RUN_STATUS_DIR: directory },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolveExit) => child.on("exit", resolveExit));
  const [record] = readRunStatuses(directory);
  assert.ok(record?.graph && record.graph.states.length > 0, "the graph is published");
  assert.ok((record?.trail?.length ?? 0) > 0, "the trail is published");
  for (const step of record?.trail ?? []) {
    assert.ok(record?.graph?.states.some((state) => state.id === step.state), `${step.state} is a state of the graph`);
  }
});

test("lost runs are told apart, and panels come from the project's ui.json", async (context) => {
  const directory = await temporary(context);
  createRunStatusPublisher({ ...run, id: "alive" }, { MACHINES_RUN_STATUS_DIR: directory }).update({ state: "plan" });
  createRunStatusPublisher({ ...run, id: "gone" }, { MACHINES_RUN_STATUS_DIR: directory }).update({ state: "plan" });
  const statuses = Object.fromEntries(uiRuns(directory, () => false).map((found) => [found.id, found.status]));
  assert.deepEqual(statuses, { alive: "lost", gone: "lost" });
  assert.equal(uiRuns(directory)[0]?.status, "running");

  const project = await temporary(context);
  await mkdir(join(project, ".machines"), { recursive: true });
  await mkdir(join(project, "src", "inner"), { recursive: true });
  assert.equal(uiProjectDir(join(project, "src", "inner")), project);
  assert.deepEqual(readPanelSources(project), { sources: [] });
  await writeFile(join(project, ".machines", "ui.json"), JSON.stringify({ panels: [{ title: "Tickets", command: ["node", "t.mjs"] }] }));
  assert.deepEqual(readPanelSources(project).sources, [{ title: "Tickets", command: ["node", "t.mjs"], refreshSeconds: 10 }]);
  await writeFile(join(project, ".machines", "ui.json"), JSON.stringify({ panels: [{ title: "", command: [] }] }));
  assert.match(readPanelSources(project).error ?? "", /panels\[0\]\.title/u);

  const panel = parsePanelOutput("PRs", JSON.stringify({
    summary: "1 open",
    items: [
      { text: "machines#1", href: "https://github.com/x/y/pull/1", status: "warn", at: "2026-10-13T00:00:00Z", detail: "ready" },
      { text: "local", href: "file:///etc/passwd", status: "loud" },
      { text: "" },
    ],
  }));
  // Only web links survive, an unknown status is dropped, and an item without text is skipped.
  assert.deepEqual(panel, {
    title: "PRs",
    summary: "1 open",
    items: [
      { text: "machines#1", detail: "ready", status: "warn", href: "https://github.com/x/y/pull/1", at: "2026-10-13T00:00:00Z" },
      { text: "local" },
    ],
  });
  assert.throws(() => parsePanelOutput("x", "{}"), /items array/u);
});

interface Reply { readonly status: number; readonly body: string }

function call(url: string, options: { method?: string; host?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Reply> {
  return new Promise((resolveReply, rejectReply) => {
    const target = new URL(url);
    const sent = request({
      host: target.hostname, port: target.port, path: target.pathname, method: options.method ?? "GET",
      headers: { host: options.host ?? target.host, ...options.headers },
    }, (response) => {
      let body = "";
      response.on("data", (chunk) => { body += String(chunk); });
      response.on("end", () => resolveReply({ status: response.statusCode ?? 0, body }));
    });
    sent.on("error", rejectReply);
    sent.end(options.body);
  });
}

test("the page serves its runs and panels, refuses other host names, and answers a run only with its token", async (context) => {
  const directory = await temporary(context);
  const project = await temporary(context);
  await mkdir(join(project, ".machines"));
  await writeFile(join(project, "panel.mjs"), "console.log(JSON.stringify({ summary: 'ok', items: [{ text: 'one', status: 'ok' }] }));\n");
  await writeFile(join(project, ".machines", "ui.json"), JSON.stringify({ panels: [{ title: "Mine", command: [process.execPath, "panel.mjs"] }] }));
  createRunStatusPublisher({ ...run, id: "waiting-run" }, { MACHINES_RUN_STATUS_DIR: directory })
    .update({ status: "waiting", state: "approve", human: { prompt: "Ship it?", requestId: "req-1", choices: ["yes", "no"] } });

  const ui = await startRunUi({ directory, projectDir: project, port: 0, pollMilliseconds: 50 });
  context.after(() => ui.close());

  const page = await call(ui.url);
  assert.equal(page.status, 200);
  const token = /var TOKEN = "([0-9a-f]+)"/u.exec(page.body)?.[1];
  assert.ok(token, "the page carries its token");

  // A name that only resolves here, as in DNS rebinding, gets nothing.
  assert.equal((await call(ui.url, { host: "attacker.example:80" })).status, 421);
  assert.equal((await call(`${ui.url}api/state`, { host: "attacker.example:80" })).status, 421);

  let state = JSON.parse((await call(`${ui.url}api/state`)).body);
  for (let tries = 0; state.panels[0]?.items.length !== 1 && tries < 100; tries += 1) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    state = JSON.parse((await call(`${ui.url}api/state`)).body);
  }
  assert.equal(state.runs[0].id, "waiting-run");
  assert.equal(state.runs[0].human.prompt, "Ship it?");
  assert.deepEqual(state.panels[0], { ...state.panels[0], title: "Mine", summary: "ok", items: [{ text: "one", status: "ok" }] });

  const body = JSON.stringify({ runId: "waiting-run", requestId: "req-1", response: "yes" });
  const json = { "content-type": "application/json" };
  assert.equal((await call(`${ui.url}api/respond`, { method: "POST", headers: json, body })).status, 403);
  assert.equal((await call(`${ui.url}api/respond`, { method: "POST", headers: { ...json, "x-machines-ui": "wrong" }, body })).status, 403);
  const refused = await call(`${ui.url}api/respond`, { method: "POST", headers: { ...json, "x-machines-ui": token }, body: JSON.stringify({ runId: "waiting-run", requestId: "req-1", response: "maybe" }) });
  assert.equal(refused.status, 409);
  assert.match(JSON.parse(refused.body).error, /Expected one of: yes, no/u);

  // With the token the answer is left in the run's inbox, as machine respond leaves it; nothing here takes it, so it is not confirmed.
  const answered = call(`${ui.url}api/respond`, { method: "POST", headers: { ...json, "x-machines-ui": token }, body });
  await new Promise((resolveWait) => setTimeout(resolveWait, 300));
  assert.ok((await readdir(directory)).includes("waiting-run.inbox"), "the response reached the run's inbox");
  const reply = await answered;
  assert.equal(reply.status, 409);
  assert.match(JSON.parse(reply.body).error, /not confirmed/u);
});
