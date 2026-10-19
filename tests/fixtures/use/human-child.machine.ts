import type { MachinePrimitives } from "@dna113p/machines";
import { defineEndings } from "../../../src/index.ts";

export const description = "Asks a Human to approve before it ends.";

export const endings = defineEndings({ approved: { kind: "succeeded" } });

export default function humanChild({ final, human, machine }: MachinePrimitives) {
  return machine({
    initial: "ask",
    states: {
      ask: human("Approve the child's work?", { submitted: "approved" }, { choices: ["approve"] }),
      approved: final(endings.approved),
    },
  });
}
