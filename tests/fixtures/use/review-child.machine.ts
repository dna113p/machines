import type { MachinePrimitives } from "@dna113p/machines";
import { defineEndings } from "../../../src/index.ts";

export const description = "Asks its reviewer Agent and ends in its verdict.";

export const agentRoles = { reviewer: "Reviews the fixture work." };

export const endings = defineEndings({
  approved: { kind: "succeeded" },
  rejected: { kind: "failed" },
});

export default function reviewChild({ agent, final, machine }: MachinePrimitives) {
  return machine({
    initial: "review",
    states: {
      review: agent("Review the fixture work.", { approved: "approved", rejected: "rejected" }, { using: "reviewer" }),
      approved: final(endings.approved),
      rejected: final(endings.rejected),
    },
  });
}
