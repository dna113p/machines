import type { MachinePrimitives } from "@dna113p/machines";

export const description = "Uses a child whose Agent state needs the reviewer role.";

export const uses = ["./review-child.machine.ts"];

export default function reviewParent({ final, machine, use }: MachinePrimitives) {
  return machine({
    initial: "review",
    states: {
      review: use("./review-child.machine.ts", { input: () => "", on: { approved: "accepted", rejected: "refused" } }),
      accepted: final(),
      refused: final(),
    },
  });
}
