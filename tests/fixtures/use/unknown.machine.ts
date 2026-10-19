import type { MachinePrimitives } from "@dna113p/machines";

export const description = "Uses a catalogue name that no Machine has.";

export const uses = ["no-such-machine"];

export default function unknown({ final, machine, use }: MachinePrimitives) {
  return machine({
    initial: "delegate",
    states: {
      delegate: use("no-such-machine", { input: () => "", on: { success: "done" } }),
      done: final(),
    },
  });
}
