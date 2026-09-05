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
      "What should happen?",
      {
        submitted: {
          target: "done",
          actions: ({ event }: { event: Event }) => {
            console.log(`submitted "${String(event.value)}"`);
          },
        },
      },
      { suggestions: ["Use the default"] },
    ),
    done: final(),
  },
});

const result = await run(example);

console.log(`--> ${String(result.value)}`);
