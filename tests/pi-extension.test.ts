import "./environment.ts";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { setup, type Result, type Theme } from "./helpers/pi-extension.ts";
import { readRunWatches, writeRunWatches } from "../src/run-watch.ts";
import { writeRunStatusRecord, type RunStatusRecord } from "../src/run-status.ts";

test("registers Machine tools, passive watches, and explicit wake attachments with discovery guidance", () => {
  const extension = setup();
  assert.deepEqual([...extension.tools.keys()].sort(), [
    "machine_list",
    "machine_agents",
    "machine_start",
    "machine_status",
    "machine_respond",
    "machine_watch",
    "machine_unwatch",
    "machine_attach",
    "machine_detach",
  ].sort());
  assert.deepEqual([...extension.commands.keys()].sort(), ["machine-watch", "machine-unwatch", "machine-attach", "machine-detach"].sort());
  assert.match(extension.tools.get("machine_list")?.promptSnippet ?? "", /Discover/u);
  assert.match(
    extension.tools.get("machine_start")?.promptGuidelines?.join(" ") ?? "",
    /asynchronous.*without adding requirements/u,
  );
});

test("lists discoverable Machines and configured Agent presets", async () => {
  const extension = setup();
  const [machines, agents] = await Promise.all([
    extension.execute("machine_list"),
    extension.execute("machine_agents"),
  ]);

  assert.match(machines.content[0].text, /wait — Waits for a deterministic Human decision/u);
  assert.match(agents.content[0].text, /fast — A deterministic Agent preset/u);
  assert.match(agents.content[0].text, /fixture · tiny · low/u);
});

test("lists usage-limit fallbacks and shows a run that waits for a reset", async () => {
  const extension = setup(resolve("tests/fixtures/agent-limit-project"));
  const agents = await extension.execute("machine_agents");
  assert.match(agents.content[0].text, /^default — .* \(fixture\)\n  .*agents\.ts · fallback: spare$/mu);
  assert.match(agents.content[0].text, /^waits — .*\n  .*agents\.ts · fallback: none$/mu);

  const started = await extension.execute("machine_start", { machine: "work", agents: { default: "waits" } });
  await eventually(async () => {
    const status = await extension.execute("machine_status", { runId: runId(started) });
    const [run] = statusRuns(status);
    assert.equal(run?.status, "running");
    const limit = "waits (role default) reached its usage limit; waiting for the reset at ";
    assert.ok(status.content[0].text.includes(`\nLimit: ${limit}`));
    assert.ok(extension.ui.widget?.some((line) => line.includes(limit)));
  });
  await extension.shutdown();
});

test("starts two concurrent runs, reports both, and responds by exact id", async () => {
  const extension = setup();
  const [firstResult, secondResult] = await Promise.all([
    extension.execute("machine_start", { machine: "wait", input: "first" }),
    extension.execute("machine_start", { machine: "wait", input: "second" }),
  ]);
  const firstId = runId(firstResult);
  const secondId = runId(secondResult);
  assert.notEqual(firstId, secondId);

  await eventually(async () => {
    const status = await extension.execute("machine_status");
    const runs = statusRuns(status);
    assert.equal(runs.filter((run) => run.status === "waiting").length, 2);
    assert.doesNotMatch(status.content[0].text, /Recent:/u);
    assert.equal(runs.some((run) => "activity" in run), false);
    assert.match(extension.ui.widget?.join("\n") ?? "", /first|second/u);
  });
  await eventually(() => assert.equal(extension.ui.selections.length, 2));

  const runs = statusRuns(await extension.execute("machine_status"));
  const firstRequestId = humanRequestId(runs.find((run) => run.id === firstId)!);
  const secondRequestId = humanRequestId(runs.find((run) => run.id === secondId)!);
  await assert.rejects(
    extension.execute("machine_respond", { runId: firstId, requestId: firstRequestId, response: "other" }),
    /Expected one of: approve, deny/u,
  );
  await extension.execute("machine_respond", { runId: firstId, requestId: firstRequestId, response: "approve" });
  await extension.execute("machine_respond", { runId: secondId, requestId: secondRequestId, response: "deny" });

  await eventually(async () => {
    const status = await extension.execute("machine_status");
    assert.equal(
      statusRuns(status).filter((run) => run.status === "completed").length,
      2,
    );
    assert.match(extension.ui.widget?.join("\n") ?? "", /✓.*done/u);
  });
  assert.equal(
    extension.ui.notifications.filter(({ message }) => message.includes("completed")).length,
    2,
  );
  await extension.shutdown();
});

