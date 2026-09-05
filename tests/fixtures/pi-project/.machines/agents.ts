import type { AgentRunner } from "machines";

const runner: AgentRunner = () => ({ type: "completed" });

export default function agents() {
  return {
    fast: {
      description: "A deterministic Agent preset for extension tests.",
      harness: "fixture",
      model: "tiny",
      thinking: "low",
      runner,
    },
  };
}
