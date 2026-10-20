import type { MachinePrimitives } from "@dna113p/machines";

import { suggestedPresentation, presentedPrompt } from "../sleep-machines.ts";

export const description = "Asks once with suggestion presentation.";

export default function hostSuggestedMachine({ final, human, machine }: MachinePrimitives) {
  return machine({
    initial: "review",
    states: {
      review: human(presentedPrompt, { submitted: "done" }, suggestedPresentation),
      done: final(),
    },
  });
}
