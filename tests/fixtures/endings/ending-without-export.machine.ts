import type { MachinePrimitives } from "@dna113p/machines";
import { defineEndings } from "../../../src/index.ts";

export const description = "Gives its final state an ending without exporting its endings.";

const local = defineEndings({
  loose: { kind: "succeeded" },
});

export default function endingWithoutExport({ final, machine, operation }: MachinePrimitives) {
  return machine({
    initial: "work",
    states: {
      work: operation(() => ({ type: "done" }), { done: "loose" }),
      loose: final(local.loose),
    },
  });
}
