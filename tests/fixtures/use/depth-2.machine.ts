import type { MachinePrimitives } from "@dna113p/machines";
import { defineEndings } from "../../../src/index.ts";

export const description = "Uses depth-3, one level further down the depth chain.";

export const endings = defineEndings({ done: { kind: "succeeded" } });

export const uses = ["./depth-3.machine.ts"];

export default function depth2({ final, machine, use }: MachinePrimitives) {
  return machine({
    initial: "next",
    states: {
      next: use("./depth-3.machine.ts", { input: () => "", on: { done: "done" } }),
      done: final(endings.done),
    },
  });
}
