import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { MachinePrimitives } from "machines";

const expected = "Hello from Machines.";

export const description = "Asks an Agent to write a known file, then verifies its exact contents.";

export default async function writeFileMachine(
  { agent, final, machine, operation }: MachinePrimitives,
  prompt: string,
) {
  const workspace = await mkdtemp(join(tmpdir(), "machines-file-"));
  const helloPath = join(workspace, "hello.txt");

  console.log(`Workspace: ${workspace}`);

  return machine({
    initial: "write",
    states: {
      write: agent(prompt, { completed: "verify" }, { cwd: workspace }),
      verify: operation(async () => {
        const content = await readFile(helloPath, "utf8");
        if (content.trim() !== expected) {
          throw new Error(`hello.txt must contain exactly: ${expected}`);
        }
        console.log(`hello.txt: ${content.trim()}`);
        return { type: "passed" };
      }, { passed: "done" }),
      done: final(),
    },
  });
}
