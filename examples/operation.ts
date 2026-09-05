import {
  final,
  machine,
  operation,
  run,
} from "../src/index.ts";

const example = machine({
  initial: "calculate",
  states: {
    calculate: operation(
      () => ({ type: "completed" }),
      { completed: "done" },
    ),
    done: final(),
  },
});

const result = await run(example);

console.log(`calculate --completed--> ${String(result.value)}`);

