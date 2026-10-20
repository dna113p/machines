import "./environment.ts";

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { createContext, runInContext } from "node:vm";

import { createMachine, fromPromise, type AnyStateMachine } from "xstate";

// The package's own entry, which any tool that holds a definition can read its graph from.
import { agent, defineEndings, final, human, machine, machineGraph, operation, statePaths, use } from "../src/index.ts";
import * as graphModule from "../src/run-graph.ts";
import type { RunGraph } from "../src/run-graph.ts";
import { respondToRun } from "../src/run-inbox.ts";
import { createRunStatusPublisher, readRunStatuses, trailLimit, type RunStatusRecord } from "../src/run-status.ts";
import { runUiPage } from "../src/run-ui-page.ts";
import { parsePanelOutput, readPanelSources, startRunUi, uiProjectDir, uiRuns } from "../src/run-ui.ts";
import { presentation, presentedPrompt, suggestedPresentation } from "./sleep-machines.ts";

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

/** Just enough of a browser document for the page script to draw into. */
class FakeNode {
  readonly children: FakeNode[] = [];
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, Array<(event: unknown) => void>>();
  parent: FakeNode | undefined;
  className = "";
  value = "";
  checked = false;
  disabled = false;
  readonly dataset: Record<string, string> = {};
  readonly clientWidth = 800;
  readonly clientHeight = 600;
  readonly classList = { add() {}, remove() {} };
  private text = "";
  readonly tagName: string;
  readonly document: FakeDocument;

  constructor(tagName: string, document: FakeDocument) {
    this.tagName = tagName;
    this.document = document;
  }

  get textContent(): string {
    return this.tagName === "#text" ? this.text : this.children.map((child) => child.textContent).join("");
  }

  set textContent(value: string) {
    if (this.tagName === "#text") this.text = value;
    else this.replaceChildren(this.document.createTextNode(String(value)));
  }

  get id(): string { return this.attributes.get("id") ?? ""; }

  setAttribute(name: string, value: unknown) {
    this.attributes.set(name, String(value));
    if (name === "class") this.className = String(value);
  }

  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  addEventListener(name: string, listener: (event: unknown) => void) { this.listeners.set(name, [...this.listeners.get(name) ?? [], listener]); }
  appendChild(child: FakeNode) { child.parent = this; this.children.push(child); return child; }
  get parentNode(): FakeNode | undefined { return this.parent; }
  insertBefore(child: FakeNode, before: FakeNode | null) {
    const index = before === null ? -1 : this.children.indexOf(before);
    if (index === -1) return this.appendChild(child);
    child.parent = this;
    this.children.splice(index, 0, child);
    return child;
  }
  replaceChildren(...children: FakeNode[]) { this.children.length = 0; for (const child of children) this.appendChild(child); }
  contains(other: FakeNode | null): boolean { return other === this || this.children.some((child) => child.contains(other)); }
  focus() {}
  setPointerCapture() {}
  getBoundingClientRect() { return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight }; }
  click() { for (const listener of this.listeners.get("click") ?? []) listener({ preventDefault() {} }); }

  /** Every element below, in document order. */
  descendants(): FakeNode[] { return this.children.flatMap((child) => [child, ...child.descendants()]); }

  querySelectorAll(selector: string): FakeNode[] {
    const tags = selector.split(",").map((part) => part.trim());
    return this.descendants().filter((node) => tags.some((tag) =>
      tag.startsWith("[") ? node.attributes.has(tag.slice(1, -1)) : node.tagName === tag));
  }

  querySelector(selector: string): FakeNode | null { return this.querySelectorAll(selector)[0] ?? null; }
  hasClass(name: string) { return this.className.split(" ").includes(name); }
}

class FakeDocument {
  readonly body = new FakeNode("body", this);
  readonly activeElement = null;
  title = "";

  constructor() {
    for (const id of ["project", "counts", "live", "runs", "detail", "panels"]) {
      this.body.appendChild(this.createElement("div")).setAttribute("id", id);
    }
  }

