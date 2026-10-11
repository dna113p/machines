import type { MachinePrimitives } from "@dna113p/machines";

export const description = "Runs one Agent whose preset is at a usage limit.";

export default function work({ agent, final, machine }: MachinePrimitives) {
  return machine({
    initial: "work",
    states: {
      work: agent("Do the fixture work.", { completed: "done" }),
      done: final(),
    },
  });
}
