import type { AgentLimitError, AgentRunner } from "@dna113p/machines";

export const fallback = ["spare"];

export default function agents(adapters: { readonly AgentLimitError: typeof AgentLimitError }) {
  const limited = (resetsAt: () => number): AgentRunner => () => {
    throw new adapters.AgentLimitError("Out of quota", { harness: "fixture", kind: "five_hour", resetsAt: resetsAt() });
  };
  const spare: AgentRunner = (_request, report) => {
    report?.({ type: "identity", harness: "spare" });
    return { type: "completed" };
  };
  return {
    default: {
      description: "Is at a usage limit that the shared fallback list covers.",
      harness: "fixture",
      runner: limited(() => Date.UTC(2099, 0, 1)),
    },
    spare: { description: "Completes the fixture work.", runner: spare },
    waits: {
      description: "Is at a usage limit for the next hour and never swaps.",
      harness: "fixture",
      fallback: [],
      runner: limited(() => Date.now() + 60 * 60_000),
    },
  };
}