  createElement(tag: string) { return new FakeNode(tag, this); }
  createElementNS(_namespace: string, tag: string) { return new FakeNode(tag, this); }
  createTextNode(text: string) { const node = new FakeNode("#text", this); node.textContent = text; return node; }
  getElementById(id: string) { return this.body.descendants().find((node) => node.id === id) ?? null; }
  querySelectorAll(selector: string) { return this.body.querySelectorAll(selector); }
  querySelector(selector: string) { return this.body.querySelector(selector); }
}

/** Runs the served page's script against a fake document, sending its requests to the page's server. */
function openPage(html: string, url: string, send = (path: string, init: RequestInit) => fetch(new URL(path, url), init)) {
  const script = /<script>([\s\S]*)<\/script>/u.exec(html)?.[1];
  assert.ok(script, "the page has its script");
  const document = new FakeDocument();
  const sources: Array<{ onmessage?: (event: { data: string }) => void }> = [];
  const context = createContext({
    document,
    window: { addEventListener() {} },
    location: { hash: "" },
    history: { replaceState() {} },
    EventSource: class { constructor() { sources.push(this); } },
    fetch: send,
    setInterval() { return 0; },
    setTimeout,
    console,
  });
  runInContext(script, context);
  return {
    document,
    show(state: unknown) { for (const source of sources) source.onmessage?.({ data: JSON.stringify(state) }); },
  };
}

/** The run list's sections by title, each with the titles of the runs it holds and their cards. */
function runSections(document: FakeDocument) {
  const sections = new Map<string, Map<string, FakeNode>>();
  for (const section of document.getElementById("runs")!.children) {
    const heading = section.children.find((node) => node.hasClass("section-title"));
    if (heading === undefined) continue;
    const cards = section.children.filter((node) => node.hasClass("run"));
    sections.set(heading.children[0]!.textContent, new Map(cards.map((card) => [
      card.children.find((node) => node.hasClass("title"))!.textContent, card,
    ])));
  }
  return sections;
}

