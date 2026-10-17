import type { MachinePrimitives } from "@dna113p/machines";
import { defineEndings, Type } from "../../../src/index.ts";

export const description = "Ends in each of its declared endings, chosen by its input.";

export const endings = defineEndings({
  success: { kind: "succeeded", output: Type.Object({ report: Type.String() }) },
  failure: { kind: "failed" },
  abandoned: { kind: "cancelled" },
});

export default function matching(
  { final, machine, operation }: MachinePrimitives,
  input: string,
) {
  return machine({
    initial: "work",
    output: () => ({ report: `ended after ${input || "work"}` }),
    states: {
      work: operation(() => ({ type: input === "fail" ? "failed" : input === "cancel" ? "cancelled" : "done" }), {
        done: "success",
        failed: "failure",
        cancelled: "abandoned",
      }),
      success: final(endings.success),
      failure: final(endings.failure),
      abandoned: final(endings.abandoned),
    },
  });
}
