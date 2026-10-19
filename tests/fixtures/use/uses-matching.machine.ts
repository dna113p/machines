import type { MachinePrimitives } from "@dna113p/machines";

export const description = "Uses an existing Machine with endings, unchanged, as its child.";

export const uses = ["../endings/matching.machine.ts"];

export default function usesMatching({ final, machine, use }: MachinePrimitives, input: string) {
  return machine({
    initial: "delegate",
    states: {
      delegate: use("../endings/matching.machine.ts", {
        input: () => input,
        on: { success: "succeeded", failure: "failed", abandoned: "cancelled" },
      }),
      succeeded: final(),
      failed: final(),
      cancelled: final(),
    },
  });
}