test("routes a suggested Human response directly through a Pi selector", async () => {
  const extension = setup();
  extension.ui.selectionResponses.push("approve");

  await extension.execute("machine_start", { machine: "review", input: "direct" });

  await eventually(async () => {
    const status = await extension.execute("machine_status");
    assert.equal(statusRuns(status)[0]?.status, "completed");
  });
  assert.deepEqual(extension.ui.selections, [{
    title: "Review direct?",
    options: ["approve", "details", "Other…"],
  }]);
  assert.deepEqual(extension.ui.inputs, []);
  await extension.shutdown();
});

test("routes Other through direct Pi input without involving the parent Agent", async () => {
  const extension = setup();
  extension.ui.selectionResponses.push("Other…");
  extension.ui.inputResponses.push("Please revise the copy");

  await extension.execute("machine_start", { machine: "review", input: "feedback" });

  await eventually(async () => {
    const status = await extension.execute("machine_status");
    assert.equal(statusRuns(status)[0]?.status, "completed");
  });
  assert.deepEqual(extension.ui.inputs, [{
    title: "Review feedback?",
    placeholder: "Type your response",
  }]);
  await extension.shutdown();
});

test("shutdown terminates waiting hosts and clears the widget", async () => {
  const extension = setup();
  await extension.execute("machine_start", { machine: "wait", input: "shutdown" });
  await eventually(async () => {
    assert.match(extension.ui.widget?.join("\n") ?? "", /input needed/u);
    assert.match(extension.ui.widget?.[0] ?? "", /^┌/u);
    assert.match(extension.ui.widget?.at(-1) ?? "", /^└/u);
    assert.equal(extension.ui.widget?.[0]?.length, 120);
    assert.equal(extension.ui.widget?.at(-1)?.length, 120);
    assert.equal(extension.ui.widgetPlacement, "aboveEditor");
  });

  await extension.shutdown();
  assert.equal(extension.ui.widget, undefined);
  assert.equal(
    extension.ui.notifications.some(({ message }) => message.includes("failed")),
    false,
  );
});

test("tool results stay compact until Pi expands them", async () => {
  const extension = setup();
  const result = await extension.execute("machine_list");
  const render = extension.tools.get("machine_list")?.renderResult;
  assert.ok(render);
  const theme: Theme = { fg: (_color, text) => text, bold: (text) => text };

  assert.match(render(result, { expanded: false }, theme).render(80)[0] ?? "", /Ctrl\+O/u);
  assert.match(render(result, { expanded: true }, theme).render(80).join("\n"), /wait —/u);
});

function runId(result: Result): string {
  const details = result.details as { readonly run?: { readonly id?: unknown } };
  const id = details.run?.id;
  if (typeof id !== "string") throw new Error("machine_start did not return a run id");
  return id;
}

function statusRuns(result: Result): Array<{ readonly status: string; readonly [key: string]: unknown }> {
  const details = result.details as { readonly runs?: unknown };
  assert.ok(Array.isArray(details.runs));
  return details.runs as Array<{ readonly status: string }>;
}

async function eventually(assertion: () => void | Promise<void>): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (true) {
    try {
      await assertion();
      return;
    } catch (cause) {
      if (Date.now() >= deadline) throw cause;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    }
  }
}

function humanRequestId(run: Record<string, unknown>): string {
  const human = run.human;
  assert.ok(human !== null && typeof human === "object" && "requestId" in human);
  assert.equal(typeof human.requestId, "string");
  return human.requestId as string;
}

test("Pi shutdown while its first start is loading cannot create a late run", async () => {
  const extension = setup();
  const started = extension.execute("machine_start", { machine: "wait" });
  await extension.shutdown();
  await assert.rejects(started, /closed|terminated/u);
  assert.equal(extension.ui.widget, undefined);
  assert.equal(extension.ui.notifications.length, 0);
});

test("Pi preserves structured input and exposes completed output", async context => {
  const extension = setup(); context.after(() => extension.shutdown());
  const input = { task: "Pi JSON", enabled: false, value: null };
  const started = await extension.execute("machine_start", { machine: resolve("tests/fixtures/structured.machine.ts"), input });
  const id = runId(started);
  await eventually(async () => {
    const run = statusRuns(await extension.execute("machine_status", { runId: id }))[0]!;
    assert.equal(run.status, "completed");
    assert.deepEqual(run.output, input);
  });
});


test("coordinators discover Machines before multi-step work without requiring an explicit request", () => {
  const guidance = setup().tools.get("machine_list")?.promptGuidelines?.join(" ") ?? "";
  assert.match(guidance, /Before delegating work or starting multi-step/u);
  assert.match(guidance, /does not need to name Machines/u);
  assert.match(guidance, /Keep trivial edits.*direct/u);
  assert.match(guidance, /already executing a Machine Agent state/u);
  assert.match(guidance, /does not authorize paid model calls/u);
  assert.doesNotMatch(guidance, /Otherwise handle one-off tasks normally/u);
});


