import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { resolve, join } from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { test } from "node:test";

import { startMachineHost, type HostedHumanRequest } from "../src/host.ts";

const fixture = resolve("tests/fixtures/host.machine.ts");

test("a host starts one Machine, reports state, and accepts Human input", async () => {
  const states: unknown[] = [];
  const human = deferred<HostedHumanRequest>();
  const hosted = await startMachineHost({
    machine: fixture,
    onState: (state) => states.push(state),
    onHumanRequest: human.resolve,
  });
  assert.deepEqual(states, []);
  const request = await human.promise;

  await assert.rejects(hosted.respond("other", request.requestId), /Expected one of: approve, deny/u);
  await hosted.respond("approve", request.requestId);
  assert.deepEqual(await hosted.result, { state: "done" });
  assert.equal(hosted.name, "host.machine");
  assert.equal(hosted.description, "Exercises one hosted Machine run.");
  assert.equal(typeof request.requestId, "string");
  assert.deepEqual(request, {
    requestId: request.requestId,
    prompt: "Approve the hosted run \"default\"?",
    choices: ["approve", "deny"],
  });
  assert.deepEqual(states, ["work", "review", "done"]);
  await assert.rejects(
    hosted.respond("approve", request.requestId),
    /Machine host is not waiting for Human input/u,
  );
});

test("two hosts keep concurrent Human requests separate", async () => {
  const firstHuman = deferred<HostedHumanRequest>();
  const secondHuman = deferred<HostedHumanRequest>();
  const [first, second] = await Promise.all([
    startMachineHost({
      machine: fixture,
      input: "first",
      onHumanRequest: firstHuman.resolve,
    }),
    startMachineHost({
      machine: fixture,
      input: "second",
      onHumanRequest: secondHuman.resolve,
    }),
  ]);

  const firstRequest = await firstHuman.promise;
  const secondRequest = await secondHuman.promise;
  assert.equal(firstRequest.prompt, "Approve the hosted run \"first\"?");
  assert.equal(secondRequest.prompt, "Approve the hosted run \"second\"?");
  await Promise.all([first.respond("approve", firstRequest.requestId), second.respond("deny", secondRequest.requestId)]);
  assert.deepEqual(await Promise.all([first.result, second.result]), [
    { state: "done" },
    { state: "done" },
  ]);
});

test("a host reports harness-neutral Agent updates", async () => {
  const updates: unknown[] = [];
  const project = resolve("tests/fixtures/host-agent");
  const hosted = await startMachineHost({
    cwd: project,
    home: resolve("tests/fixtures/empty-home"),
    machine: "agent",
    onAgentUpdate: (update) => updates.push(update),
  });

  assert.deepEqual(await hosted.result, { state: "done" });
  assert.deepEqual(updates, [
    {
      type: "identity",
      harness: "fixture",
      model: "tiny",
      thinking: "low",
    },
    {
      type: "tool",
      id: "tool-1",
      title: "Fixture tool",
      status: "completed",
    },
  ]);
});

test("a hosted Machine reports execution failure", async () => {
  const hosted = await startMachineHost({ machine: fixture, input: "fail" });

  await assert.rejects(
    hosted.result,
    /Operation failed in state "work": host fixture failed/u,
  );
});

test("an owned host can be terminated while it waits", async () => {
  const human = deferred<HostedHumanRequest>();
  const hosted = await startMachineHost({
    machine: fixture,
    onHumanRequest: human.resolve,
  });
  await human.promise;

  hosted.terminate();
  await assert.rejects(hosted.result, /Machine host was terminated/u);
});

test("an unexpected host exit is distinct from a Machine failure", async () => {
  const hosted = await startMachineHost({ machine: fixture, input: "exit" });

  await assert.rejects(
    hosted.result,
    /Machine host exited before completion \(code 17\)/u,
  );
});

