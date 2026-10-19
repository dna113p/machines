import type { AgentRunner } from "@dna113p/machines";

// Only the reviewer approves, so a run that reaches "accepted" used the reviewer runner.
const approve: AgentRunner = () => ({ type: "approved" });
const reject: AgentRunner = () => ({ type: "rejected" });

export default function agents() {
  return {
    default: { description: "Rejects every review.", runner: reject },
    reviewer: { description: "Approves every review.", runner: approve },
  };
}
