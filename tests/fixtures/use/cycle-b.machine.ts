import type { MachinePrimitives } from "@dna113p/machines";
import { defineEndings } from "../../../src/index.ts";

export const description = "Uses cycle-a, which uses this Machine.";

export const endings = defineEndings({ done: { kind: "succeeded" } });

export const uses = ["./cycle-a.machine.ts"];

export default function cycleB({ final, machine, use }: MachinePrimitives) {
  return machine({
    initial: "toA",
    states: {
      toA: use("./cycle-a.machine.ts", { input: () => "", on: { done: "done" } }),
      done: final(endings.done),
    },
  });
}
