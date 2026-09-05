import type { MachinePrimitives } from "machines";

export const description = "Checks that exact-path execution receives its command input.";

export default function inputMachine(
  { final, machine, operation }: MachinePrimitives,
  input: string,
) {
  return machine({
    initial: "check",
    states: {
      check: operation(() => {
        if (input !== "exact input") throw new Error(`Received input: ${input}`);
        return { type: "passed" };
      }, { passed: "done" }),
      done: final(),
    },
  });
}
