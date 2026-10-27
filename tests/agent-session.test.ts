import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { createLimitMemory, limitAwareRunner } from "../src/agent-limits.ts";
import { claudeAgent } from "../src/claude.ts";
import { codexAgent } from "../src/codex.ts";
import { createRunStatusPublisher, readRunStatuses, runStatusObserver } from "../src/run-status.ts";
import {
  agent,
  final,
  machine,
  operation,
  run,
  AgentLimitError,
  type AgentRequest,
  type AgentRunner,
  type AgentUpdate,
  type StateEntry,
} from "../src/index.ts";

const cwd = process.cwd();
const fakeClaude = resolve("tests/fixtures/fake-claude-agent.mjs");
const fakeCodex = resolve("tests/fixtures/fake-codex-agent.mjs");

/** A Machine that implements, fails its check once, and repairs in the same named session. */
function repairLoop(options: { session?: string; fallback?: string; reaskRepair?: 0 | 1 } = {}) {
  let checks = 0;
  return machine({
    initial: "implement",
    states: {
      implement: agent("Implement the ticket", { completed: "check" },
        { using: "implementer", cwd, ...(options.session === undefined ? {} : { session: options.session }) }),
      check: operation(() => ({ type: (checks += 1) === 1 ? "failed" : "passed" }), { failed: "repair", passed: "done" }),
      repair: agent("Implement the ticket\n\nThe checks failed: lint", { completed: "check" }, {
        using: "implementer", cwd,
        ...(options.session === undefined ? {} : { session: options.session, followUp: "The checks failed: lint" }),
        ...(options.fallback === undefined ? {} : { fallback: options.fallback, reask: options.reaskRepair ?? 1 }),
      }),
      done: final(),
    },
  });
}

/** A runner that keeps one numbered session per fresh call and records what it was asked. */
function sessionRunner(requests: AgentRequest[], prefix = "native") {
  let created = 0;
  const runner: AgentRunner = async (request, report) => {
    requests.push(request);
    if (request.session !== undefined) {
      const resume = request.session.resume;
      report?.(resume === undefined
        ? { type: "session", status: "fresh", id: `${prefix}-${created += 1}` }
        : { type: "session", status: "continued", id: resume.id });
    }
    return { type: "completed" };
  };
  return runner;
}

const sessionUpdates = (updates: AgentUpdate[]) =>
  updates.filter((update): update is Extract<AgentUpdate, { type: "session" }> => update.type === "session");

test("a later call naming the session continues the native session with its follow-up prompt", async () => {
  const requests: AgentRequest[] = [];
  const updates: AgentUpdate[] = [];
  const entries: StateEntry[] = [];
  await run(repairLoop({ session: "work" }), {
    agents: { implementer: sessionRunner(requests) },
    onAgentUpdate: (update) => updates.push(update),
    onEnter: (entry) => entries.push(entry),
  });

  assert.deepEqual(requests[0]?.session, {});
  assert.equal(requests[0]?.prompt, "Implement the ticket");
  // The full prompt stays complete for a runner that cannot resume.
  assert.equal(requests[1]?.prompt, "Implement the ticket\n\nThe checks failed: lint");
  assert.deepEqual(requests[1]?.session, { resume: { id: "native-1", prompt: "The checks failed: lint" } });
  assert.deepEqual(sessionUpdates(updates), [
    { type: "session", name: "work", status: "fresh", id: "native-1", reason: "no earlier call in this run kept it",
      text: 'Agent session "work" started fresh as native-1 with implementer: no earlier call in this run kept it' },
    { type: "session", name: "work", status: "continued", id: "native-1",
      text: 'Agent session "work" continued native-1 with implementer' },
  ]);
  // Checkpoints carry the record, so a continued run can resume it.
  assert.deepEqual(entries.find((entry) => entry.value === "check")?.history?.sessions,
    [{ name: "work", id: "native-1", role: "implementer", cwd }]);
});

test("workflows that name no session ask for none and record none", async () => {
  const requests: AgentRequest[] = [];
  const updates: AgentUpdate[] = [];
  const entries: StateEntry[] = [];
  await run(repairLoop(), {
    agents: { implementer: sessionRunner(requests) },
    onAgentUpdate: (update) => updates.push(update),
    onEnter: (entry) => entries.push(entry),
  });
  assert.equal(requests.length, 2);
  assert.ok(requests.every((request) => !("session" in request)));
  assert.deepEqual(sessionUpdates(updates), []);
  assert.ok(entries.every((entry) => entry.history?.sessions === undefined));
});

