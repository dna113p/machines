import type { MachinePrimitives } from "@dna113p/machines";
import { defineEndings } from "../../../src/index.ts";

export const description = "Fails in its only Operation.";

export const endings = defineEndings({ done: { kind: "succeeded" } });

export default function failingChild({ final, machine, operation }: MachinePrimitives) {
  return machine({
    initial: "work",
    states: {
      work: operation(() => {
        throw new Error("the child broke its work");
      }, { done: "done" }),
      done: final(endings.done),
    },
  });
}
