import type { MachinePrimitives } from "@dna113p/machines";
import { defineEndings } from "../../../src/index.ts";

export const description = "Uses cycle-b, which uses this Machine again.";

export const endings = defineEndings({ done: { kind: "succeeded" } });

export const uses = ["./cycle-b.machine.ts"];

export default function cycleA({ final, machine, use }: MachinePrimitives) {
  return machine({
    initial: "toB",
    states: {
      toB: use("./cycle-b.machine.ts", { input: () => "", on: { done: "done" } }),
      done: final(endings.done),
    },
  });
}
