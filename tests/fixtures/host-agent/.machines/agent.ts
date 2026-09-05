import type { MachinePrimitives } from "machines";

export const description = "Reports Agent activity through a Machine host.";

export default function agentMachine(
  { agent, final, machine }: MachinePrimitives,
) {
  return machine({
    initial: "work",
    states: {
      work: agent("Run the fixture Agent.", { completed: "done" }),
      done: final(),
    },
  });
}
