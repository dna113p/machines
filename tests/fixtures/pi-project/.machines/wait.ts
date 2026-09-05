import type { MachinePrimitives } from "machines";

export const description = "Waits for a deterministic Human decision.";

export default function waitMachine(
  { final, human, machine }: MachinePrimitives,
  input: string,
) {
  return machine({
    initial: "review",
    states: {
      review: human(
        `Approve "${input}"?`,
        { submitted: "done" },
        { choices: ["approve", "deny"] },
      ),
      done: final(),
    },
  });
}
