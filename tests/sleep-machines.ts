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