test("a host rejects invalid launch input before returning a run", async () => {
  await assert.rejects(
    startMachineHost({ machine: "tests/fixtures/missing.machine.ts" }),
    /Could not load Machine/u,
  );
});

function deferred<T>() {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

test("only one concurrent answer can claim a Human request", async (context) => {
  const human = deferred<HostedHumanRequest>();
  const hosted = await startMachineHost({ machine: fixture, onHumanRequest: human.resolve });
  context.after(() => hosted.terminate());
  const request = await human.promise;
  const answers = await Promise.allSettled([hosted.respond("approve", request.requestId), hosted.respond("deny", request.requestId)]);
  assert.equal(answers.filter((answer) => answer.status === "fulfilled").length, 1);
  assert.deepEqual(await hosted.result, { state: "done" });
});

for (const disposition of ["terminate", "complete"] as const) {
  test(`a host disposes its subprocess tree on ${disposition}`, async (context) => {
    const directory = await mkdtemp(join(tmpdir(), "machine-process-"));
    context.after(() => rm(directory, { recursive: true, force: true }));
    const pidFile = join(directory, "child.pid");
    const human = deferred<HostedHumanRequest>();
    const hosted = await startMachineHost({
      machine: resolve("tests/fixtures/host-process.machine.ts"),
      input: pidFile,
      onHumanRequest: human.resolve,
    });
    context.after(() => hosted.terminate());
    const request = await human.promise;
    const pid = Number(await readFile(pidFile, "utf8"));
    context.after(() => { try { process.kill(pid, "SIGKILL"); } catch {} });
    assert.equal(await processRunning(pid), true);
    if (disposition === "terminate") {
      hosted.terminate();
      await assert.rejects(hosted.result, /terminated/u);
    } else {
      await hosted.respond("finish", request.requestId);
      await hosted.result;
    }
    await eventually(async () => assert.equal(await processRunning(pid), false));
  });
}

async function processRunning(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    if (process.platform === "linux") {
      // A killed grandchild can briefly await reaping by the OS as a zombie.
      const stat = await readFile(`/proc/${pid}/stat`, "utf8");
      return !["Z", "X"].includes(stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3));
    }
    return true;
  } catch (cause) {
    if (["ESRCH", "ENOENT"].includes((cause as NodeJS.ErrnoException).code ?? "")) return false;
    throw cause;
  }
}

async function eventually(assertion: () => Promise<void>): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (true) {
    try { await assertion(); return; } catch (cause) {
      if (Date.now() >= deadline) throw cause;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

test("an abrupt parent exit disposes the host and its descendants", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "machine-parent-exit-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const pidFile = join(directory, "child.pid");
  const parent = fork(resolve("tests/fixtures/host-parent.ts"), [pidFile], {
    execArgv: [],
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  context.after(() => parent.kill("SIGKILL"));
  await once(parent, "message");
  const pid = Number(await readFile(pidFile, "utf8"));
  context.after(() => { try { process.kill(pid, "SIGKILL"); } catch {} });
  assert.equal(await processRunning(pid), true);
  parent.kill("SIGKILL");
  await once(parent, "exit");
  await eventually(async () => assert.equal(await processRunning(pid), false));
});

test("startup cancellation owns processes before preflight returns", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "machine-startup-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const cancellation = new AbortController();
  const started = startMachineHost({
    cwd: directory,
    machine: resolve("tests/fixtures/host-startup.machine.ts"),
    signal: cancellation.signal,
  });
  const rejected = assert.rejects(started, /terminated/u);
  context.after(() => cancellation.abort());
  let pid = 0;
  await eventually(async () => {
    pid = Number(await readFile(join(directory, "child.pid"), "utf8"));
    assert.equal(await processRunning(pid), true);
  });
  context.after(() => { try { process.kill(pid, "SIGKILL"); } catch {} });
  cancellation.abort();
  await rejected;
  await eventually(async () => assert.equal(await processRunning(pid), false));
});
