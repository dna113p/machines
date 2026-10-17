import type { MachinePrimitives } from "@dna113p/machines";
import { defineEndings, Type } from "../../../src/index.ts";

export const description = "Ends in success or failure, chosen by its input, and reports the task it was given.";

export const endings = defineEndings({
  success: { kind: "succeeded", output: Type.Object({ report: Type.String() }) },
  failure: { kind: "failed", output: Type.Object({ report: Type.String() }) },
});

export default function child(
  { final, machine, operation }: MachinePrimitives,
  input: { readonly task: string; readonly outcome: string },
) {
  return machine({
    initial: "work",
    output: () => ({ report: `${input.outcome} on ${input.task}` }),
    states: {
      work: operation(() => ({ type: input.outcome === "fail" ? "failed" : "done" }), {
        done: "success",
        failed: "failure",
      }),
      success: final(endings.success),
      failure: final(endings.failure),
    },
  });
}