test("Pi keeps work with the conversation that has its context and delegates the rest to Machines", () => {
  const tool = setup().tools.get("machine_list");
  assert.match(tool?.description ?? "", /Before delegating/u);
  const guidance = tool?.promptGuidelines?.join(" ") ?? "";
  assert.match(guidance, /The conversation that understands a piece of work should do it/u);
  assert.match(guidance, /separate feature that can run in parallel, a review that needs clean eyes, or work for later as a ticket/u);
  assert.match(guidance, /Split work by context, not by kind/u);
  assert.match(guidance, /When delegating,[^.]*rather than[^.]*native sub-agents/u);
  assert.match(guidance, /problem and its fences, not the design: Goal[^.]*observable[^.]*Forbidden[^.]*where the context lives/u);
});


test("Pi gives project orchestrators the same project setup entry point", () => {
  const tool = setup().tools.get("machine_list");
  const guidance = tool?.promptGuidelines?.join(" ") ?? "";
  assert.match(guidance, /project orchestrator/u);
  assert.match(guidance, /machine-project-setup/u);
  assert.match(guidance, /major work/u);
  assert.match(guidance, /not.*every task/u);
});


function publishedRun(change: Partial<RunStatusRecord> = {}): RunStatusRecord {
  const now = new Date().toISOString();
  return {
    schemaVersion: 2, id: "dispatch-attempt-1", pid: process.pid,
    machine: "ticket", label: "fix-login Fix the login page", cwd: "/elsewhere",
    path: "/elsewhere/.machines/ticket.ts", status: "running", state: "implement",
    startedAt: now, updatedAt: now, ...change,
  };
}

