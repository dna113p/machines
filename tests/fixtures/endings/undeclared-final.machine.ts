import type { MachinePrimitives } from "@dna113p/machines";
import { defineEndings } from "../../../src/index.ts";

export const description = "Has a top-level final that takes no declared ending.";

export const endings = defineEndings({
  done: { kind: "succeeded" },
});

export default function undeclaredFinal({ final, machine, operation }: MachinePrimitives) {
  return machine({
    initial: "work",
    states: {
      work: operation(() => ({ type: "done" }), { done: "done", strayed: "stray" }),
      done: final(endings.done),
      stray: final(),
    },
  });
}
