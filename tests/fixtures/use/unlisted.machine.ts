import type { MachinePrimitives } from "@dna113p/machines";

export const description = "Uses the child Machine without listing it in its uses.";

export const uses = [];

export default function unlisted({ final, machine, use }: MachinePrimitives) {
  return machine({
    initial: "diagnose",
    states: {
      diagnose: use("./child.machine.ts", {
        input: () => ({ task: "work", outcome: "succeed" }),
        on: { success: "fixed", failure: "askedOwner" },
      }),
      fixed: final(),
      askedOwner: final(),
    },
  });
}
