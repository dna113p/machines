import type { MachinePrimitives } from "@dna113p/machines";
import { defineEndings } from "../../../src/index.ts";

export const description = "Gives an ending to a final state below the top level.";

export const endings = defineEndings({
  done: { kind: "succeeded" },
});

export default function nestedEnding({ final, machine, operation }: MachinePrimitives) {
  return machine({
    initial: "outer",
    states: {
      outer: {
        initial: "work",
        onDone: "done",
        states: {
          work: operation(() => ({ type: "done" }), { done: "deep" }),
          deep: final(endings.done),
        },
      },
      done: final(endings.done),
    },
  });
}
