# Authoring Machines

## Definition contract

Store a workflow in `.machines/name.ts` or `.machines/name/index.ts` in the project.
The [README quickstart](../README.md#run-your-own-workflows) is a complete minimal
definition. Export a non-empty, one-line `description` and a default factory:

```ts
import type { MachinePrimitives } from "@dna113p/machines";

export const description = "Prints a supplied message after a Human confirms it.";

export default function printMessage(
  { machine, operation, human, final }: MachinePrimitives,
  input: string,
) {
  return machine({
    initial: "confirm",
    states: {
      confirm: human(`Print ${JSON.stringify(input)}?`, {
        submitted: "print",
      }, { choices: ["print"] }),
      print: operation(() => {
        console.log(input);
        return { type: "completed" };
      }, { completed: "done" }),
      done: final(),
    },
  });
}
```

Factories receive primitives, so workflow execution need not resolve the runtime
package from a global `~/.machines/` folder. A type-only import is erased by Node;
installing the local package makes those types available to your editor.

Keep top-level evaluation free of side effects. Discovery imports the definition
and its helpers to inspect metadata. Keep effects inside states: the launcher
calls the factory before it finishes Agent preflight.

## Events and Human input

An Operation or Agent returns `{ type: "eventName", ...data }`. Its state maps
that type to a target. An unexpected event fails the run. Human returns
`{ type: "submitted", value: response }`; use an XState transition action or guard
to inspect `event.value`.

```ts
human("Feedback?", { submitted: "revise" });
human("Approve or give feedback", { submitted: "decide" }, {
  suggestions: ["approve"],
});
human("Choose the outcome", { submitted: "decide" }, {
  choices: ["approve", "deny"],
});
```

Suggestions preserve free-form input. Explicit choices are restrictive and are
validated by the runtime across terminal, injected, Pi, and MCP Human runners.
Both properties cannot be supplied together. Terminal selectors support arrow
keys; piped input stays plain text.

Here is a complete Agent/Human feedback loop. Save as `.machines/review-task.ts`:

```ts
import type { Event, MachinePrimitives } from "@dna113p/machines";

export const description = "Implements a task and revises it until the Human approves.";
export const agentRoles = { implementer: "Implements the task and review feedback" };

export default function reviewTask(
  { machine, agent, human, final }: MachinePrimitives,
  input: string,
) {
  let feedback = "";
  return machine({
    initial: "implement",
    states: {
      implement: agent(
        () => `${input}\n${feedback}`,
        { completed: "review" },
        { using: "implementer", cwd: process.cwd() },
      ),
      review: human("Approve or describe changes", {
        submitted: [
          { guard: ({ event }: { event: Event }) => event.value === "approve", target: "done" },
          {
            target: "implement",
            actions: ({ event }: { event: Event }) => { feedback = String(event.value); },
          },
        ],
      }, { suggestions: ["approve"] }),
      done: final(),
    },
  });
}
```

The Machine owns this loop. An Agent runner only returns an allowed outcome; it
does not decide destination states. Add verification Operations where the workflow
has a concrete condition to check.

## Agent presets

Named Agent states select a semantic role with `using`. Declare each named role in
`agentRoles` with a one-line description. Unnamed states use `default`.

The launcher provides `default` through `npx -y pi-acp`. For deterministic local
practice, this `.machines/agents.ts` preset satisfies the example role without a
model or credentials:

```ts
export default () => ({
  implementer: {
    description: "Demonstrates the review loop without changing files",
    runner: async () => ({ type: "completed" }),
  },
});
```

Run `machine agents`, then `machine run review-task "Demonstrate the loop"`.
Supply feedback once, then `approve`, to exercise both transitions.

To use a real ACP harness, replace the preset with:

```ts
export default ({ acpAgent }: { acpAgent: typeof import("@dna113p/machines/acp").acpAgent }) => ({
  implementer: {
    description: "Uses the locally configured Pi Agent to implement changes",
    harness: "pi-acp",
    runner: acpAgent("npx", ["-y", "pi-acp"], {
      harness: "pi-acp",
      output: "capture",
    }),
  },
});
```

Install/configure the selected harness and its model credentials first. `acpAgent`
accepts any compatible ACP command and argument array; the Pi adapter uses ACP as
its supported execution path. The former `machines/pi` export has been retired;
use `acpAgent` from `@dna113p/machines/acp` for Pi execution.

Global presets live in `~/.machines/agents.ts`; project presets replace matching
global names. Each preset requires a description and runner. Optional `harness`,
`model`, and `thinking` fields are discovery labels, while the runner reports its
actual identity during execution. Harness configuration belongs in the runner
command, arguments, or `env` option; labels do not change model settings.

Use `machine agents` to inspect configured names. Rebind a role for one run:

```bash
machine run review-task --agent implementer=anotherConfiguredPreset -- "Implement the task"
```

Repeat `--agent role=preset` for multiple overrides. `--` ends launcher options.
The launcher rejects unknown roles/presets, duplicate overrides, and missing roles
before starting the actor. `machine list` refreshes metadata on each call and
reports missing bindings or invalid definitions.
`ready` describes valid metadata and resolved roles; it does not verify that a
real harness is installed, authenticated, or able to run the requested model.

### Antigravity (AGY)

The built-in `agy` preset runs the installed Antigravity CLI. Select it for the
default Agent or a declared named role:

```bash
machine run my-workflow --agent default=agy -- "Do the task"
machine run review-task --agent implementer=agy -- "Implement the task"
```

The runner keeps AGY's permission checks enabled. It does not forward interactive
permission prompts through Machines. For an unattended workflow that requires
automatic approval, configure an explicit preset in `.machines/agents.ts`:

```ts
export default ({ agyAgent }: { agyAgent: typeof import("@dna113p/machines/agy").agyAgent }) => ({
  "agy-unattended": {
    description: "Runs AGY with automatic tool approval for trusted workflows",
    harness: "agy",
    runner: agyAgent("agy", [], {
      dangerouslySkipPermissions: true,
      output: "capture",
    }),
  },
});
```

Select that preset with `--agent default=agy-unattended`. The option
`dangerouslySkipPermissions: true` auto-approves all AGY tool permission requests;
omitting it or setting it to `false` keeps the runner from adding that flag.
The `example:agy` demonstration explicitly opts in and asks AGY to work in a
temporary directory.

Runner `model` and `effort` options take precedence over environment settings.
Otherwise it uses `AGY_MODEL` / `AGY_EFFORT`, falling back to
`MACHINES_AGENT_MODEL` / `MACHINES_AGENT_EFFORT`. Per-runner `env` values override
the same variables inherited from the parent process. Effort values are `low`,
`medium`, or `high`.

## Programmatic execution and verification

Direct runtime users supply runners through `run(definition, { agents, human })`.
An `AgentRunner` receives `prompt`, allowed `outcomes`, and optional `cwd`, plus an
optional reporter for `identity`, `output`, and `tool` updates. It returns one event.
A `HumanRunner` receives the prompt, suggestions, or choices and returns a string.

For example, exercise the feedback loop in an installed project:

```ts
import { prepareMachineRun } from "@dna113p/machines/launcher";

const answers = ["Please revise", "approve"];
const prepared = await prepareMachineRun({
  cwd: process.cwd(),
  machine: "review-task",
  input: "Demonstrate the loop",
});
const result = await prepared.start({ human: () => answers.shift() ?? "approve" });
console.log(result.value); // done
```

Use the fake preset above for deterministic verification. A prepared run is
single-use. Omit `human` to retain terminal input. For direct runtime examples,
see the built package's `dist/examples/operation.js`, `human.js`, and
`named-agents.js`; source equivalents live in the checkout's `examples/`.

Verify the final state and the expected effect, including a feedback/error branch
when it changes behavior. Real Agent execution is a separate check that requires
the configured harness and any external authorization for the task.
