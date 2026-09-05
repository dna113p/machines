import { fileURLToPath } from "node:url";

import type { MachinePrimitives } from "../src/index.ts";
import { startMachineHost, type HostedHumanRequest } from "../src/host.ts";

export const description = "Demonstrates one asynchronous child-hosted Machine.";

export default function hostedExample(
  { final, human, machine, operation }: MachinePrimitives,
): ReturnType<MachinePrimitives["machine"]> {
  return machine({
    initial: "work",
    states: {
      work: operation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return { type: "completed" };
      }, { completed: "review" }),
      review: human(
        "Approve the hosted example?",
        { submitted: "done" },
        { choices: ["approve", "deny"] },
      ),
      done: final(),
    },
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let resolveHuman!: (request: HostedHumanRequest) => void;
  const human = new Promise<HostedHumanRequest>((resolve) => {
    resolveHuman = resolve;
  });
  const hosted = await startMachineHost({
    machine: fileURLToPath(import.meta.url),
    onState: (state) => console.log(`state: ${String(state)}`),
    onHumanRequest: resolveHuman,
  });

  console.log(`started: ${hosted.name}`);
  const request = await human;
  console.log(`human: ${request.prompt}`);
  await hosted.respond("approve", request.requestId);
  console.log(`completed: ${String((await hosted.result).state)}`);
}