test("a runner that keeps no session runs every call fresh with the full prompt", async () => {
  const prompts: string[] = [];
  const updates: AgentUpdate[] = [];
  await run(repairLoop({ session: "work" }), {
    agents: { implementer: async (request) => { prompts.push(request.prompt); return { type: "completed" }; } },
    onAgentUpdate: (update) => updates.push(update),
  });
  assert.deepEqual(prompts, ["Implement the ticket", "Implement the ticket\n\nThe checks failed: lint"]);
  assert.deepEqual(sessionUpdates(updates).map((update) => [update.status, update.reason]), [
    ["fresh", "the runner keeps no session it can continue"],
    ["fresh", "the runner keeps no session it can continue"],
  ]);
});

test("a fallback role does not continue the primary role's session", async () => {
  const requests: AgentRequest[] = [];
  const updates: AgentUpdate[] = [];
  let repairs = 0;
  const implementer: AgentRunner = async (request, report) => {
    if (request.session?.resume !== undefined && (repairs += 1) > 0) throw new Error("no outcome");
    return sessionRunner([])(request, report);
  };
  await run(repairLoop({ session: "work", fallback: "rescuer", reaskRepair: 0 }), {
    agents: { implementer, rescuer: sessionRunner(requests, "rescue") },
    onAgentUpdate: (update) => updates.push(update),
  });
  // The rescuer gets the full prompt and the recovery note, and no session to resume.
  assert.deepEqual(requests[0]?.session, {});
  assert.match(requests[0]?.prompt ?? "", /^Implement the ticket\n\nThe checks failed: lint\n\nThe last attempt returned no outcome/u);
  const sessions = sessionUpdates(updates);
  assert.deepEqual([sessions[1]?.status, sessions[1]?.reason], ["fresh", "the call failed before its runner reported a session"]);
  assert.equal(sessions[2]?.status, "fresh");
  assert.equal(sessions[2]?.reason, 'role "implementer" answered the earlier call, and role "rescuer" answers this one');
});

test("a fallback role that keeps no session leaves nothing for the next call to continue", async () => {
  const requests: AgentRequest[] = [];
  const updates: AgentUpdate[] = [];
  let checks = 0;
  let calls = 0;
  const implementer: AgentRunner = async (request, report) => {
    // The first repair keeps nothing: the rescuer answers it without a session.
    if ((calls += 1) === 2) throw new Error("no outcome");
    return sessionRunner(requests)(request, report);
  };
  await run(machine({
    initial: "implement",
    states: {
      implement: agent("Implement", { completed: "check" }, { using: "implementer", cwd, session: "work" }),
      check: operation(() => ({ type: (checks += 1) < 3 ? "failed" : "passed" }), { failed: "repair", passed: "done" }),
      repair: agent("Implement\n\nRepair", { completed: "check" },
        { using: "implementer", fallback: "rescuer", reask: 0, cwd, session: "work", followUp: "Repair" }),
      done: final(),
    },
  }), {
    agents: { implementer, rescuer: async () => ({ type: "completed" }) },
    onAgentUpdate: (update) => updates.push(update),
  });

  // The third call runs the full prompt fresh: the original session lacks the rescuer's work.
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1]?.session, {});
  assert.equal(requests[1]?.prompt, "Implement\n\nRepair");
  assert.deepEqual(sessionUpdates(updates).map((update) => [update.status, update.reason]), [
    ["fresh", "no earlier call in this run kept it"],
    ["fresh", "the call failed before its runner reported a session"],
    ["fresh", "the runner keeps no session it can continue"],
    ["fresh", 'role "rescuer" answered the latest earlier call and kept no session'],
  ]);
});