function statusDirectory(context: import("node:test").TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), "pi-watch-"));
  const previous = process.env.MACHINES_RUN_STATUS_DIR;
  process.env.MACHINES_RUN_STATUS_DIR = directory;
  context.after(() => {
    if (previous === undefined) delete process.env.MACHINES_RUN_STATUS_DIR;
    else process.env.MACHINES_RUN_STATUS_DIR = previous;
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

test("a Pi subscription sees future Dispatch attempts in the same widget without taking ownership", async context => {
  const directory = statusDirectory(context);
  const extension = setup(); context.after(() => extension.shutdown());
  await extension.start();
  const watched = await extension.execute("machine_watch", { target: "fix-login" });
  assert.match(watched.content[0].text, /1 subscription.*0 visible runs/u);
  assert.equal(extension.ui.widget, undefined);
  const record = publishedRun();
  writeRunStatusRecord(directory, record);
  // No further tool call: the widget must poll while the ticket has not yet started.
  await eventually(() => assert.match(extension.ui.widget?.join("\n") ?? "", /fix-login Fix the login page.*implement/u));
  const human = { prompt: "Approve login change?", requestId: "request-1", choices: ["approve", "deny"] };
  writeRunStatusRecord(directory, { ...record, status: "waiting", human });
  await eventually(() => assert.match(extension.ui.widget?.join("\n") ?? "", /Approve login change/u));
  assert.match(extension.ui.widget!.join("\n"), /Watching only/u);
  assert.deepEqual(extension.ui.selections, []);
  assert.deepEqual(extension.ui.inputs, []);
  await assert.rejects(extension.execute("machine_respond", {
    runId: record.id, requestId: human.requestId, response: "approve",
  }), /Unknown|not found/u);
  const before = readFileSync(join(directory, `${record.id}.json`), "utf8");
  await extension.execute("machine_unwatch", { target: "fix-login" });
  assert.equal(extension.ui.widget, undefined);
  assert.equal(readFileSync(join(directory, `${record.id}.json`), "utf8"), before);
  await extension.shutdown();
  assert.equal(readFileSync(join(directory, `${record.id}.json`), "utf8"), before);
  await assert.rejects(extension.execute("machine_watch", { target: "fix-login" }), /closed/u);
});

test("subscriptions are scoped to Pi's actual session, survive reload, and see CLI watch changes", async context => {
  const directory = statusDirectory(context);
  const first = setup(); const other = setup();
  context.after(() => { first.shutdown(); other.shutdown(); });
  const record = publishedRun();
  writeRunStatusRecord(directory, record);
  await first.commands.get("machine-watch")!.handler("fix-login", first.context);
  await first.execute("machine_watch", { target: "fix-login" });
  assert.deepEqual(readRunWatches(directory, first.sessionId), [{ text: "fix-login" }]);
  await other.start();
  assert.equal(other.ui.widget, undefined);
  await first.shutdown();
  const resumed = setup(undefined, first.sessionId); context.after(() => resumed.shutdown());
  await resumed.start();
  assert.match(resumed.ui.widget?.join("\n") ?? "", /fix-login/u);
  writeRunWatches(directory, other.sessionId, [{ text: "fix-login" }]);
  await eventually(() => assert.match(other.ui.widget?.join("\n") ?? "", /fix-login/u));
  await resumed.commands.get("machine-unwatch")!.handler("fix-login", resumed.context);
  assert.equal(resumed.ui.widget, undefined);
  assert.deepEqual(readRunWatches(directory, other.sessionId), [{ text: "fix-login" }]);
});

test("published selection ignores malformed, nested, unrelated, and expired runs and follows a new attempt", async context => {
  const directory = statusDirectory(context);
  const extension = setup(); context.after(() => extension.shutdown());
  writeFileSync(join(directory, "broken.json"), "{");
  for (const record of [
    publishedRun({ id: "nested", parent: "parent" }),
    publishedRun({ id: "other", label: "fix-login-extra unrelated" }),
    publishedRun({ status: "completed", updatedAt: new Date(Date.now() - 60_000).toISOString() }),
  ]) writeRunStatusRecord(directory, record);
  await extension.execute("machine_watch", { target: "fix-login" });
  assert.equal(extension.ui.widget, undefined);
  writeRunStatusRecord(directory, publishedRun({ id: "dispatch-attempt-2", state: "review" }));
  await eventually(() => assert.match(extension.ui.widget?.join("\n") ?? "", /fix-login.*review/u));
  writeRunStatusRecord(directory, publishedRun({ id: "dispatch-attempt-2", status: "completed", state: "delivered" }));
  await extension.execute("machine_watch");
  await eventually(() => assert.match(extension.ui.widget?.join("\n") ?? "", /✓.*delivered/u));
});

test("sleeping published runs remain visible without a live process and lost runs are not shown as running", async context => {
  const directory = statusDirectory(context);
  const extension = setup(); context.after(() => extension.shutdown());
  // An invalid PID cannot be live on the supported platforms.
  const record = publishedRun({ pid: 2147483647, status: "sleeping", human: { prompt: "Choose a fix", requestId: "q1" } });
  writeRunStatusRecord(directory, record);
  await extension.execute("machine_watch", { target: "fix-login" });
  assert.match(extension.ui.widget?.join("\n") ?? "", /input needed/u);
  writeRunStatusRecord(directory, { ...record, human: { ...record.human!, answer: "fix" } });
  await extension.execute("machine_watch");
  assert.match(extension.ui.widget?.join("\n") ?? "", /awaiting continuation/u);
  writeRunStatusRecord(directory, { ...record, human: undefined, due: new Date(Date.now() + 60_000).toISOString() });
  await extension.execute("machine_watch");
  assert.match(extension.ui.widget?.join("\n") ?? "", /sleeping until/u);
  writeRunStatusRecord(directory, { ...record, status: "running", human: undefined });
  await extension.execute("machine_watch");
  assert.match(extension.ui.widget?.join("\n") ?? "", /✕.*lost/u);
});

test("owned and watched copies share one widget row; an owned run still uses Pi's Human dialog", async context => {
  statusDirectory(context);
  const extension = setup(); context.after(() => extension.shutdown());
  const started = await extension.execute("machine_start", { machine: "wait", input: "owned" });
  const id = runId(started);
  await extension.execute("machine_watch", { target: id });
  await eventually(() => assert.equal(extension.ui.selections.length, 1));
  await extension.execute("machine_watch");
  assert.equal(extension.ui.widget?.filter(line => line.includes(id.slice(0, 8))).length, 1);
});

test("subscriptions reject disabled publication, missing identity, and invalid targets", async context => {
  const extension = setup(); context.after(() => extension.shutdown());
  await assert.rejects(extension.execute("machine_watch", { target: "fix-login" }), /publication is off/u);
  statusDirectory(context);
  await assert.rejects(extension.execute("machine_watch", { target: "bad\nlabel" }), /one line/u);
  await assert.rejects(extension.execute("machine_watch", { target: "  " }), /Expected/u);
  const noIdentity = { cwd: extension.context.cwd, ui: extension.ui };
  await assert.rejects(extension.tools.get("machine_watch")!.execute("test", { target: "fix-login" }, undefined, undefined, noIdentity), /session id/u);
  await extension.commands.get("machine-unwatch")!.handler("", extension.context);
  assert.match(extension.ui.notifications.at(-1)!.message, /Usage:/u);
});
