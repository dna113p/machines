// The Machines the sleep tests run, written into each test's own project.

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
