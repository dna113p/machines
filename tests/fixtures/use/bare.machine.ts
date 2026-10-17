import type { MachinePrimitives } from "@dna113p/machines";

export const description = "Finishes without declaring any endings.";

export default function bare({ final, machine, operation }: MachinePrimitives) {
  return machine({
    initial: "work",
    states: {
      work: operation(() => ({ type: "done" }), { done: "finished" }),
      finished: final(),
    },
  });
}
