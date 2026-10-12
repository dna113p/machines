import { writeFileSync } from "node:fs";

import type { MachinePrimitives } from "../../src/index.ts";
import { readRunStatuses, runStatusDirectory } from "../../src/run-status.ts";

export const description = "Records what is published while its Operation runs, then finishes or fails.";

export default function runStatusMachine(
  { final, machine, operation }: MachinePrimitives,
  input: { readonly observed: string; readonly fail?: boolean; readonly secret: string },
) {
  return machine({
    initial: "observe",
    output: () => input.secret,
    states: {
      observe: operation(() => {
        writeFileSync(input.observed, JSON.stringify(readRunStatuses(runStatusDirectory() ?? "")));
        if (input.fail === true) throw new Error("run-status fixture failed");
        return { type: "observed" };
      }, { observed: "done" }),
      done: final(),
    },
  });
}
