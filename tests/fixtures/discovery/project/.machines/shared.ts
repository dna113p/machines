import type { MachinePrimitives } from "machines";

export const description = "Runs the project-specific shared Machine.";

export default function localShared({ final, machine, operation }: MachinePrimitives) {
  return machine({
    initial: "run",
    states: {
      run: operation(() => {
        console.log("scope: local");
        return { type: "completed" };
      }, { completed: "done" }),
      done: final(),
    },
  });
}
