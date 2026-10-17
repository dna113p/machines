import type { MachinePrimitives } from "@dna113p/machines";
import { defineEndings } from "../../../src/index.ts";

export const description = "Ends the depth chain without using another Machine.";

export const endings = defineEndings({ done: { kind: "succeeded" } });

export default function depth5({ final, machine, operation }: MachinePrimitives) {
  return machine({
    initial: "work",
    states: {
      work: operation(() => ({ type: "done" }), { done: "done" }),
      done: final(endings.done),
    },
  });
}
