import type { MachinePrimitives } from "@dna113p/machines";

export const description = "Uses the child Machine but routes only one of its two endings.";

export const uses = ["./child.machine.ts"];

export default function wrongOn({ final, machine, use }: MachinePrimitives) {
  return machine({
    initial: "diagnose",
    states: {
      diagnose: use("./child.machine.ts", {
        input: () => ({ task: "work", outcome: "succeed" }),
        on: { success: "fixed" },
      }),
      fixed: final(),
    },
  });
}
