import type { MachinePrimitives } from "@dna113p/machines";
import { defineEndings } from "../../../src/index.ts";

export const description = "Uses depth-2, one level further down the depth chain.";

export const endings = defineEndings({ done: { kind: "succeeded" } });

export const uses = ["./depth-2.machine.ts"];

export default function depth1({ final, machine, use }: MachinePrimitives) {
  return machine({
    initial: "next",
    states: {
      next: use("./depth-2.machine.ts", { input: () => "", on: { done: "done" } }),
      done: final(endings.done),
    },
  });
}
