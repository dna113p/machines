import type { MachinePrimitives } from "@dna113p/machines";
import { defineEndings, Type } from "../../../src/index.ts";

export const description = "Rests in a long timed wait before an ending with an output schema.";

export const endings = defineEndings({
  rested: { kind: "succeeded", output: Type.Object({ report: Type.String() }) },
});

export default function sleeping({ final, machine, wait }: MachinePrimitives) {
  return machine({
    initial: "rest",
    output: () => ({ report: "rested" }),
    states: {
      rest: wait({ every: "1h" }, { due: "rested" }),
      rested: final(endings.rested),
    },
  });
}
