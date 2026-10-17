import type { MachinePrimitives } from "@dna113p/machines";
import { defineEndings } from "../../../src/index.ts";

export const description = "Uses depth-5, one level further down the depth chain.";

export const endings = defineEndings({ done: { kind: "succeeded" } });

export const uses = ["./depth-5.machine.ts"];

export default function depth4({ final, machine, use }: MachinePrimitives) {
  return machine({
    initial: "next",
    states: {
      next: use("./depth-5.machine.ts", { input: () => "", on: { done: "done" } }),
      done: final(endings.done),
    },
  });
}
