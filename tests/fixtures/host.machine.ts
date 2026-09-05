import type { MachinePrimitives } from "@dna113p/machines";

export const description = "Exercises one hosted Machine run.";

export default function hostMachine(
  { final, human, machine, operation }: MachinePrimitives,
  input: string,
) {
  return machine({
    initial: "work",
    states: {
      work: operation(async () => {
        console.log("host-only stdout");
        process.stderr.write("host-only stderr\n");
        if (input === "fail") throw new Error("host fixture failed");
        if (input === "exit") {
          await new Promise((resolve) => setTimeout(resolve, 30));
          process.exit(17);
        }
        return { type: "completed" };
      }, { completed: "review" }),
      review: human(
        `Approve the hosted run "${input || "default"}"?`,
        { submitted: "done" },
        { choices: ["approve", "deny"] },
      ),
      done: final(),
    },
  });
}
