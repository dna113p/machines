import {
  type Event,
  final,
  human,
  machine,
  run,
} from "../src/index.ts";

const example = machine({
  initial: "choose",
  states: {
    choose: human(
      "Approve or deny?",
      {
        submitted: {
          target: "done",
          actions: ({ event }: { event: Event }) => {
            console.log(`submitted "${String(event.value)}"`);
          },
        },
      },
      { choices: ["approve", "deny"] },
    ),
    done: final(),
  },
});

const result = await run(example);

console.log(`--> ${String(result.value)}`);
