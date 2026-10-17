import type { MachinePrimitives } from "@dna113p/machines";

export const description = "Uses a child Machine that asks a Human.";

export const uses = ["./human-child.machine.ts"];

export default function usesHuman({ final, machine, use }: MachinePrimitives) {
  return machine({
    initial: "delegate",
    states: {
      delegate: use("./human-child.machine.ts", { input: () => "", on: { approved: "accepted" } }),
      accepted: final(),
    },
  });
}
