import {
  type AgentRunner,
  agent,
  final,
  human,
  machine,
  operation,
  run,
} from "../src/index.ts";

const fakeAgent: AgentRunner = (request) => {
  console.log("Agent request:");
  console.log(`prompt: ${request.prompt}`);
  console.log(`cwd: ${request.cwd}`);
  console.log(`outcomes: ${request.outcomes.join(", ")}`);
  return { type: "completed" };
};

const example = machine({
  initial: "work",
  states: {
    work: agent(
      "Implement the tiny task",
      { completed: "confirm" },
      { cwd: "/tmp/machines-fake" },
    ),
    confirm: human("Continue to verification?", { submitted: "verify" }),
    verify: operation(() => ({ type: "passed" }), { passed: "done" }),
    done: final(),
  },
});

const result = await run(example, { agents: { default: fakeAgent } });

console.log(`verified --> ${String(result.value)}`);
