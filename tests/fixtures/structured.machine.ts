import type { JsonValue, MachinePrimitives } from "../../src/index.ts";
export const description = "Returns structured input through the host.";
export default function (
  { machine, operation, final }: MachinePrimitives,
  input: JsonValue,
) {
  return machine({
    initial: "work",
    output: () => (input === "non-json-output" ? 1n : input),
    states: {
      work: operation(() => ({ type: "done" }), { done: "done" }),
      done: final(),
    },
  });
}
