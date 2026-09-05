import type { MachinePrimitives } from "@dna113p/machines";

export const description = "Asks two identical Human questions to exercise request identity.";

export default function sequentialMachine({ final, human, machine }: MachinePrimitives) {
  return machine({
    initial: "first",
    states: {
      first: human("Continue?", { submitted: "second" }),
      second: human("Continue?", { submitted: "done" }),
      done: final(),
    },
  });
}
