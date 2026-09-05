import {
  type AgentRunner,
  agent,
  final,
  machine,
  operation,
  run,
} from "../src/index.ts";

let failedReviews = 0;

const fastReviewer: AgentRunner = (request, report) => {
  report?.({
    type: "identity",
    harness: "antigravity",
    model: "gemini-flash",
  });
  console.log(`fastReviewer: ${request.prompt}`);
  return { type: "changesRequested" };
};

const strongReviewer: AgentRunner = (request, report) => {
  report?.({
    type: "identity",
    harness: "claude-code",
    model: "opus-5",
    thinking: "high",
  });
  console.log(`strongReviewer: ${request.prompt}`);
  return { type: "approved" };
};

const example = machine({
  initial: "review",
  states: {
    review: agent(
      "Review the implementation quickly",
      { changesRequested: "countFailure" },
      { using: "fastReviewer" },
    ),
    countFailure: operation(
      () => {
        failedReviews += 1;
        return { type: failedReviews >= 2 ? "escalate" : "retry" };
      },
      { retry: "review", escalate: "escalatedReview" },
    ),
    escalatedReview: agent(
      "Perform an escalated review",
      { approved: "done" },
      { using: "strongReviewer" },
    ),
    done: final(),
  },
});

const result = await run(example, {
  agents: { fastReviewer, strongReviewer },
});

console.log(`Failed fast reviews: ${failedReviews}`);
console.log(`--> ${String(result.value)}`);
