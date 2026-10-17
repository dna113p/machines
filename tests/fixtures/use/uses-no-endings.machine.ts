import type { MachinePrimitives } from "@dna113p/machines";

export const description = "Uses a Machine that declares no endings.";

export const uses = ["./bare.machine.ts"];

export default function usesNoEndings({ final, machine, use }: MachinePrimitives) {
  return machine({
    initial: "delegate",
    states: {
      delegate: use("./bare.machine.ts", { input: () => "", on: { finished: "done" } }),
      done: final(),
    },
  });
}
