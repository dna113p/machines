// The Machines the sleep tests run, written into each test's own project.

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const runtime = JSON.stringify(pathToFileURL(resolve("src/index.ts")).href);

/**
 * Rests in a timed wait, then a check Operation logs and counts. It goes back
 * to rest until it has made `input.checks` checks, then finishes.
 */
export const sleeperSource = `import { appendFileSync } from "node:fs";

export const description = "Rests in a timed wait between checks.";

export default function sleeper(p, input) {
  const saved = p.data({ checks: 0 });
  return p.machine({
    initial: "rest",
    states: {
      rest: p.wait({ every: input.every }, { due: "check" }),
      check: p.operation(() => {
        saved.checks += 1;
        appendFileSync(input.log, "check " + saved.checks + "\\n");
        return { type: saved.checks >= input.checks ? "enough" : "again" };
      }, { again: "rest", enough: "finished" }),
      finished: p.final(),
    },
  });
}
`;

export const askerPrompt = "Ship the release now?";

/**
 * Asks a person to approve or deny, allowing discussion, then logs the answer
 * in an Operation and finishes.
 */
export const askerSource = `import { appendFileSync } from "node:fs";

export const description = "Asks a person, then logs the answer.";

export default function asker(p, input) {
  const saved = p.data({ answer: "" });
  return p.machine({
    initial: "ask",
    states: {
      ask: p.human(${JSON.stringify(askerPrompt)}, {
        submitted: { target: "record", actions: ({ event }) => { saved.answer = event.value; } },
        question: "ask",
      }, { choices: ["approve", "deny"], discussion: true }),
      record: p.operation(() => {
        appendFileSync(input.log, "answer " + saved.answer + "\\n");
        return { type: "done" };
      }, { done: "finished" }),
      finished: p.final(),
    },
  });
}
`;

/**
 * Pushes, logging each call, and fails until call `input.passAt`. A failed
 * push is retried `input.times` more times, `input.wait` apart. The calls are
 * counted from the log, so the count does not rely on saved data.
 */
export const retrierSource = `import { appendFileSync, existsSync, readFileSync } from "node:fs";

export const description = "Retries a push that fails for a while.";

export default function retrier(p, input) {
  return p.machine({
    initial: "push",
    states: {
      push: p.operation(() => {
        const calls = (existsSync(input.log) ? readFileSync(input.log, "utf8").split("\\n").filter(Boolean).length : 0) + 1;
        appendFileSync(input.log, "call " + calls + "\\n");
        return { type: calls >= input.passAt ? "pushed" : "failed" };
      }, { pushed: "merged", failed: "askPush" }, { retry: { on: "failed", times: input.times, wait: input.wait } }),
      merged: p.final(),
      askPush: p.final(),
    },
  });
}
`;

/**
 * A child that notes a nap in its data, rests in a timed wait, then logs its
 * data and ends `rested` or `restless`, chosen by `input.outcome`.
 */
export const napperSource = `import { appendFileSync } from "node:fs";
import { defineEndings, Type } from ${runtime};

export const description = "Notes a nap, rests in a timed wait, then ends rested or restless.";

export const endings = defineEndings({
  rested: { kind: "succeeded", output: Type.Object({ naps: Type.Number() }) },
  restless: { kind: "failed", output: Type.Object({ naps: Type.Number() }) },
});

export default function napper(p, input) {
  const saved = p.data({ naps: 0, note: "" });
  return p.machine({
    initial: "start",
    output: () => ({ naps: saved.naps }),
    states: {
      start: p.operation(() => {
        saved.naps += 1;
        saved.note = "child before";
        appendFileSync(input.log, "child start\\n");
        return { type: "done" };
      }, { done: "rest" }),
      rest: p.wait({ every: input.every }, { due: "wake" }),
      wake: p.operation(() => {
        appendFileSync(input.log, "child wake " + JSON.stringify(saved) + "\\n");
        return { type: input.outcome };
      }, { rested: "rested", restless: "restless" }),
      rested: p.final(endings.rested),
      restless: p.final(endings.restless),
    },
  });
}
`;

export const approverPrompt = "Approve the child's release?";

/**
 * A child that notes its start in its data, asks a person to approve or deny,
 * then logs its data and ends `approved` or `denied` on the answer.
 */