function clock(iso: string) {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

test("machine ui shows a request's headline and marks its recommended choice, and a choice still answers with its name", async () => {
  const requests: Array<{ path: string; init: RequestInit }> = [];
  const page = openPage(runUiPage("page-token"), "http://localhost/", async (path, init) => {
    requests.push({ path, init });
    return new Response("{}", { status: 200 });
  });
  const stamp = new Date().toISOString();
  const waiting = {
    ...run, id: "asking", label: "Asking", status: "waiting", state: "ask",
    human: { prompt: presentedPrompt, requestId: "request-1", ...presentation },
    startedAt: stamp, updatedAt: stamp,
  };
  page.show({ project: { name: "test" }, directory: "/tmp", panels: [], runs: [waiting] });
  const detail = page.document.getElementById("detail")!;
  assert.ok(detail.textContent.includes(presentation.headline), detail.textContent);
  assert.ok(detail.textContent.includes(presentedPrompt), detail.textContent);
  assert.ok(
    detail.textContent.indexOf(presentation.headline) < detail.textContent.indexOf(presentedPrompt),
    "the headline does not come before the prompt",
  );
  const buttons = detail.querySelectorAll("button");
  const marked = buttons.filter((button) => /recommended/iu.test(button.textContent));
  assert.equal(marked.length, 1, buttons.map((button) => button.textContent).join(" | "));
  assert.match(marked[0]!.textContent, /^approve\b/u);

  marked[0]!.click();
  await new Promise((resolveTurn) => setImmediate(resolveTurn));
  assert.equal(requests.length, 1);
  assert.deepEqual(JSON.parse(String(requests[0]!.init.body)), {
    runId: "asking", requestId: "request-1", response: "approve", question: false,
  });

  // A request without the fields draws its choices as before, each named exactly.
  const plain = openPage(runUiPage("page-token"), "http://localhost/", async () => new Response("{}", { status: 200 }));
  plain.show({ project: { name: "test" }, directory: "/tmp", panels: [], runs: [{
    ...waiting, human: { prompt: "Ship it?", requestId: "request-2", choices: ["approve", "deny"] },
  }] });
  const plainDetail = plain.document.getElementById("detail")!;
  assert.deepEqual(plainDetail.querySelectorAll("button").map((button) => button.textContent).filter((text) => text === "approve" || text === "deny"), ["approve", "deny"]);
  assert.doesNotMatch(plainDetail.textContent, /recommended/iu);
});

test("the sleeping form sends only plain answers and explains host continuation after recording", async () => {
  const requests: Array<{ path: string; init: RequestInit }> = [];
  const page = openPage(runUiPage("page-token"), "http://localhost/", async (path, init) => {
    requests.push({ path, init });
    return new Response("{}", { status: 200 });
  });
  const stamp = new Date().toISOString();
  const asking = {
    ...run, id: "asking", label: "Asking", status: "sleeping", continuedBy: "host",
    human: { prompt: "What next?", requestId: "open-request", discussion: true, suggestions: ["Review"] },
    startedAt: stamp, updatedAt: stamp,
  };
  const resting = { ...run, id: "resting", label: "Resting", status: "sleeping", due: stamp, startedAt: stamp, updatedAt: stamp };
  const snapshot = (request: unknown) => ({
    project: { name: "test" }, directory: "/tmp", panels: [],
    runs: [resting, { ...run, id: "running", status: "running", startedAt: stamp, updatedAt: stamp }, request],
  });
  page.show(snapshot(asking));
  const detail = page.document.getElementById("detail")!;
  assert.match(detail.textContent, /What next\?/u, "an unanswered sleeping request is selected before running or timed runs");
  assert.deepEqual(detail.querySelectorAll("input"), [], "sleeping requests cannot take discussion questions");
  assert.deepEqual(detail.querySelectorAll("[data-since]"), [], "sleeping does not draw a live running timer");
  detail.querySelectorAll("textarea")[0]!.value = "Review";
  detail.querySelectorAll("button").find((button) => button.textContent === "Send")!.click();
  await new Promise((resolveTurn) => setImmediate(resolveTurn));
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.path, "/api/respond");
  assert.equal(requests[0]!.init.method, "POST");
  assert.deepEqual(JSON.parse(String(requests[0]!.init.body)), {
    runId: "asking", requestId: "open-request", response: "Review", question: false,
  });
  assert.match(detail.textContent, /Answer recorded\. The run wakes when its host continues it\./u);
  page.show(snapshot({ ...asking, human: { ...asking.human, answer: "Review" } }));
  assert.match(detail.textContent, /Answer recorded\. The run wakes when its host continues it\./u);
  assert.match(detail.textContent, /request: open-request/u);
  assert.deepEqual(detail.querySelectorAll("textarea"), []);
  assert.ok(!detail.querySelectorAll("button").some((button) => /wake|continue/iu.test(button.textContent)));
  const sections = runSections(page.document);
  assert.equal(sections.has("Waiting on you"), false);
  const timed = [...sections.get("Sleeping")!.values()].find((card) => card.textContent.includes("due "))!;
  timed.click();
  assert.match(detail.textContent, /Sleeping until .*\(due now\)/u);
  assert.deepEqual(detail.querySelectorAll("textarea"), []);
});

