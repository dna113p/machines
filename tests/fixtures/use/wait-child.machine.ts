import type { MachinePrimitives } from "@dna113p/machines";
import { defineEndings } from "../../../src/index.ts";

export const description = "Rests in a long timed wait before it ends.";

export const endings = defineEndings({ rested: { kind: "succeeded" } });

export default function waitChild({ final, machine, wait }: MachinePrimitives) {
  return machine({
    initial: "rest",
    states: {
      rest: wait({ every: "1h" }, { due: "rested" }),
      rested: final(endings.rested),
    },
  });
}