test("a fallback preset that answers without a session reports fresh after the limited preset continued", async () => {
  const updates: AgentUpdate[] = [];
  const requests: AgentRequest[] = [];
  let checks = 0;
  let opusCalls = 0;
  const opus: AgentRunner = async (request, report) => {
    requests.push(request);
    const resume = request.session?.resume;
    report?.(resume === undefined ? { type: "session", status: "fresh", id: "opus-1" } : { type: "session", status: "continued", id: resume.id });
    if ((opusCalls += 1) === 2) throw new AgentLimitError("limit", { harness: "claude", kind: "five_hour", resetsAt: Date.now() + 3_600_000 });
    return { type: "completed" };
  };
  const runner = limitAwareRunner("implementer", [
    { name: "opus", harness: "claude", runner: opus },
    { name: "acp", harness: "acp", runner: async () => ({ type: "completed" }) },
  ], createLimitMemory(), { maxWaitMs: 0, probeMs: 60_000 });
  await run(machine({
    initial: "implement",
    states: {
      implement: agent("Implement", { completed: "check" }, { using: "implementer", cwd, session: "work" }),
      check: operation(() => ({ type: (checks += 1) < 3 ? "failed" : "passed" }), { failed: "repair", passed: "done" }),
      repair: agent("Implement\n\nRepair", { completed: "check" },
        { using: "implementer", cwd, session: "work", followUp: "Repair" }),
      done: final(),
    },
  }), { agents: { implementer: runner }, onAgentUpdate: (update) => updates.push(update) });

  const sessions = sessionUpdates(updates).map(({ status, agent, reason }) => [status, agent, reason]);
  assert.deepEqual(sessions, [
    ["fresh", "opus", "no earlier call in this run kept it"],
    // The limited preset continued; the preset that answered says it started fresh.
    ["continued", "opus", undefined],
    ["fresh", "acp", "the runner keeps no session it can continue"],
    ["fresh", "acp", "the runner keeps no session it can continue"],
  ]);
  // The limit is remembered, so the third call goes to acp; opus was asked twice.
  assert.equal(requests.length, 2);
});

test("a re-ask continues the session its failed attempt kept, with the recovery note", async () => {
  const requests: AgentRequest[] = [];
  let calls = 0;
  const runner: AgentRunner = async (request, report) => {
    requests.push(request);
    report?.({ type: "session", status: request.session?.resume ? "continued" : "fresh", id: request.session?.resume?.id ?? "kept" });
    if ((calls += 1) === 1) throw new Error("no event");
    return { type: "completed" };
  };
  await run(machine({
    initial: "work",
    states: { work: agent("Do it", { completed: "done" }, { cwd, session: "s" }), done: final() },
  }), { agents: { default: runner } });
  assert.deepEqual(requests[1]?.session?.resume?.id, "kept");
  assert.match(requests[1]?.session?.resume?.prompt ?? "", /^Do it\n\nThe last attempt returned no outcome: no event\./u);
});

test("a continued run resumes the session its checkpoint holds, and starts fresh when it holds none", async () => {
  const definition = () => machine({
    initial: "repair",
    states: {
      repair: agent("Full prompt", { completed: "done" }, { using: "implementer", cwd, session: "work", followUp: "Next" }),
      done: final(),
    },
  });
  const saved = [{ name: "work", id: "native-7", role: "implementer", cwd }];
  const requests: AgentRequest[] = [];
  await run(definition(), {
    agents: { implementer: sessionRunner(requests) },
    continueAt: { value: "repair", context: undefined, history: { trail: ["repair"], summaries: [], sessions: saved } },
  });
  assert.deepEqual(requests[0]?.session, { resume: { id: "native-7", prompt: "Next" } });

  const updates: AgentUpdate[] = [];
  const fresh: AgentRequest[] = [];
  await run(definition(), {
    agents: { implementer: sessionRunner(fresh) },
    // A checkpoint written before sessions existed, and one whose record is malformed.
    continueAt: { value: "repair", context: undefined, history: { trail: ["repair"], summaries: [],
      sessions: [{ name: "work", id: 7 }] as never } },
    onAgentUpdate: (update) => updates.push(update),
  });
  assert.deepEqual(fresh[0]?.session, {});
  assert.equal(fresh[0]?.prompt, "Full prompt");
  assert.equal(sessionUpdates(updates)[0]?.reason, "the run continued from a checkpoint that holds no such session");
});

test("a different working directory starts fresh", async () => {
  const requests: AgentRequest[] = [];
  const updates: AgentUpdate[] = [];
  await run(machine({
    initial: "repair",
    states: {
      repair: agent("Full", { completed: "done" }, { using: "implementer", cwd: "/elsewhere", session: "work" }),
      done: final(),
    },
  }), {
    agents: { implementer: sessionRunner(requests) },
    continueAt: { value: "repair", context: undefined,
      history: { trail: [], summaries: [], sessions: [{ name: "work", id: "native-7", role: "implementer", cwd }] } },
    onAgentUpdate: (update) => updates.push(update),
  });
  assert.deepEqual(requests[0]?.session, {});
  assert.match(sessionUpdates(updates)[0]?.reason ?? "", /^the earlier call worked in .+, and this one in \/elsewhere$/u);
});

