import type { MachinePrimitives } from "machines";

export const description = "Waits for one restricted Human review response.";

export default function reviewMachine(
  { final, human, machine }: MachinePrimitives,
  input: string,
) {
  return machine({
    initial: "review",
    states: {
      review: human(
        `Review "${input}"?`,
        { submitted: "done" },
        { choices: ["approve", "deny"] },
      ),
      done: final(),
    },
  });
}
