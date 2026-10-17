import type { MachinePrimitives } from "@dna113p/machines";

export const description = "Uses a child Machine that fails.";

export const uses = ["./failing-child.machine.ts"];

export default function usesFailing({ final, machine, use }: MachinePrimitives) {
  return machine({
    initial: "delegate",
    states: {
      delegate: use("./failing-child.machine.ts", { input: () => "", on: { done: "done" } }),
      done: final(),
    },
  });
}
