import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";

import { MachineSession as McpSession } from "../mcp/server.ts";
import { MachineSession, type RunSnapshot } from "../src/session.ts";

const machine = resolve("tests/fixtures/host-sequential.machine.ts");

test("closing a session during startup rejects the start and leaves no runs", async () => {
  const session = new McpSession();
  const started = session.start({ cwd: resolve("tests/fixtures/mcp-project"), machine: "review" });
  session.close();
  await assert.rejects(started, /closed|terminated/u);
  assert.deepEqual(session.status({}).structuredContent?.runs, []);
  await assert.rejects(session.start({ cwd: process.cwd(), machine: "missing" }), /closed/u);
});

test("a session rejects duplicate and stale answers without consuming the next request", async (context) => {
  const session = new MachineSession();
  context.after(() => session.close());
  const run = await session.start({ machine });
  const first = await waiting(session, run.id);
  const answers = await Promise.allSettled([
    session.respond({ runId: run.id, requestId: first.human!.requestId, response: "yes" }),
    session.respond({ runId: run.id, requestId: first.human!.requestId, response: "again" }),
  ]);
  assert.equal(answers.filter((answer) => answer.status === "fulfilled").length, 1);
  const second = await waiting(session, run.id);
  assert.equal(first.human!.prompt, second.human!.prompt);
  assert.notEqual(first.human!.requestId, second.human!.requestId);
  await assert.rejects(
    session.respond({ runId: run.id, requestId: first.human!.requestId, response: "late" }),
    /stale/u,
  );
  assert.equal(session.status(run.id)[0]?.human?.requestId, second.human!.requestId);
  await session.respond({ runId: run.id, requestId: second.human!.requestId, response: "finish" });
  await eventually(() => {
    const completed = session.status(run.id)[0]!;
    assert.equal(completed.status, "completed");
    assert.equal(completed.human, undefined);
    assert.equal(completed.state, "done");
  });
});

test("a session sends a question only to a request that allows discussion, and the Machine asks again", async (context) => {
  const session = new MachineSession();
  context.after(() => session.close());
  const fixture = resolve("tests/fixtures/human-inbox.machine.ts");

  const restricted = await session.start({ machine: fixture, input: "choices" });
  const closed = await waiting(session, restricted.id);
  await assert.rejects(
    session.ask({ runId: restricted.id, requestId: closed.human!.requestId, question: "Why?" }),
    /does not support discussion/u,
  );
  assert.equal(session.status(restricted.id)[0]?.human?.requestId, closed.human!.requestId);

  const run = await session.start({ machine: fixture, input: "discussion" });
  const first = await waiting(session, run.id);
  const question = { runId: run.id, requestId: first.human!.requestId };
  await assert.rejects(session.ask({ ...question, requestId: "stale", question: "Why?" }), /stale/u);
  await assert.rejects(session.ask({ ...question, question: " " }), /Question must contain/u);
  await assert.rejects(session.ask({ ...question, question: "x".repeat(8001) }), /Question must contain/u);
  assert.equal(session.status(run.id)[0]?.human?.requestId, first.human!.requestId);

  const asked = await Promise.allSettled([
    session.ask({ ...question, question: "Why three?" }),
    session.ask({ ...question, question: "Why three, again?" }),
  ]);
  assert.equal(asked.filter((sent) => sent.status === "fulfilled").length, 1);
  await eventually(() => assert.equal(session.status(run.id)[0]?.human?.prompt, "Approve it now?"));
  const second = session.status(run.id)[0]!;
  assert.notEqual(second.human!.requestId, first.human!.requestId);
  await assert.rejects(session.ask({ ...question, question: "Late?" }), /stale/u);
  await session.respond({ runId: run.id, requestId: second.human!.requestId, response: "approve" });
  await eventually(() => assert.deepEqual(session.status(run.id)[0]?.output, [
    { type: "question", value: "Why three?" },
    { type: "submitted", value: "approve" },
  ]));
});

test("session notifications and snapshots share one lifecycle and retain only five finished runs", async (context) => {
  const session = new MachineSession();
  context.after(() => session.close());
  const events: Array<{ type: string; run: RunSnapshot }> = [];
  const unsubscribe = session.subscribe((event) => events.push(event));
  const active = await session.start({ machine });
  const failures = await Promise.all(Array.from({ length: 7 }, () => session.start({
    machine: resolve("tests/fixtures/host.machine.ts"),
    input: "fail",
  })));
  await eventually(() => assert.equal(events.filter((event) => event.type === "finished").length, 7));
  assert.equal(session.status().filter((run) => run.status === "failed").length, 5);
  assert.equal(session.status(active.id)[0]?.status, "waiting");
  assert.equal(events.filter((event) => event.type === "human").length, 1);
  assert.equal(events.some((event) => event.run.error?.includes("host fixture failed")), true);
  const retained = new Set(session.status().map((run) => run.id));
  assert.equal(failures.filter((run) => !retained.has(run.id)).length, 2);
  unsubscribe();
  session.close();
  assert.deepEqual(session.status(), []);
});

async function waiting(session: MachineSession, id: string): Promise<RunSnapshot> {
  await eventually(() => assert.equal(session.status(id)[0]?.status, "waiting"));
  return session.status(id)[0]!;
}

async function eventually(assertion: () => void): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (true) {
    try { assertion(); return; } catch (cause) {
      if (Date.now() >= deadline) throw cause;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

test("a failed presentation subscriber cannot reject a start or hide lifecycle events", async (context) => {
  const session = new MachineSession();
  context.after(() => session.close());
  const warnings: string[] = [];
  context.mock.method(process, "emitWarning", (warning: string | Error) => { warnings.push(String(warning)); });
  const events: string[] = [];
  session.subscribe(() => { throw new Error("widget render failed"); });
  session.subscribe(({ type }) => events.push(type));
  const run = await session.start({ machine });
  for (let request = 0; request < 2; request += 1) {
    const current = await waiting(session, run.id);
    await session.respond({ runId: run.id, requestId: current.human!.requestId, response: "yes" });
  }
  await eventually(() => assert.equal(session.status(run.id)[0]?.status, "completed"));
  assert.ok(events.includes("updated"));
  assert.equal(events.filter((event) => event === "human").length, 2);
  assert.equal(events.filter((event) => event === "finished").length, 1);
  assert.equal(warnings.length, events.length);
  assert.ok(warnings.every((warning) => warning.includes("widget render failed")));
});
