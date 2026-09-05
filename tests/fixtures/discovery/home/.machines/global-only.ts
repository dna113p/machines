import type { MachinePrimitives } from "machines";

export const description = "Runs the global-only discovery fixture.";

export default function globalOnly({ final, machine, operation }: MachinePrimitives) {
  return machine({
    initial: "run",
    states: {
      run: operation(() => ({ type: "completed" }), { completed: "done" }),
      done: final(),
    },
  });
}
