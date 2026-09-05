import type { AgentRunner } from "machines";

const runner: AgentRunner = (_request, report) => {
  report?.({
    type: "identity",
    harness: "fixture",
    model: "tiny",
    thinking: "low",
  });
  report?.({ type: "tool", id: "tool-1", title: "Fixture tool", status: "completed" });
  return { type: "completed" };
};

export default function agents() {
  return {
    default: {
      description: "Runs the deterministic host fixture Agent.",
      runner,
    },
  };
}
