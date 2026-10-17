import type { MachinePrimitives } from "@dna113p/machines";
import { defineEndings } from "../../../src/index.ts";

export const description = "Uses itself.";

export const endings = defineEndings({ done: { kind: "succeeded" } });

export const uses = ["./self.machine.ts"];

export default function self({ final, machine, use }: MachinePrimitives) {
  return machine({
    initial: "again",
    states: {
      again: use("./self.machine.ts", { input: () => "", on: { done: "done" } }),
      done: final(endings.done),
    },
  });
}
