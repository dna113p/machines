import "./environment.ts";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { PiWake, type WakeApi } from "../pi-extension/wake.ts";
import type { RunSnapshot } from "../src/session.ts";
import { startMachineHost, type HostedHumanRequest } from "../src/host.ts";
import { readRunStatuses } from "../src/run-status.ts";

const run: RunSnapshot = {
  id: "owned-run", machine: "example", description: "", path: "/example.ts", cwd: "/",
  startedAt: "2026-10-23T00:00:00.000Z", updatedAt: "2026-10-23T00:00:01.000Z",
  status: "waiting", elapsedSeconds: 1,
  human: { prompt: "Approve?", requestId: "first" },
};

function recording() {
  const state = { idle: false, pending: false, sessionId: "parent" };
  const messages: Array<Parameters<NonNullable<WakeApi["sendMessage"]>>[0]> = [];
  const entries: unknown[] = [];
  const wake = new PiWake({
    sendMessage: message => { messages.push(message); },
    appendEntry: (customType, data) => { entries.push({ type: "custom", customType, data }); },
  }, {
    isIdle: () => state.idle, hasPendingMessages: () => state.pending,
    sessionManager: { getSessionId: () => state.sessionId, getEntries: () => entries },
  });
  wake.registerSpawned(run.id);
  return { wake, state, messages, entries };
}

test("settlement reconciles a queued Human wait answered through the native dialog", () => {
  const { wake, state, messages } = recording();
  wake.refresh([run]);
  state.idle = true;
  wake.refresh([{ ...run, status: "running", human: undefined }], true);
  assert.equal(messages.length, 0);
  wake.refresh([{ ...run, status: "completed", human: undefined }]);
  assert.equal(messages.length, 1);
  assert.match(messages[0]!.content, /completed/u);
});

test("becoming idle before settlement does not release a previously busy event", () => {
  const { wake, state, messages } = recording();
  wake.refresh([run]);
  state.idle = true;
  wake.refresh([run]);
  assert.equal(messages.length, 0);
  wake.detach(run.id);
  wake.refresh([run], true);
  assert.equal(messages.length, 0);
});

test("queued Pi messages defer wakes until a later idle settlement", () => {
  const { wake, state, messages } = recording();
  state.idle = true;
  state.pending = true;
  wake.refresh([run], true);
  assert.equal(messages.length, 0);
  state.pending = false;
  wake.refresh([run], true);
  wake.refresh([run], true);
  assert.equal(messages.length, 1);
});

test("registered terminal snapshots outlive session eviction and are released on detach or close", () => {
  const { wake, state, messages } = recording();
  const terminal: RunSnapshot[] = Array.from({ length: 7 }, (_, index) => ({
    ...run, id: `terminal-${index}`, human: undefined,
    status: index % 2 === 0 ? "completed" : "failed",
  }));
  for (const [index, snapshot] of terminal.entries()) {
    wake.registerSpawned(snapshot.id);
    wake.refresh(terminal.slice(Math.max(0, index - 4), index + 1));
  }
  state.idle = true;
  wake.refresh([], true);
  assert.equal(messages.length, terminal.length);
  assert.deepEqual(wake.retained(), terminal);
  wake.detach(terminal[0]!.id);
  assert.deepEqual(wake.retained(), terminal.slice(1));
  wake.close();
  assert.deepEqual(wake.retained(), []);
  assert.equal(wake.hasPending, false);
});

test("explicit attachment can renew delivery for a detached owned run without registering it as spawned again", () => {
  const { wake, state, messages } = recording();
  wake.detach(run.id);
  state.idle = true;
  wake.refresh([run], true);
  assert.equal(messages.length, 0);
  wake.attach(run.id, "/unused-publication");
  wake.refresh([run], true);
  assert.equal(messages.length, 1);
});

test("a mismatched session permanently invalidates the registration even if the displayed id returns", () => {
  const { wake, state, messages } = recording();
  wake.refresh([run]);
  state.sessionId = "replacement";
  state.idle = true;
  wake.refresh([run], true);
  state.sessionId = "parent";
  wake.refresh([run], true);
  assert.equal(messages.length, 0);
  assert.throws(() => wake.attach(run.id, "/unused-publication"), /closed|stale/u);
});

test("hosted Human observation identities are stable and distinct without publishing response ids", async context => {
  const directory = mkdtempSync(join(tmpdir(), "pi-host-events-"));
  const previous = process.env.MACHINES_RUN_STATUS_DIR;
  process.env.MACHINES_RUN_STATUS_DIR = directory;
  context.after(() => {
    if (previous === undefined) delete process.env.MACHINES_RUN_STATUS_DIR;
    else process.env.MACHINES_RUN_STATUS_DIR = previous;
    rmSync(directory, { force: true, recursive: true });
  });
  let request: HostedHumanRequest | undefined;
  const hosted = await startMachineHost({
    machine: resolve("tests/fixtures/host-sequential.machine.ts"), publishRunStatus: true,
    onHumanRequest: next => { request = next; },
  });
  context.after(() => hosted.terminate());
  const waitForRequest = async (after?: string) => {
    const deadline = Date.now() + 4_000;
    while (request === undefined || request.requestId === after) {
      assert.ok(Date.now() < deadline, "Host never reached its next Human request");
      await new Promise<void>(done => setTimeout(done, 10));
    }
    return request;
  };
  const first = await waitForRequest();
  const record = readRunStatuses(directory)[0]!;
  assert.equal(record.answeredBy, "host");
  assert.equal(record.human?.requestId, undefined);
  assert.match(record.humanEventId!, /^[0-9a-f-]{36}$/u);
  assert.notEqual(record.humanEventId, first.requestId);
  assert.equal(readRunStatuses(directory)[0]!.humanEventId, record.humanEventId);
  await hosted.respond("yes", first.requestId);
  const second = await waitForRequest(first.requestId);
  const next = readRunStatuses(directory)[0]!;
  assert.equal(next.human?.prompt, record.human?.prompt);
  assert.notEqual(next.humanEventId, record.humanEventId);
  assert.equal(next.human?.requestId, undefined);
  await hosted.respond("yes", second.requestId);
  await hosted.result;
  assert.equal(readRunStatuses(directory)[0]!.humanEventId, undefined);
});
