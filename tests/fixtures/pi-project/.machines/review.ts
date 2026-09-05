import type { MachinePrimitives } from "machines";

export const description = "Waits for direct Pi review input.";

export default function reviewMachine(
  { final, human, machine }: MachinePrimitives,
  input: string,
) {
  return machine({
    initial: "review",
    states: {
      review: human(
        `Review ${input}?`,
        { submitted: "done" },
        { suggestions: ["approve", "details"] },
      ),
      done: final(),
    },
  });
}
