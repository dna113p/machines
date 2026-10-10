import type { Event, MachinePrimitives } from "../../src/index.ts";

export const description = "Asks the kind of Human question named by its input, then outputs every answer.";

export default function humanInboxMachine(
  { final, human, machine, operation }: MachinePrimitives,
  input: "choices" | "suggestions" | "discussion" | "text" | "twice",
) {
  const answers: Array<{ readonly type: string; readonly value: unknown }> = [];
  const record = ({ event }: { event: Event }) => {
    answers.push({ type: event.type, value: event.value });
  };
  const submitted = (target: string) => ({ submitted: { target, actions: record } });
  const options = {
    choices: { choices: ["approve", "deny"] },
    suggestions: { suggestions: ["Use the default"] },
    discussion: { choices: ["approve"], discussion: true },
    text: {},
    twice: {},
  } as const;

  return machine({
    initial: "ask",
    output: () => answers,
    states: {
      ask: human(
        () => (answers.length === 0 ? "Approve the plan?\nIt changes three files." : "Approve it now?"),
        { ...submitted(input === "twice" ? "again" : "done"), question: { target: "noted", actions: record } },
        options[input],
      ),
      noted: operation(() => ({ type: "noted" }), { noted: "ask" }),
      again: human("And then?", submitted("done")),
      done: final(),
    },
  });
}