export const approverSource = `import { appendFileSync } from "node:fs";
import { defineEndings, Type } from ${runtime};

export const description = "Asks a person to approve, then ends approved or denied.";

export const endings = defineEndings({
  approved: { kind: "succeeded", output: Type.Object({ answer: Type.String() }) },
  denied: { kind: "failed", output: Type.Object({ answer: Type.String() }) },
});

export default function approver(p, input) {
  const saved = p.data({ answer: "", note: "" });
  return p.machine({
    initial: "start",
    output: () => ({ answer: saved.answer }),
    states: {
      start: p.operation(() => {
        saved.note = "child before";
        appendFileSync(input.log, "child start\\n");
        return { type: "done" };
      }, { done: "ask" }),
      ask: p.human(${JSON.stringify(approverPrompt)}, {
        submitted: { target: "record", actions: ({ event }) => { saved.answer = event.value; } },
      }, { choices: ["approve", "deny"] }),
      record: p.operation(() => {
        appendFileSync(input.log, "child answer " + JSON.stringify(saved) + "\\n");
        return { type: saved.answer === "approve" ? "yes" : "no" };
      }, { yes: "approved", no: "denied" }),
      approved: p.final(endings.approved),
      denied: p.final(endings.denied),
    },
  });
}
`;

/**
 * A middle Machine that counts its start in its data, runs `selector` with its
 * own input, then logs its data and ends `passed` on the child's `ok` ending
 * or `stopped` on its `bad` ending.
 */
export function relaySource(selector: string, ok: string, bad: string): string {
  return `import { appendFileSync } from "node:fs";
import { defineEndings } from ${runtime};

export const description = "Runs a child Machine and passes on how it ended.";

export const endings = defineEndings({ passed: { kind: "succeeded" }, stopped: { kind: "failed" } });

export const uses = [${JSON.stringify(selector)}];

export default function relay(p, input) {
  const saved = p.data({ relays: 0, outcome: "" });
  return p.machine({
    initial: "start",
    states: {
      start: p.operation(() => {
        saved.relays += 1;
        appendFileSync(input.log, "middle start\\n");
        return { type: "done" };
      }, { done: "inner" }),
      inner: p.use(${JSON.stringify(selector)}, {
        input: () => input,
        on: {
          ${JSON.stringify(ok)}: { target: "report", actions: () => { saved.outcome = "passed"; } },
          ${JSON.stringify(bad)}: { target: "report", actions: () => { saved.outcome = "stopped"; } },
        },
      }),
      report: p.operation(() => {
        appendFileSync(input.log, "middle after " + JSON.stringify(saved) + "\\n");
        return { type: saved.outcome };
      }, { passed: "passed", stopped: "stopped" }),
      passed: p.final(endings.passed),
      stopped: p.final(endings.stopped),
    },
  });
}
`;
}

/**
 * A top-level Machine that notes a step in its data, runs `selector` at its
 * `delegate` state, and keeps the child's output. On the child's `ok` ending
 * it logs its data and finishes in `finished`; on `bad`, in `stopped`.
 */
export function composerSource(selector: string, ok: string, bad: string): string {
  return `import { appendFileSync } from "node:fs";

export const description = "Runs a child Machine and routes on how it ended.";

export const uses = [${JSON.stringify(selector)}];

export default function composer(p, input) {
  const saved = p.data({ steps: [], received: null });
  const receive = ({ event }) => { saved.received = event.output ?? null; };
  return p.machine({
    initial: "before",
    states: {
      before: p.operation(() => {
        saved.steps.push("before");
        appendFileSync(input.log, "parent start\\n");
        return { type: "done" };
      }, { done: "delegate" }),
      delegate: p.use(${JSON.stringify(selector)}, {
        input: () => ({ log: input.log, every: input.every, outcome: input.outcome }),
        on: {
          ${JSON.stringify(ok)}: { target: "after", actions: receive },
          ${JSON.stringify(bad)}: { target: "gaveUp", actions: receive },
        },
      }),
      after: p.operation(() => {
        appendFileSync(input.log, "parent after " + JSON.stringify(saved) + "\\n");
        return { type: "done" };
      }, { done: "finished" }),
      gaveUp: p.operation(() => {
        appendFileSync(input.log, "parent gave up " + JSON.stringify(saved) + "\\n");
        return { type: "done" };
      }, { done: "stopped" }),
      finished: p.final(),
      stopped: p.final(),
    },
  });
}
`;
}
