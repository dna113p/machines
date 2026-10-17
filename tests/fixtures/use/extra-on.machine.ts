import type { MachinePrimitives } from "@dna113p/machines";

export const description = "Uses the child Machine and routes an ending the child does not declare.";

export const uses = ["./child.machine.ts"];

export default function extraOn({ final, machine, use }: MachinePrimitives) {
  return machine({
    initial: "diagnose",
    states: {
      diagnose: use("./child.machine.ts", {
        input: () => ({ task: "work", outcome: "succeed" }),
        on: { success: "fixed", failure: "askedOwner", abandoned: "askedOwner" },
      }),
      fixed: final(),
      askedOwner: final(),
    },
  });
}
