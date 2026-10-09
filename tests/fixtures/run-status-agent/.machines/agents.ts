import type { AgentRunner } from "../../../../src/index.ts";
import { observeRunStatus } from "../observe.ts";

// Like the bundled runners, this reports its identity before its first await,
// which for a state entered by a transition is before the state is announced.
const runner: AgentRunner = async (_request, report) => {
  report?.({ type: "identity", harness: "fixture", model: "tiny", thinking: "low" });
  await observeRunStatus("work");
  // A late refinement still belongs to the state that is about to be left.
  report?.({ type: "identity", harness: "fixture", model: "refined" });
  return { type: "completed" };
};

export default function agents() {
  return {
    default: {
      description: "Records what is published while the fixture Agent runs.",
      runner,
    },
  };
}