test("the page shows sleeping runs with their request or due time, and answers a sleeping request without waking it", async (context) => {
  const directory = await temporary(context);
  const project = await temporary(context);
  const environment = { MACHINES_RUN_STATUS_DIR: directory };
  const due = new Date(Date.now() + 3_600_000).toISOString();
  const request = { prompt: "Ship the release?", requestId: "request-1", choices: ["approve", "deny"] };
  createRunStatusPublisher({ ...run, id: "asking-run", label: "org-1: Asking" }, environment).sleepForAnswer(request);
  createRunStatusPublisher({ ...run, id: "answered-run", label: "org-2: Answered" }, environment).sleepForAnswer({ ...request, requestId: "request-2" });
  assert.equal(await respondToRun({ directory, runId: "answered-run", requestId: "request-2", response: "deny" }), "recorded");
  createRunStatusPublisher({ ...run, id: "resting-run", label: "org-3: Resting" }, environment).sleep(due);

  // A sleeping run's process has ended on purpose: it is never shown as lost.
  assert.deepEqual(
    Object.fromEntries(uiRuns(directory, () => false).map((found) => [found.id, found.status])),
    { "asking-run": "sleeping", "answered-run": "sleeping", "resting-run": "sleeping" },
  );

  const ui = await startRunUi({ directory, projectDir: project, port: 0, pollMilliseconds: 50 });
  context.after(() => ui.close());
  const page = openPage((await call(ui.url)).body, ui.url);
  page.show(JSON.parse((await call(`${ui.url}api/state`)).body));
  const { document } = page;

  // The one waiting for an answer is with the runs waiting on a person; the others sleep, with their note.
  const sections = runSections(document);
  assert.ok(sections.get("Waiting on you")?.has("org-1: Asking"), JSON.stringify([...sections.keys()]));
  assert.ok(sections.get("Sleeping")?.has("org-3: Resting"), JSON.stringify([...sections.keys()]));
  assert.ok(sections.get("Sleeping")?.has("org-2: Answered"), JSON.stringify([...sections.keys()]));
  assert.equal(sections.has("Lost"), false);
  assert.match(sections.get("Sleeping")!.get("org-3: Resting")!.textContent, new RegExp(clock(due), "u"));
  assert.match(sections.get("Sleeping")!.get("org-2: Answered")!.textContent, /answered/u);
  const waitingCount = document.getElementById("counts")!.children.find((chip) => chip.textContent.endsWith("waiting on you"));
  assert.equal(waitingCount?.textContent, "1waiting on you");

  const detail = () => document.getElementById("detail")!;
  const buttons = () => detail().querySelectorAll("button").map((button) => button.textContent);
  const open = (title: string) => {
    for (const cards of runSections(document).values()) cards.get(title)?.click();
    // Nothing on the page wakes a run.
    assert.ok(!buttons().some((text) => /wake|continue/iu.test(text)), buttons().join(", "));
  };

  // A timed wait says when it is due and takes no answer.
  open("org-3: Resting");
  assert.match(detail().textContent, new RegExp(`Sleeping until ${clock(due)}`, "u"));
  assert.deepEqual(detail().querySelectorAll("textarea"), []);
  assert.ok(!buttons().includes("approve"));

  // An answered request says its answer is recorded and how the run wakes, with no form.
  open("org-2: Answered");
  assert.match(detail().textContent, /Answer recorded/u);
  assert.match(detail().textContent, /machine continue answered-run/u);
  assert.ok(!buttons().includes("approve") && !buttons().includes("deny"), buttons().join(", "));

  // An unanswered request has the answer form; the answer is recorded, and the run stays asleep.
  open("org-1: Asking");
  assert.match(detail().textContent, /Ship the release\?/u);
  assert.deepEqual(detail().querySelectorAll("input"), []);
  detail().querySelectorAll("button").find((button) => button.textContent === "approve")!.click();
  for (let tries = 0; !/Answer recorded/u.test(detail().textContent) && tries < 100; tries += 1) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  assert.match(detail().textContent, /Answer recorded/u);
  assert.match(detail().textContent, /machine continue asking-run/u);
  const recorded = readRunStatuses(directory).find((found) => found.id === "asking-run");
  assert.equal(recorded?.status, "sleeping");
  assert.equal(recorded?.human?.answer, "approve");
});

test("a definition's graph marks each final that takes an ending with its kind, and a published record keeps it", async (context) => {
  const endings = defineEndings({ shipped: { kind: "succeeded" }, broken: { kind: "failed" }, dropped: { kind: "cancelled" } });
  const definition = machine({
    initial: "work",
    states: {
      work: operation(() => ({ type: "done" }), { done: "shipped", failed: "broken", cancelled: "dropped" }),
      shipped: final(endings.shipped),
      broken: final(endings.broken),
      dropped: final(endings.dropped),
    },
  });
  // The package's entry draws from the definition and the module's endings, as `machine run` does.
  const graph = (machineGraph as (definition: unknown, endings?: unknown) => ReturnType<typeof machineGraph>)(definition, endings);
  assert.deepEqual(graph?.states, [
    { id: "work", kind: "operation" },
    { id: "shipped", kind: "final", ending: "succeeded" },
    { id: "broken", kind: "final", ending: "failed" },
    { id: "dropped", kind: "final", ending: "cancelled" },
  ]);

  const directory = await temporary(context);
  createRunStatusPublisher({ ...run, id: "drawn", graph: graph! }, { MACHINES_RUN_STATUS_DIR: directory }).update({ state: "work" });
  assert.deepEqual(readRunStatuses(directory)[0]?.graph, graph);
});

