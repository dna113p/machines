import type { MachinePrimitives } from "@dna113p/machines";

export const description = "Uses a child Machine that rests in a timed wait.";

export const uses = ["./wait-child.machine.ts"];

export default function usesWait({ final, machine, use }: MachinePrimitives) {
  return machine({
    initial: "delegate",
    states: {
      delegate: use("./wait-child.machine.ts", { input: () => "", on: { rested: "done" } }),
      done: final(),
    },
  });
}
