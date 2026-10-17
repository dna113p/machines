import type { MachinePrimitives } from "@dna113p/machines";
import { defineEndings } from "../../../src/index.ts";

export const description = "Has a final state that takes another state's ending.";

export const endings = defineEndings({
  shipped: { kind: "succeeded" },
  dropped: { kind: "cancelled" },
});

export default function wrongEnding({ final, machine, operation }: MachinePrimitives) {
  return machine({
    initial: "work",
    states: {
      work: operation(() => ({ type: "done" }), { done: "shipped", drop: "dropped" }),
      shipped: final(endings.shipped),
      dropped: final(endings.shipped),
    },
  });
}