test("Agent session options are validated", () => {
  assert.throws(() => agent("x", { done: "y" }, { session: " work" }), /session must be a non-empty trimmed name/u);
  assert.throws(() => agent("x", { done: "y" }, { followUp: "next" }), /followUp .* requires session/u);
});

test("a preset other than the one that kept the session starts fresh, and reports name their preset", async () => {
  const seen: Array<[string, AgentRequest]> = [];
  const candidate = (name: string, limited = false): { name: string; runner: AgentRunner; harness: string } => ({
    name, harness: name,
    runner: async (request, report) => {
      seen.push([name, request]);
      report?.({ type: "session", status: request.session?.resume ? "continued" : "fresh", id: `${name}-session` });
      if (limited) throw new AgentLimitError("limit", { harness: name, kind: "five_hour", resetsAt: Date.now() + 3_600_000 });
      return { type: "completed" };
    },
  });
  const updates: AgentUpdate[] = [];
  const runner = limitAwareRunner("implementer", [candidate("opus", true), candidate("codex")], createLimitMemory(),
    { maxWaitMs: 0, probeMs: 60_000 });
  await runner({ prompt: "Full", outcomes: ["completed"], cwd,
    session: { resume: { id: "opus-session", prompt: "Next", agent: "opus" } } }, (update) => updates.push(update));

  // The preset that kept it is asked to resume; the fallback runs the full prompt fresh, with the handoff note.
  assert.deepEqual(seen[0]?.[1].session, { resume: { id: "opus-session", prompt: "Next", agent: "opus" } });
  assert.equal(seen[1]?.[0], "codex");
  assert.deepEqual(seen[1]?.[1].session, {});
  assert.match(seen[1]?.[1].prompt ?? "", /^Full\n\nNote: a previous Agent/u);
  assert.deepEqual(sessionUpdates(updates), [
    { type: "session", status: "continued", id: "opus-session", agent: "opus" },
    { type: "session", status: "fresh", id: "codex-session", agent: "codex",
      reason: "preset opus answered the earlier call, and codex answers this one" },
  ]);
});

test("the Claude Code runner keeps, resumes, and replaces a missing session", async () => {
  const runner = claudeAgent(process.execPath, [fakeClaude, "session"], { output: "capture" });
  const base = { prompt: "Full prompt", outcomes: ["completed"], cwd };

  const updates: AgentUpdate[] = [];
  const fresh = await runner({ ...base, session: {} }, (update) => updates.push(update));
  assert.equal(fresh.resumed, null);
  assert.equal(fresh.persisted, true);
  assert.equal(fresh.prompt, "Full prompt");
  assert.match(String(fresh.chosen), /^[0-9a-f-]{36}$/u);
  assert.deepEqual(sessionUpdates(updates), [{ type: "session", status: "fresh", id: fresh.chosen }]);

  const resumedUpdates: AgentUpdate[] = [];
  const resumed = await runner({ ...base, session: { resume: { id: "abc", prompt: "Follow-up" } } },
    (update) => resumedUpdates.push(update));
  assert.equal(resumed.resumed, "abc");
  assert.equal(resumed.prompt, "Follow-up");
  assert.deepEqual(sessionUpdates(resumedUpdates), [{ type: "session", status: "continued", id: "abc" }]);

  const missingUpdates: AgentUpdate[] = [];
  const replaced = await runner({ ...base, session: { resume: { id: "missing-1", prompt: "Follow-up" } } },
    (update) => missingUpdates.push(update));
  assert.equal(replaced.resumed, null);
  assert.equal(replaced.prompt, "Full prompt");
  assert.deepEqual(sessionUpdates(missingUpdates), [{ type: "session", status: "fresh", id: replaced.chosen,
    reason: "session missing-1 could not be resumed: No conversation found with session ID: missing-1" }]);

  // Without a session, or with persistence off, nothing is saved or reported.
  const plain: AgentUpdate[] = [];
  assert.equal((await runner(base, (update) => plain.push(update))).persisted, false);
  const off = claudeAgent(process.execPath, [fakeClaude, "session"], { output: "capture", sessionPersistence: false });
  const offEvent = await off({ ...base, session: { resume: { id: "abc", prompt: "Follow-up" } } }, (update) => plain.push(update));
  assert.deepEqual([offEvent.persisted, offEvent.resumed, offEvent.prompt], [false, null, "Full prompt"]);
  assert.deepEqual(sessionUpdates(plain), []);
});

