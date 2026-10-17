import type { MachinePrimitives } from "@dna113p/machines";
import { defineEndings } from "../../../src/index.ts";

export const description = "Declares an ending that no final state takes.";

export const endings = defineEndings({
  done: { kind: "succeeded" },
  spare: { kind: "failed" },
});

export default function unusedEnding({ final, machine, operation }: MachinePrimitives) {
  return machine({
    initial: "work",
    states: {
      work: operation(() => ({ type: "done" }), { done: "done" }),
      done: final(endings.done),
    },
  });
}
