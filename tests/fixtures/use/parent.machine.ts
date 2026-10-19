import type { Event, MachinePrimitives } from "@dna113p/machines";

export const description = "Runs the child Machine and routes on how it ended, keeping the child's output.";

export const uses = ["./child.machine.ts"];

export default function parent(
  { data, final, machine, operation, use }: MachinePrimitives,
  input: string,
) {
  const saved = data({ task: "set at prepare", outcome: input, received: null as unknown });
  const receive = ({ event }: { event: Event }) => {
    saved.received = event.output ?? null;
  };
  return machine({
    initial: "prepare",
    output: () => ({ received: saved.received }),
    states: {
      prepare: operation(() => {
        saved.task = "set at entry";
        return { type: "done" };
      }, { done: "diagnose" }),
      diagnose: use("./child.machine.ts", {
        input: () => ({ task: saved.task, outcome: saved.outcome }),
        on: {
          success: { target: "fixed", actions: receive },
          failure: { target: "askedOwner", actions: receive },
        },
      }),
      fixed: final(),
      askedOwner: final(),
    },
  });
}