test("machine ui draws each ending kind distinctly, and a graph without endings as before", () => {
  const stamp = new Date().toISOString();
  const graph = (ending: boolean) => ({
    initial: "work",
    states: [
      { id: "work", kind: "operation" },
      ...[["shipped", "succeeded"], ["broken", "failed"], ["dropped", "cancelled"]].map(([id, kind]) =>
        ({ id, kind: "final", ...(ending ? { ending: kind } : {}) })),
    ],
    edges: [{ from: "work", to: "shipped", event: "done" }, { from: "work", to: "broken", event: "failed" }, { from: "work", to: "dropped", event: "cancelled" }],
  });
  /** The colour bar of each drawn state, and the legend's entries, for a finished run of `graph`. */
  const drawn = (ending: boolean) => {
    const page = openPage(runUiPage("page-token"), "http://localhost/", async () => new Response("{}"));
    page.show({
      project: { name: "test" }, directory: "/tmp", panels: [],
      runs: [{ ...run, id: "ended", label: "Ended", status: "completed", state: "shipped", graph: graph(ending), startedAt: stamp, updatedAt: stamp }],
    });
    const detail = page.document.getElementById("detail")!;
    const bars = Object.fromEntries(detail.descendants()
      .filter((node) => node.tagName === "g" && node.hasClass("node"))
      .map((node) => [
        node.children.find((child) => child.tagName === "title")!.textContent.split(" ")[0],
        node.children.find((child) => child.tagName === "rect" && child.getAttribute("width") === "4")?.getAttribute("fill"),
      ]));
    const legend = detail.descendants().find((node) => node.hasClass("legend"))!.children.map((child) => child.textContent);
    return { bars, legend };
  };

  const ended = drawn(true);
  assert.deepEqual(Object.keys(ended.bars).sort(), ["broken", "dropped", "shipped", "work"]);
  const fills = [ended.bars.shipped, ended.bars.broken, ended.bars.dropped];
  assert.equal(new Set([...fills, ended.bars.work]).size, 4, JSON.stringify(ended.bars));
  for (const kind of ["succeeded", "failed", "cancelled"]) assert.ok(ended.legend.includes(kind), ended.legend.join(", "));

  // Without endings every final is drawn alike, and the legend is unchanged.
  const plain = drawn(false);
  assert.equal(new Set([plain.bars.shipped, plain.bars.broken, plain.bars.dropped]).size, 1, JSON.stringify(plain.bars));
  assert.deepEqual(plain.legend, ["agent", "operation", "human", "final"]);
});

// Read from the module so that each case fails on its own until the export exists.
const nestGraph = (graphModule as unknown as {
  readonly nestGraph: (graph: RunGraph, at: string, child: RunGraph) => RunGraph;
}).nestGraph;
const sorted = (graph: RunGraph) => ({
  ...graph,
  states: graph.states.map((state) => JSON.stringify(state)).sort(),
  edges: graph.edges.map((edge) => JSON.stringify(edge)).sort(),
});

test("a definition's graph draws a use state as a group whose edges out are the child's endings", () => {
  const graph = machineGraph(machine({
    initial: "review",
    states: {
      review: use("./review-child.machine.ts", { input: () => "", on: { approved: "accepted", rejected: "refused" } }),
      accepted: final(),
      refused: final(),
    },
  } as never) as unknown as AnyStateMachine);
  assert.deepEqual(graph?.states, [{ id: "review", kind: "group" }, { id: "accepted", kind: "final" }, { id: "refused", kind: "final" }]);
  assert.deepEqual(graph?.edges, [
    { from: "review", to: "accepted", event: "approved" },
    { from: "review", to: "refused", event: "rejected" },
  ]);
});

