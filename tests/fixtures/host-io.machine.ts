import { writeFile } from "node:fs/promises";
import type { MachinePrimitives } from "../../src/index.ts";
export const description =
  "Flushes a hosted completion after asynchronous filesystem work.";
export default function (
  { machine, operation, final }: MachinePrimitives,
  input: string,
) {
  return machine({
    initial: "work",
    output: () => ({ written: true }),
    states: {
      work: operation(
        async () => {
          await writeFile(input, "done");
          return { type: "done" };
        },
        { done: "done" },
      ),
      done: final(),
    },
  });
}
