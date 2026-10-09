import type { MachinePrimitives } from "../../../../src/index.ts";
import { observeRunStatus } from "../observe.ts";

export const description = "Enters an Agent state from an Operation and leaves it through another.";

export default function workMachine({ agent, final, machine, operation }: MachinePrimitives) {
  return machine({
    initial: "prepare",
    states: {
      prepare: operation(() => ({ type: "prepared" }), { prepared: "work" }),
      work: agent("Run the fixture Agent.", { completed: "settle" }),
      settle: operation(async () => {
        await observeRunStatus("settle");
        return { type: "settled" };
      }, { settled: "done" }),
      done: final(),
    },
  });
}