const parentGraph: RunGraph = {
  initial: "review",
  states: [{ id: "review", kind: "group" }, { id: "accepted", kind: "final" }, { id: "refused", kind: "final" }],
  edges: [{ from: "review", to: "accepted", event: "approved" }, { from: "review", to: "refused", event: "rejected" }],
};
const childGraph: RunGraph = {
  initial: "check",
  states: [
    { id: "check", kind: "group" },
    { id: "check.run", parent: "check", kind: "agent", role: "reviewer" },
    { id: "approved", kind: "final", ending: "succeeded" },
    { id: "rejected", kind: "final", ending: "failed" },
  ],
  edges: [{ from: "check", to: "approved", event: "done" }, { from: "check.run", to: "rejected", event: "rejected" }],
};

test("a child's graph is placed under its use state, once however often the state is entered", () => {
  const nested = nestGraph(parentGraph, "review", childGraph);
  assert.deepEqual(sorted(nested), sorted({
    initial: "review",
    states: [
      ...parentGraph.states,
      { id: "review.check", parent: "review", kind: "group" },
      { id: "review.check.run", parent: "review.check", kind: "agent", role: "reviewer" },
      { id: "review.approved", parent: "review", kind: "final", ending: "succeeded" },
      { id: "review.rejected", parent: "review", kind: "final", ending: "failed" },
    ],
    edges: [
      ...parentGraph.edges,
      { from: "review.check", to: "review.approved", event: "done" },
      { from: "review.check.run", to: "review.rejected", event: "rejected" },
    ],
  }));
  // Entering the use state again draws nothing twice.
  assert.deepEqual(sorted(nestGraph(nested, "review", childGraph)), sorted(nested));
});

test("a child that would take the graph past its limits leaves the graph as drawn so far", () => {
  const many = (count: number): RunGraph => ({
    states: Array.from({ length: count }, (_, index) => ({ id: `s${index}`, kind: "operation" as const })),
    edges: [],
  });
  assert.deepEqual(nestGraph(parentGraph, "review", many(300)), parentGraph);
  const looping: RunGraph = {
    states: [{ id: "a", kind: "operation" }],
    edges: Array.from({ length: 1_000 }, (_, index) => ({ from: "a", to: "a", event: `e${index}` })),
  };
  assert.deepEqual(nestGraph(parentGraph, "review", looping), parentGraph);
});

