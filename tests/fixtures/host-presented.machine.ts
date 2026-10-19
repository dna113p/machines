import type { MachinePrimitives } from "@dna113p/machines";

import { presentation, presentedPrompt } from "../sleep-machines.ts";

export const description = "Asks once with every presentation field.";

export default function hostPresentedMachine({ final, human, machine }: MachinePrimitives) {
  return machine({
    initial: "review",
    states: {
      review: human(presentedPrompt, { submitted: "done" }, presentation),
      done: final(),
    },
  });
}
