import "./environment.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, type TestContext } from "node:test";

import { writeRunStatusRecord, type RunStatusRecord } from "../src/run-status.ts";
import { setup, type Result } from "./helpers/pi-extension.ts";

type Extension = ReturnType<typeof setup>;

function publication(context: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), "machines-pi-wake-"));
  const previous = process.env.MACHINES_RUN_STATUS_DIR;
  process.env.MACHINES_RUN_STATUS_DIR = directory;
  context.after(() => {
    if (previous === undefined) delete process.env.MACHINES_RUN_STATUS_DIR;
    else process.env.MACHINES_RUN_STATUS_DIR = previous;
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

function extensionFor(context: TestContext, sessionId: string = randomUUID(), entries?: Extension["entries"]) {
  const extension = setup(undefined, sessionId, entries);
  context.after(() => extension.shutdown());
  return extension;
}

function external(change: Partial<RunStatusRecord> = {}): RunStatusRecord {
  const now = new Date().toISOString();
  return {
    schemaVersion: 2, id: "external-attempt-1", pid: process.pid,
    owner: "external-execution-owner", machine: "ticket", label: "wake-ticket Review the change",
    cwd: "/external-project", path: "/external-project/.machines/ticket.ts",
    status: "running", state: "implement", startedAt: now, updatedAt: now, ...change,
  };
}

const human = { prompt: "Approve this change?", requestId: "human-1", choices: ["approve", "deny"] };

function startedId(result: Result): string {
  const id = (result.details as { run?: { id?: unknown } }).run?.id;
  assert.equal(typeof id, "string");
  return id as string;
}

function runs(result: Result): Array<Record<string, unknown>> {
  const value = (result.details as { runs?: unknown }).runs;
  assert.ok(Array.isArray(value));
  return value as Array<Record<string, unknown>>;
}

function textOf(extension: Extension, index = extension.messages.length - 1): string {
  const content = extension.messages[index]?.message.content;
  assert.ok(content !== undefined, "The extension must send a model-facing event, not only a UI notification");
  return typeof content === "string" ? content : content.map(block => block.text ?? "").join("\n");
}

function assertWake(extension: Extension, id: string, event: RegExp, index = extension.messages.length - 1) {
  const delivery = extension.messages[index];
  assert.ok(delivery, "No model continuation was delivered");
  assert.equal(delivery.sessionId, extension.sessionId);
  assert.equal(delivery.idle, true, "Busy events must remain locally cancellable until Pi settles");
  assert.equal(delivery.options?.triggerTurn, true, "nextTurn alone cannot start an idle model");
  assert.equal(delivery.options?.deliverAs, "followUp");
  assert.ok(delivery.message.customType.length > 0);
  const text = textOf(extension, index);
  assert.ok(text.includes(id), "A wake event must identify the exact run");
  assert.match(text, event);
  assert.match(text, /machine_status/u, "The model must retrieve the authoritative snapshot");
}

async function eventually(assertion: () => void | Promise<void>) {
  const deadline = Date.now() + 4_000;
  while (true) {
    try { await assertion(); return; }
    catch (cause) {
      if (Date.now() >= deadline) throw cause;
      await new Promise<void>(resolvePromise => setTimeout(resolvePromise, 20));
    }
  }
}

// A full polling interval lets negative assertions catch delayed sends. Positive
// controls in the same tests prove that the observer and settlement hook work.
async function pollingInterval() {
  await new Promise<void>(resolvePromise => setTimeout(resolvePromise, 1_100));
}

for (const scenario of [
  { name: "completion", machine: resolve("tests/fixtures/structured.machine.ts"), input: { summary: "finished" }, status: "completed", event: /complet/iu },
  { name: "failure", machine: resolve("tests/fixtures/host.machine.ts"), input: "fail", status: "failed", event: /fail/iu },
  { name: "Human wait", machine: "wait", input: "wake parent", status: "waiting", event: /Human|input|waiting/u },
]) {
  test(`parent-spawned ${scenario.name} wakes its initiating idle Pi session without status polling`, async context => {
    const extension = extensionFor(context);
    await extension.start();
    const id = startedId(await extension.execute("machine_start", { machine: scenario.machine, input: scenario.input }));
    // Do not call machine_status until the extension has independently woken Pi.
    await eventually(() => assert.equal(extension.messages.length, 1));
    assertWake(extension, id, scenario.event);
    const snapshot = runs(await extension.execute("machine_status", { runId: id }))[0]!;
    assert.equal(snapshot.status, scenario.status);
    if (scenario.status === "waiting") {
      const request = snapshot.human as { requestId: string };
      assert.ok(textOf(extension).includes(request.requestId));
      assert.match(textOf(extension), /Human/u);
      assert.match(textOf(extension), /(?:must|only|never|do not|does not).*(?:answer|decision|respond|authoriz)/iu);
      await eventually(() => assert.equal(extension.ui.selections.length, 1));
      assert.equal(runs(await extension.execute("machine_status", { runId: id }))[0]!.status, "waiting");
    }
    // Snapshot reads and lifecycle replays cannot produce a second wake.
    await extension.execute("machine_status", { runId: id });
    await extension.settle();
    await pollingInterval();
    assert.equal(extension.messages.length, 1);
  });
}

test("spawned events stay cancellable while busy and flush once after full settlement", async context => {
  const extension = extensionFor(context);
  await extension.start();
  extension.state.idle = false;
  const id = startedId(await extension.execute("machine_start", { machine: "wait", input: "busy parent" }));
  await eventually(() => assert.equal(extension.ui.selections.length, 1));
  assert.deepEqual(extension.messages, []);
  await extension.emit("agent_end", { messages: [] });
  await pollingInterval();
  assert.deepEqual(extension.messages, [], "agent_end is not final settlement");
  await extension.settle();
  await eventually(() => assert.equal(extension.messages.length, 1));
  assertWake(extension, id, /Human|input|waiting/u);
  await extension.settle();
  assert.equal(extension.messages.length, 1);
});

test("six spawned completions queued while busy all wake and remain retrievable beyond session retention", async context => {
  const extension = extensionFor(context);
  await extension.start();
  extension.state.idle = false;
  const ids: string[] = [];
  for (let index = 0; index < 6; index += 1) {
    const id = startedId(await extension.execute("machine_start", {
      machine: resolve("tests/fixtures/structured.machine.ts"), input: { summary: `result-${index}` },
    }));
    ids.push(id);
    // Observe child completion through presentation, without model status polling.
    await eventually(() => assert.ok(extension.ui.notifications.some(item =>
      item.message.includes(id.slice(0, 8)) && item.message.includes("completed"))));
  }
  assert.deepEqual(extension.messages, []);
  await extension.settle();
  assert.equal(extension.messages.length, ids.length);
  for (const [index, id] of ids.entries()) {
    const messageIndex = extension.messages.findIndex((_, position) => textOf(extension, position).includes(id));
    assert.ok(messageIndex >= 0, `Missing completion for ${id}`);
    assertWake(extension, id, /complet/iu, messageIndex);
    const snapshot = runs(await extension.execute("machine_status", { runId: id }))[0]!;
    assert.equal(snapshot.status, "completed");
    assert.deepEqual(snapshot.output, { summary: `result-${index}` });
  }
  await extension.settle();
  await pollingInterval();
  assert.equal(extension.messages.length, ids.length, "Retained snapshots must not replay delivered events");
  await extension.execute("machine_detach", { target: ids[0] });
  await assert.rejects(extension.execute("machine_status", { runId: ids[0] }), /not found/u);
});

for (const source of ["spawned", "external"]) {
  for (const outcome of ["success", "failure", "cancellation"]) {
    test(`${source} completion during manual compaction wakes after ${outcome} without agent_settled`, async context => {
      const directory = source === "external" ? publication(context) : undefined;
      const extension = extensionFor(context);
      await extension.start();
      extension.state.idle = false;
      await extension.emit("session_before_compact", { reason: "manual", willRetry: false });
      let id: string;
      if (source === "spawned") {
        id = startedId(await extension.execute("machine_start", {
          machine: resolve("tests/fixtures/structured.machine.ts"), input: { summary: "compacting" },
        }));
        await eventually(() => assert.ok(extension.ui.notifications.some(item =>
          item.message.includes(id.slice(0, 8)) && item.message.includes("completed"))));
      } else {
        assert.ok(directory);
        const record = external();
        id = record.id;
        writeRunStatusRecord(directory, record);
        await extension.execute("machine_attach", { target: id });
        writeRunStatusRecord(directory, { ...record, status: "completed" });
        await pollingInterval();
      }
      assert.deepEqual(extension.messages, []);
      if (outcome === "success") {
        // Pi emits success before clearing its manual compaction busy state.
        await extension.emit("session_compact", { reason: "manual", willRetry: false });
        // Also cross widget expiry with publication off: pending delivery must
        // keep the observer alive even when nothing remains on screen.
        if (source === "spawned") {
          await new Promise<void>(done => setTimeout(done, 6_500));
          await eventually(() => assert.equal(extension.ui.widget, undefined));
        } else await pollingInterval();
        assert.deepEqual(extension.messages, [], "A compaction hook alone must not bypass the idle check");
        extension.state.idle = true;
      } else {
        // Failure/cancellation is emitted after Pi clears that busy state.
        extension.state.idle = true;
        await extension.emit("session_compact_failed", {
          reason: "manual", willRetry: false, aborted: outcome === "cancellation",
          ...(outcome === "failure" ? { errorMessage: "Compaction failed" } : {}),
        });
      }
      await eventually(() => assert.equal(extension.messages.length, 1));
      assertWake(extension, id, /complet/iu);
      assert.equal(runs(await extension.execute("machine_status", { runId: id }))[0]!.status, "completed");
      await pollingInterval();
      assert.equal(extension.messages.length, 1);
    });
  }
}

for (const source of ["spawned", "external"]) {
  for (const outcome of ["success", "failure", "cancellation"]) {
    test(`${source} completion during branch summarization wakes after ${outcome} without agent_settled`, async context => {
      const directory = source === "external" ? publication(context) : undefined;
      const extension = extensionFor(context);
      await extension.start();
      const record = external();
      if (directory !== undefined) {
        writeRunStatusRecord(directory, record);
        await extension.execute("machine_attach", { target: record.id });
      }
      extension.state.idle = false;
      const summary = new AbortController();
      await extension.emit("session_before_tree", {
        preparation: { targetId: "other-branch", userWantsSummary: true }, signal: summary.signal,
      });
      let id: string;
      if (source === "spawned") {
        // Also exercise registration created after the navigation hook.
        id = startedId(await extension.execute("machine_start", {
          machine: resolve("tests/fixtures/structured.machine.ts"), input: { summary: "navigating" },
        }));
        await eventually(() => assert.ok(extension.ui.notifications.some(item =>
          item.message.includes(id.slice(0, 8)) && item.message.includes("completed"))));
      } else {
        assert.ok(directory);
        id = record.id;
        writeRunStatusRecord(directory, { ...record, status: "completed" });
      }
      await pollingInterval();
      assert.deepEqual(extension.messages, []);
      if (outcome === "success") {
        // Pi emits session_tree before finally clearing its busy state.
        await extension.emit("session_tree", { newLeafId: "other-branch", oldLeafId: "old-branch" });
        await pollingInterval();
        assert.deepEqual(extension.messages, [], "Tree navigation cannot bypass the idle check");
      } else if (outcome === "cancellation") summary.abort();
      // Failure and cancellation have no session_tree or compaction outcome.
      // All paths clear Pi's branch-summary busy flag in navigateTree's finally.
      extension.state.idle = true;
      await eventually(() => assert.equal(extension.messages.length, 1));
      assertWake(extension, id, /complet/iu);
      assert.equal(runs(await extension.execute("machine_status", { runId: id }))[0]!.status, "completed");
      await pollingInterval();
      assert.equal(extension.messages.length, 1, "Polling must not replay the recovered event");
    });
  }
}

for (const source of ["spawned", "external"]) {
  test(`${source} branch summarization recovery preserves the agent-settlement barrier`, async context => {
    const directory = source === "external" ? publication(context) : undefined;
    const extension = extensionFor(context);
    await extension.start();
    extension.state.idle = false;
    await extension.emit("session_before_tree", { signal: new AbortController().signal });
    let id: string;
    if (source === "spawned") {
      id = startedId(await extension.execute("machine_start", {
        machine: resolve("tests/fixtures/structured.machine.ts"), input: { summary: "agent barrier" },
      }));
      await eventually(() => assert.ok(extension.ui.notifications.some(item =>
        item.message.includes(id.slice(0, 8)) && item.message.includes("completed"))));
    } else {
      assert.ok(directory);
      const record = external({ status: "completed" });
      id = record.id;
      writeRunStatusRecord(directory, record);
      await extension.execute("machine_attach", { target: id });
    }
    await extension.emit("session_tree");
    // Another agent starts before the observer can see the brief idle window.
    await extension.emit("before_agent_start", { messageType: "user" });
    await extension.emit("agent_start");
    // Neither a later tree hook nor agent_end may clear an active agent barrier.
    await extension.emit("session_before_tree", { signal: new AbortController().signal });
    await extension.emit("session_tree");
    await extension.emit("agent_end", { messages: [] });
    extension.state.idle = true;
    await pollingInterval();
    assert.deepEqual(extension.messages, []);
    await extension.settle();
    assert.equal(extension.messages.length, 1);
    assertWake(extension, id, /complet/iu);
  });
}

test("branch summarization keeps passive watches silent until explicitly attached", async context => {
  const directory = publication(context);
  const extension = extensionFor(context);
  await extension.start();
  const record = external({ owner: extension.sessionId });
  writeRunStatusRecord(directory, record);
  await extension.execute("machine_watch", { target: record.id });
  extension.state.idle = false;
  await extension.emit("session_before_tree", { signal: new AbortController().signal });
  writeRunStatusRecord(directory, { ...record, status: "completed" });
  await pollingInterval();
  extension.state.idle = true;
  await pollingInterval();
  assert.deepEqual(extension.messages, [], "A tree lifecycle hook must not register passive runs");
  await extension.execute("machine_attach", { target: record.id });
  assert.equal(extension.messages.length, 1);
  assertWake(extension, record.id, /complet/iu);
});

for (const cleanup of ["detach", "switch", "shutdown"]) {
  test(`branch summarization recovery rechecks ${cleanup} before idle delivery`, async context => {
    const directory = publication(context);
    const extension = extensionFor(context);
    await extension.start();
    const record = external();
    writeRunStatusRecord(directory, record);
    await extension.execute("machine_attach", { target: record.id });
    extension.state.idle = false;
    await extension.emit("session_before_tree", { signal: new AbortController().signal });
    writeRunStatusRecord(directory, { ...record, status: "completed" });
    await pollingInterval();
    assert.deepEqual(extension.messages, []);
    extension.state.idle = true;
    if (cleanup === "detach") await extension.execute("machine_detach", { target: record.id });
    else if (cleanup === "switch") extension.state.sessionId = "different-session";
    else await extension.shutdown();
    await pollingInterval();
    assert.deepEqual(extension.messages, []);
    if (cleanup !== "detach") assert.equal(extension.ui.widget, undefined);
    assert.equal(JSON.parse(readFileSync(join(directory, `${record.id}.json`), "utf8")).status, "completed");
  });
}

test("a new agent run after manual compaction still defers queued events until full settlement", async context => {
  const directory = publication(context);
  const extension = extensionFor(context);
  await extension.start();
  extension.state.idle = false;
  const record = external();
  writeRunStatusRecord(directory, record);
  await extension.execute("machine_attach", { target: record.id });
  writeRunStatusRecord(directory, { ...record, status: "completed" });
  await pollingInterval();
  await extension.emit("session_compact", { reason: "manual", willRetry: false });
  await extension.emit("before_agent_start", { messageType: "user" });
  await extension.emit("agent_start");
  await extension.emit("agent_end", { messages: [] });
  extension.state.idle = true;
  await extension.emit("session_compact", { reason: "threshold", willRetry: false });
  await extension.emit("session_compact_failed", { reason: "overflow", willRetry: true, aborted: false });
  await pollingInterval();
  assert.deepEqual(extension.messages, [], "Manual recovery cannot bypass a later agent's settlement");
  await extension.settle();
  assert.equal(extension.messages.length, 1);
});

test("detaching after manual compaction cancels a queued event before the idle refresh", async context => {
  const directory = publication(context);
  const extension = extensionFor(context);
  await extension.start();
  extension.state.idle = false;
  const record = external();
  writeRunStatusRecord(directory, record);
  await extension.execute("machine_attach", { target: record.id });
  writeRunStatusRecord(directory, { ...record, status: "completed" });
  await pollingInterval();
  await extension.emit("session_compact", { reason: "manual", willRetry: false });
  extension.state.idle = true;
  await extension.execute("machine_detach", { target: record.id });
  await pollingInterval();
  assert.deepEqual(extension.messages, []);
});

test("unregistering a spawned run cancels queued and future wakes while preserving its owned host", async context => {
  const extension = extensionFor(context);
  await extension.start();
  extension.state.idle = false;
  const id = startedId(await extension.execute("machine_start", { machine: "wait", input: "unregister" }));
  await eventually(() => assert.equal(extension.ui.selections.length, 1));
  await extension.execute("machine_detach", { target: id });
  await extension.settle();
  assert.deepEqual(extension.messages, []);
  const waiting = runs(await extension.execute("machine_status", { runId: id }))[0]!;
  assert.equal(waiting.status, "waiting", "Unregistering must not stop an owned run");
  const requestId = (waiting.human as { requestId: string }).requestId;
  await extension.execute("machine_respond", { runId: id, requestId, response: "approve" });
  await eventually(async () => assert.equal(runs(await extension.execute("machine_status", { runId: id }))[0]!.status, "completed"));
  await pollingInterval();
  assert.deepEqual(extension.messages, []);
});

for (const status of ["completed", "failed", "waiting"] as const) {
  test(`an explicitly attached external ${status} event wakes idle Pi without owning or answering the run`, async context => {
    const directory = publication(context);
    const extension = extensionFor(context);
    const record = external();
    writeRunStatusRecord(directory, record);
    await extension.start();
    await extension.execute("machine_attach", { target: record.id });
    const changed = { ...record, status, ...(status === "waiting" ? { human } : {}), ...(status === "failed" ? { error: "external failure" } : {}) };
    writeRunStatusRecord(directory, changed);
    const before = readFileSync(join(directory, `${record.id}.json`), "utf8");
    // No MachineSession.start and no status tool call: the publisher is external.
    await eventually(() => assert.equal(extension.messages.length, 1));
    assertWake(extension, record.id, new RegExp(status === "waiting" ? "Human|input|waiting" : status, "iu"));
    const snapshot = runs(await extension.execute("machine_status", { runId: record.id }))[0]!;
    assert.equal(snapshot.id, record.id);
    assert.equal(snapshot.status, status);
    assert.equal(snapshot.owner, record.owner);
    if (status === "waiting") {
      assert.ok(textOf(extension).includes(human.requestId));
      assert.match(textOf(extension), /Human/u);
      assert.match(textOf(extension), /(?:must|only|never|do not|does not).*(?:answer|decision|respond|authoriz)/iu);
      await assert.rejects(extension.execute("machine_respond", {
        runId: record.id, requestId: human.requestId, response: "approve",
      }), /Unknown|not found|owner|attach|external|read.only/iu);
    }
    assert.deepEqual(extension.ui.selections, []);
    assert.deepEqual(extension.ui.inputs, []);
    await extension.execute("machine_detach", { target: record.id });
    await extension.shutdown();
    assert.equal(readFileSync(join(directory, `${record.id}.json`), "utf8"), before);
    assert.equal(existsSync(join(directory, `${record.id}.inbox`)), false);
  });
}

test("external busy delivery waits for settlement and detach cancels only the detached target", async context => {
  const directory = publication(context);
  const extension = extensionFor(context);
  await extension.start();
  extension.state.idle = false;
  const cancelled = external();
  const retained = external({ id: "another-external-run", label: "other-ticket" });
  for (const record of [cancelled, retained]) {
    writeRunStatusRecord(directory, record);
    await extension.execute("machine_attach", { target: record.id });
    writeRunStatusRecord(directory, { ...record, status: "completed" });
  }
  await pollingInterval();
  assert.deepEqual(extension.messages, []);
  await extension.emit("agent_end", { messages: [] });
  assert.deepEqual(extension.messages, []);
  await extension.execute("machine_detach", { target: cancelled.id });
  await extension.settle();
  await eventually(() => assert.equal(extension.messages.length, 1));
  assertWake(extension, retained.id, /complet/iu);
  assert.ok(!textOf(extension).includes(cancelled.id));
  await pollingInterval();
  assert.equal(extension.messages.length, 1);
});

test("attaching a separately hosted run leaves Human responses and process lifetime with its real owner", async context => {
  const directory = publication(context);
  const extension = extensionFor(context);
  await extension.start();
  const { startMachineHost } = await import("../src/host.ts");
  let request: { requestId: string } | undefined;
  const hosted = await startMachineHost({
    machine: resolve("tests/fixtures/host.machine.ts"), input: "external owner",
    owner: "separate-host-owner", publishRunStatus: true,
    onHumanRequest: value => { request = value; },
  });
  // This host belongs to this test's external owner, never MachineSession.
  // Observe its rejection even if a failed assertion needs to terminate it.
  void hosted.result.catch(() => {});
  context.after(() => hosted.terminate());
  await eventually(() => assert.ok(request));
  await extension.execute("machine_attach", { target: hosted.id });
  await eventually(() => assert.equal(extension.messages.length, 1));
  assertWake(extension, hosted.id, /Human|input|waiting/u);
  const before = readFileSync(join(directory, `${hosted.id}.json`), "utf8");
  await assert.rejects(extension.execute("machine_respond", {
    runId: hosted.id, requestId: request!.requestId, response: "approve",
  }), /Unknown|not found|owner|attach|external|read.only/iu);
  await extension.execute("machine_detach", { target: hosted.id });
  await extension.shutdown();
  assert.deepEqual(extension.ui.selections, []);
  assert.equal(readFileSync(join(directory, `${hosted.id}.json`), "utf8"), before);
  await hosted.respond("approve", request!.requestId);
  assert.deepEqual(await hosted.result, { state: "done" }, "The external owner can still finish after Pi shuts down");
  await pollingInterval();
  assert.equal(extension.messages.length, 1);
});

test("passive watches and published ownership never become implicit wake registrations", async context => {
  const directory = publication(context);
  const extension = extensionFor(context);
  await extension.start();
  const record = external({ owner: extension.sessionId });
  await extension.execute("machine_watch", { target: "wake-ticket" });
  for (const change of [
    { status: "running" as const, state: "progress" },
    { status: "waiting" as const, human },
    { status: "failed" as const, error: "failed" },
    { status: "completed" as const },
  ]) {
    writeRunStatusRecord(directory, { ...record, ...change });
    await pollingInterval();
    await extension.settle();
    assert.deepEqual(extension.messages, []);
  }
  // Positive control: only explicit attachment activates model delivery.
  await extension.execute("machine_attach", { target: record.id });
  await eventually(() => assert.equal(extension.messages.length, 1));
  assertWake(extension, record.id, /complet/iu);
});

test("overlapping attachments deduplicate snapshots and reconnects while distinct Human requests and attempts wake separately", async context => {
  const directory = publication(context);
  const extension = extensionFor(context);
  await extension.start();
  let record = external();
  writeRunStatusRecord(directory, record);
  await extension.execute("machine_attach", { target: "wake-ticket" });
  await extension.execute("machine_attach", { target: record.id });
  record = { ...record, status: "waiting", human };
  writeRunStatusRecord(directory, record);
  await eventually(() => assert.equal(extension.messages.length, 1));
  for (let index = 0; index < 3; index += 1) {
    writeRunStatusRecord(directory, { ...record, updatedAt: new Date().toISOString() });
    await extension.execute("machine_status", { runId: record.id });
    await extension.settle();
  }
  await extension.execute("machine_detach", { target: record.id });
  await extension.execute("machine_detach", { target: "wake-ticket" });
  await extension.execute("machine_attach", { target: "wake-ticket" });
  await pollingInterval();
  assert.equal(extension.messages.length, 1, "Reattaching must not replay the same Human request");
  record = { ...record, human: { ...human, requestId: "human-2" } };
  writeRunStatusRecord(directory, record);
  await eventually(() => assert.equal(extension.messages.length, 2));
  assert.ok(textOf(extension).includes("human-2"));
  record = { ...record, status: "completed", human: undefined };
  writeRunStatusRecord(directory, record);
  await eventually(() => assert.equal(extension.messages.length, 3));
  assertWake(extension, record.id, /complet/iu);
  const next = external({ id: "external-attempt-2", status: "waiting", human });
  writeRunStatusRecord(directory, next);
  await eventually(() => assert.equal(extension.messages.length, 4));
  assertWake(extension, next.id, /Human|input|waiting/u);
  // Continuation keeps the run id but has a new execution identity.
  const continued = { ...record, continued: { at: new Date(Date.now() + 1_000).toISOString(), machineChanged: false } };
  writeRunStatusRecord(directory, continued);
  await eventually(() => assert.equal(extension.messages.length, 5));
  assertWake(extension, record.id, /complet/iu);
  await pollingInterval();
  assert.equal(extension.messages.length, 5);
});

test("progress, timed sleeps, and answered sleeping requests stay silent; new unanswered requests wake", async context => {
  const directory = publication(context);
  const extension = extensionFor(context);
  await extension.start();
  const record = external();
  writeRunStatusRecord(directory, record);
  await extension.execute("machine_attach", { target: record.id });
  for (const change of [
    { state: "review", now: "Making progress" },
    { status: "sleeping" as const, due: new Date(Date.now() + 60_000).toISOString() },
    { status: "sleeping" as const, human: { ...human, answer: "approve" } },
  ]) {
    writeRunStatusRecord(directory, { ...record, ...change });
    await pollingInterval();
    await extension.settle();
    assert.deepEqual(extension.messages, []);
  }
  writeRunStatusRecord(directory, { ...record, status: "sleeping", human });
  await eventually(() => assert.equal(extension.messages.length, 1));
  assertWake(extension, record.id, /Human|input|waiting/u);
  writeRunStatusRecord(directory, { ...record, status: "waiting", human });
  await pollingInterval();
  assert.equal(extension.messages.length, 1, "Sleeping and live views of one request share an identity");
});

test("attached status retrieval survives terminal widget expiry", async context => {
  const directory = publication(context);
  const extension = extensionFor(context);
  await extension.start();
  const record = external();
  writeRunStatusRecord(directory, record);
  await extension.execute("machine_attach", { target: record.id });
  // Simulate a delayed read beyond both widget retention windows, without a
  // 30-second test delay. The authoritative file remains available.
  writeRunStatusRecord(directory, { ...record, status: "completed", state: "done", updatedAt: new Date(Date.now() - 60_000).toISOString() });
  await eventually(() => assert.equal(extension.messages.length, 1));
  const snapshot = runs(await extension.execute("machine_status", { runId: record.id }))[0]!;
  assert.equal(snapshot.id, record.id);
  assert.equal(snapshot.status, "completed");
  assert.equal(snapshot.state, "done");
});

test("delivered event identities survive reload but active attachments require explicit renewal", async context => {
  const directory = publication(context);
  const first = extensionFor(context);
  await first.start();
  const record = external({ status: "waiting", human });
  writeRunStatusRecord(directory, record);
  await first.execute("machine_attach", { target: record.id });
  await eventually(() => assert.equal(first.messages.length, 1));
  await first.shutdown("reload");
  const resumed = extensionFor(context, first.sessionId, first.entries);
  await resumed.start("reload");
  await pollingInterval();
  assert.deepEqual(resumed.messages, []);
  writeRunStatusRecord(directory, { ...record, human: { ...human, requestId: "human-2" } });
  await pollingInterval();
  assert.deepEqual(resumed.messages, [], "A replaced runtime must not silently restore active delivery");
  // Replaying an already delivered identity after explicit renewal stays silent.
  writeRunStatusRecord(directory, record);
  await resumed.execute("machine_attach", { target: record.id });
  await pollingInterval();
  assert.deepEqual(resumed.messages, []);
  writeRunStatusRecord(directory, { ...record, human: { ...human, requestId: "human-2" } });
  await eventually(() => assert.equal(resumed.messages.length, 1));
  assertWake(resumed, record.id, /Human|input|waiting/u);
  assert.ok(textOf(resumed).includes("human-2"));
});

for (const reason of ["quit", "reload", "new", "resume", "fork"]) {
  test(`${reason} invalidates pending callbacks and resources without notifying a replacement session or stopping external work`, async context => {
    const directory = publication(context);
    const old = extensionFor(context);
    await old.start();
    old.state.idle = false;
    const record = external();
    writeRunStatusRecord(directory, record);
    await old.execute("machine_attach", { target: record.id });
    writeRunStatusRecord(directory, { ...record, status: "waiting", human });
    await pollingInterval();
    assert.deepEqual(old.messages, []);
    const before = readFileSync(join(directory, `${record.id}.json`), "utf8");
    await old.shutdown(reason);
    const replacement = extensionFor(context, reason === "reload" ? old.sessionId : randomUUID(), old.entries);
    await replacement.start(reason);
    await old.settle(); // A callback already captured by the old runtime is stale.
    await replacement.settle();
    const updatesAfterShutdown = old.ui.widgetUpdates;
    await pollingInterval();
    assert.deepEqual(old.messages, []);
    assert.deepEqual(replacement.messages, []);
    assert.equal(old.ui.widget, undefined);
    assert.equal(old.ui.widgetUpdates, updatesAfterShutdown, "Shutdown must stop polling resources");
    assert.equal(readFileSync(join(directory, `${record.id}.json`), "utf8"), before);
    await assert.rejects(old.execute("machine_attach", { target: record.id }), /closed|shutdown|stale/iu);
    await replacement.execute("machine_attach", { target: record.id });
    await eventually(() => assert.equal(replacement.messages.length, 1));
    assertWake(replacement, record.id, /Human|input|waiting/u);
  });
}

test("delivery rechecks actual session identity even if a context changes before settlement", async context => {
  const directory = publication(context);
  const extension = extensionFor(context);
  await extension.start();
  const record = external();
  writeRunStatusRecord(directory, record);
  await extension.execute("machine_attach", { target: record.id });
  extension.state.idle = false;
  writeRunStatusRecord(directory, { ...record, status: "completed" });
  await pollingInterval();
  extension.state.sessionId = "different-visible-session";
  await extension.settle();
  await pollingInterval();
  assert.deepEqual(extension.messages, [], "A wake registration names its initiating session, not the displayed session");
});

test("the same external event wakes only explicitly registered sessions", async context => {
  const directory = publication(context);
  const registered = extensionFor(context);
  const passive = extensionFor(context);
  await registered.start();
  await passive.start();
  const record = external();
  writeRunStatusRecord(directory, record);
  await passive.execute("machine_watch", { target: record.id });
  await registered.execute("machine_attach", { target: record.id });
  writeRunStatusRecord(directory, { ...record, status: "failed", error: "broken" });
  await eventually(() => assert.equal(registered.messages.length, 1));
  await pollingInterval();
  assertWake(registered, record.id, /fail/iu);
  assert.deepEqual(passive.messages, []);
});

test("attachment commands register and detach model delivery with the same session scope as tools", async context => {
  const directory = publication(context);
  const extension = extensionFor(context);
  await extension.start();
  const record = external();
  writeRunStatusRecord(directory, record);
  const attach = extension.commands.get("machine-attach");
  const detach = extension.commands.get("machine-detach");
  assert.ok(attach, "Explicit attachment must also be available to the Human");
  assert.ok(detach);
  await attach.handler(record.id, extension.context);
  writeRunStatusRecord(directory, { ...record, status: "waiting", human });
  await eventually(() => assert.equal(extension.messages.length, 1));
  await detach.handler(record.id, extension.context);
  writeRunStatusRecord(directory, { ...record, status: "completed" });
  await pollingInterval();
  assert.equal(extension.messages.length, 1);
});

test("wake registration rejects missing session identity and disabled external publication", async context => {
  const extension = extensionFor(context);
  await extension.start();
  await assert.rejects(extension.execute("machine_attach", { target: "wake-ticket" }), /publication.*off|status.*directory/iu);
  publication(context);
  const attach = extension.tools.get("machine_attach");
  assert.ok(attach);
  await assert.rejects(attach.execute("no-session", { target: "wake-ticket" }, undefined, undefined,
    { ...extension.context, sessionManager: undefined }), /session.*id|identity/iu);
  assert.deepEqual(extension.messages, []);
});

test("shutdown during an asynchronous parent start never registers or wakes a late run", async context => {
  const extension = extensionFor(context);
  await extension.start();
  const starting = extension.execute("machine_start", { machine: "wait" });
  await extension.shutdown("resume");
  await assert.rejects(starting, /closed|terminated/u);
  await extension.settle();
  await pollingInterval();
  assert.deepEqual(extension.messages, []);
  assert.equal(extension.ui.widget, undefined);
});

test("Pi guidance documents both registration paths, safe yielding, retrieval, cleanup, and Human authority", () => {
  const read = (path: string) => readFileSync(resolve(path), "utf8");
  const integrations = read("docs/integrations.md");
  for (const term of [/machine_attach/u, /machine_detach/u, /machine_watch/u, /machine_status/u,
    /spawn/iu, /session/iu, /yield/iu, /Human/u, /poll/iu, /closed|running Pi|open session/iu,
    /MACHINES_RUN_STATUS_DIR/u, /same.*directory|shared.*directory/iu]) {
    assert.ok(term.test(integrations), `docs/integrations.md must document ${term}`);
  }
  assert.ok(read("README.md").includes("machine_attach"), "README.md must introduce explicit wake attachment");
  assert.ok(/wake/iu.test(read("docs/architecture.md")), "Architecture must explain wake registration boundaries");
  const delegation = read("skills/machine-delegation/SKILL.md");
  assert.ok(delegation.includes("machine_attach"), "Delegation guidance must explain external wake attachment");
  assert.ok(/yield/iu.test(delegation), "Delegation guidance must explain how to yield safely");
  assert.ok(/Human/u.test(delegation), "Delegation guidance must preserve Human decision authority");
});