/** Runs the review-parent fixture under `machine run`, returning its record as published during the child's Agent state. */
async function recordDuringChild(context: TestContext) {
  const root = await temporary(context);
  const directory = join(root, "status");
  const observed = join(root, "observed.json");
  const child = spawn(process.execPath, [resolve("src/cli.ts"), "run", resolve("tests/fixtures/use/review-parent.machine.ts")], {
    cwd: resolve("tests/fixtures/use-observe-project"),
    env: { ...process.env, MACHINES_RUN_STATUS_DIR: directory, MACHINES_USER_HOME: root, USE_OBSERVED: observed },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const code = await new Promise((resolveExit) => child.on("exit", resolveExit));
  assert.equal(code, 0, stderr);
  const { records } = JSON.parse(await readFile(observed, "utf8")) as { readonly records: readonly RunStatusRecord[] };
  assert.equal(records.length, 1);
  return records[0]!;
}

test("machine ui draws a running child's states inside its use state and marks the child's state as current", async (context) => {
  const record = await recordDuringChild(context);
  const page = openPage(runUiPage("page-token"), "http://localhost/", async () => new Response("{}"));
  page.show({ project: { name: "test" }, directory: "/tmp", panels: [], runs: [record] });
  const nodes = new Map(page.document.getElementById("detail")!.descendants()
    .filter((node) => node.tagName === "g" && node.hasClass("node"))
    .map((node) => [node.children.find((child) => child.tagName === "title")!.textContent.split(" ")[0], node]));
  const box = (id: string) => nodes.get(id)?.children.find((child) => child.tagName === "rect" && child.hasClass("box"));
  assert.ok(nodes.has("review.review"), [...nodes.keys()].join(", "));
  assert.equal(box("review")?.getAttribute("stroke-dasharray"), "4 3", "the use state is drawn as a group");
  assert.ok(nodes.get("review.review")!.hasClass("current"), "the child's Agent state is current");
  assert.equal(nodes.get("review")!.hasClass("current"), false);
  // The run's card names the nested path.
  const card = [...runSections(page.document).values()].flatMap((cards) => [...cards.values()])[0]!;
  assert.match(card.textContent, /review\.review/u);
});

test("machine ui keeps presentation visible for recorded requests and requests answered elsewhere", () => {
  const stamp = new Date().toISOString();
  for (const variant of [
    { status: "waiting", answeredBy: "host", answer: undefined },
    { status: "sleeping", answeredBy: undefined, answer: "approve" },
  ]) {
    const page = openPage(runUiPage("page-token"), "http://localhost/", async () => new Response("{}", { status: 200 }));
    page.show({ project: { name: "test" }, directory: "/tmp", panels: [], runs: [{
      ...run, id: "asking", state: "ask", ...variant, startedAt: stamp, updatedAt: stamp,
      human: { prompt: presentedPrompt, requestId: "request-1", ...presentation, answer: variant.answer },
    }] });
    const detail = page.document.getElementById("detail")!;
    assert.ok(detail.textContent.indexOf(presentation.headline) >= 0);
    assert.ok(detail.textContent.indexOf(presentation.headline) < detail.textContent.indexOf(presentedPrompt));
    assert.match(detail.textContent, /approve \(recommended\)/u);
    assert.match(detail.textContent, /discard \(discards work\)/u);
    assert.ok(!detail.textContent.includes(presentation.page));
  }
});

test("machine ui keeps suggestion presentation visible for recorded requests and requests answered elsewhere", () => {
  const stamp = new Date().toISOString();
  for (const variant of [
    { status: "waiting", answeredBy: "host", answer: undefined },
    { status: "sleeping", answeredBy: undefined, answer: "approve" },
  ]) {
    const page = openPage(runUiPage("page-token"), "http://localhost/", async () => new Response("{}", { status: 200 }));
    page.show({ project: { name: "test" }, directory: "/tmp", panels: [], runs: [{
      ...run, id: "asking", state: "ask", ...variant, startedAt: stamp, updatedAt: stamp,
      human: { prompt: presentedPrompt, requestId: "request-1", ...suggestedPresentation, answer: variant.answer },
    }] });
    const detail = page.document.getElementById("detail")!;
    assert.ok(detail.textContent.indexOf(suggestedPresentation.headline) >= 0);
    assert.ok(detail.textContent.indexOf(suggestedPresentation.headline) < detail.textContent.indexOf(presentedPrompt));
    assert.match(detail.textContent, /suggestions: more rounds \(recommended\)/u);
    assert.match(detail.textContent, /discard \(discards work\)/u);
  }
});

test("machine ui labels suggestions and their effects while sending the bare suggestion", async () => {
  const requests: Array<{ path: string; init: RequestInit }> = [];
  const page = openPage(runUiPage("page-token"), "http://localhost/", async (path, init) => {
    requests.push({ path, init });
    return new Response("{}", { status: 200 });
  });
  const stamp = new Date().toISOString();
  page.show({ project: { name: "test" }, directory: "/tmp", panels: [], runs: [{
    ...run, id: "asking", status: "waiting", state: "ask", startedAt: stamp, updatedAt: stamp,
    human: { prompt: presentedPrompt, requestId: "request-1", ...suggestedPresentation },
  }] });
  const detail = page.document.getElementById("detail")!;
  const buttons = detail.querySelectorAll("button");
  const marked = buttons.filter((button) => /recommended/u.test(button.textContent));
  assert.equal(marked.length, 1);
  assert.equal(marked[0]!.textContent, "more rounds (recommended)");
  assert.ok(detail.textContent.includes(suggestedPresentation.effects["more rounds"]));
  assert.ok(detail.textContent.includes(suggestedPresentation.effects.discard));
  assert.ok(buttons.some((button) => button.textContent === "discard (discards work)"));
  marked[0]!.click();
  assert.equal(requests.length, 0, "a suggestion fills the answer without submitting");
  assert.equal(detail.querySelectorAll("textarea")[0]!.value, "more rounds");
  buttons.find((button) => button.textContent === "Send")!.click();
  await new Promise((resolveTurn) => setImmediate(resolveTurn));
  assert.equal(requests.length, 1);
  assert.deepEqual(JSON.parse(String(requests[0]!.init.body)), {
    runId: "asking", requestId: "request-1", response: "more rounds", question: false,
  });
});