test("a usage limit while resuming a Claude session is reported as a limit, not a missing session", async () => {
  const runner = claudeAgent(process.execPath, [fakeClaude, "session-limit"], { output: "capture" });
  await assert.rejects(
    async () => runner({ prompt: "Full", outcomes: ["completed"], cwd, session: { resume: { id: "abc", prompt: "Next" } } }),
    (cause: unknown) => cause instanceof AgentLimitError);
});

test("the Codex runner keeps, resumes, and replaces a missing session", async () => {
  const runner = codexAgent(process.execPath, [fakeCodex, "session"], { output: "capture" });
  const base = { prompt: "Full prompt", outcomes: ["completed"], cwd };

  const updates: AgentUpdate[] = [];
  const fresh = await runner({ ...base, session: {} }, (update) => updates.push(update));
  assert.deepEqual([fresh.resumed, fresh.ephemeral, fresh.prompt], [null, false, "Full prompt"]);
  assert.deepEqual(sessionUpdates(updates), [{ type: "session", status: "fresh", id: "thread-new" }]);

  const resumed = await codexAgent(process.execPath, [fakeCodex, "arguments"], { output: "capture" })(
    { ...base, session: { resume: { id: "thread-1", prompt: "Follow-up" } } });
  // Execution options stay on `exec`; `resume` names the session before the stdin prompt.
  assert.deepEqual((resumed.args as string[]).slice(-3), ["resume", "thread-1", "-"]);
  assert.ok((resumed.args as string[]).includes("--sandbox"));
  assert.ok(String(resumed.prompt).startsWith("Follow-up"));

  const missingUpdates: AgentUpdate[] = [];
  const replaced = await runner({ ...base, session: { resume: { id: "missing-1", prompt: "Follow-up" } } },
    (update) => missingUpdates.push(update));
  assert.deepEqual([replaced.resumed, replaced.prompt], [null, "Full prompt"]);
  assert.deepEqual(sessionUpdates(missingUpdates), [{ type: "session", status: "fresh", id: "thread-new",
    reason: "session missing-1 could not be resumed: Error: thread/resume: thread/resume failed: no rollout found for thread id missing-1 (code -32600)" }]);

  const plain: AgentUpdate[] = [];
  assert.equal((await runner(base, (update) => plain.push(update))).ephemeral, true);
  const ephemeral = codexAgent(process.execPath, [fakeCodex, "session"], { output: "capture", ephemeral: true });
  const kept = await ephemeral({ ...base, session: { resume: { id: "thread-1", prompt: "Follow-up" } } }, (update) => plain.push(update));
  assert.deepEqual([kept.ephemeral, kept.resumed, kept.prompt], [true, null, "Full prompt"]);
  assert.deepEqual(sessionUpdates(plain), []);
});

test("a Machine loop continues a real runner's session end to end", async () => {
  const updates: AgentUpdate[] = [];
  await run(repairLoop({ session: "work" }), {
    agents: { implementer: claudeAgent(process.execPath, [fakeClaude, "session"], { output: "capture" }) },
    onAgentUpdate: (update) => updates.push(update),
  });
  const [first, second] = sessionUpdates(updates);
  assert.equal(first?.status, "fresh");
  assert.deepEqual([second?.status, second?.id], ["continued", first?.id]);
});

test("run status publishes the current Agent state's session evidence and drops it on leaving", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "machines-session-status-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const publisher = createRunStatusPublisher({ machine: "ticket", path: "/work/ticket.ts", cwd: "/work", id: "session-status" },
    { MACHINES_RUN_STATUS_DIR: directory });
  const observer = runStatusObserver((change) => publisher.update(change));
  observer.onState("repair");
  observer.onAgentUpdate({ type: "session", status: "continued", id: "native-1" });
  assert.equal(readRunStatuses(directory)[0]?.session, undefined);
  observer.onAgentUpdate({ type: "session", name: "work", status: "fresh", id: "native-2", reason: "the session is gone",
    text: 'Agent session "work" started fresh as native-2 with implementer: the session is gone' });
  assert.deepEqual(readRunStatuses(directory)[0]?.session, { name: "work", status: "fresh", reason: "the session is gone",
    text: 'Agent session "work" started fresh as native-2 with implementer: the session is gone' });

  const file = join(directory, "session-status.json");
  const saved = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  await writeFile(file, JSON.stringify({ ...saved, session: { name: "work", status: "resumed", text: "x" } }));
  assert.deepEqual(readRunStatuses(directory), []);
  await writeFile(file, JSON.stringify(saved));

  observer.onState("check");
  assert.equal(readRunStatuses(directory)[0]?.session, undefined);
});
