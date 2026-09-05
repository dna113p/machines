import type { MachinePrimitives } from "@dna113p/machines";

import { message } from "./message.ts";

export const description = "Demonstrates a directory Machine with a neighboring import.";

export default function folderMachine({ final, machine, operation }: MachinePrimitives) {
  return machine({
    initial: "run",
    states: {
      run: operation(() => {
        console.log(message);
        return { type: "completed" };
      }, { completed: "done" }),
      done: final(),
    },
  });
}
