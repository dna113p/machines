import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import type { MachinePrimitives } from "@dna113p/machines";

export const description = "Spawns an owned subprocess for host lifecycle tests.";

export default function hostProcessMachine(
  { final, human, machine, operation }: MachinePrimitives,
  input: string,
) {
  return machine({
    initial: "spawn",
    states: {
      spawn: operation(async () => {
        const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
          stdio: "ignore",
        });
        await writeFile(input, String(child.pid));
        return { type: "ready" };
      }, { ready: "wait" }),
      wait: human("Finish?", { submitted: "done" }),
      done: final(),
    },
  });
}
