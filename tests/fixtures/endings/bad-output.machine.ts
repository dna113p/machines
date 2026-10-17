import type { MachinePrimitives } from "@dna113p/machines";
import { defineEndings, Type } from "../../../src/index.ts";

export const description = "Finishes with output that breaks its ending's schema.";

export const endings = defineEndings({
  reported: { kind: "succeeded", output: Type.Object({ report: Type.String() }) },
});

export default function badOutput({ final, machine, operation }: MachinePrimitives) {
  return machine({
    initial: "work",
    output: () => ({ report: 42 }),
    states: {
      work: operation(() => ({ type: "done" }), { done: "reported" }),
      reported: final(endings.reported),
    },
  });
}
