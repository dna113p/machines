# Machines

Reusable workflows that coordinate agents, local operations, and human decisions.

A Machine makes a repeatable process explicit: ask an Agent to implement a change,
run an Operation to check it, and ask a Human to approve or provide feedback. Each
state returns an event; the Machine decides what happens next. XState handles the
transitions, while the same workflow can run from a terminal, Pi, or Codex.

```text
implement (Agent) → check (Operation) → review (Human) → done
        ↑                                  │
        └──────────── feedback ────────────┘
```

Use Machines when a sequence and its decision points are worth repeating. A
one-off prompt or shell script remains useful for work that needs no workflow.

## Quickstart

Requires **Node.js 24 or later** and npm. From a checkout of this repository:

```bash
npm ci
npm run check
npm run example
```

The deterministic example needs no credentials or Agent installation and prints:

```text
calculate --completed--> done
```

Here is its complete implementation, runnable as `demo.ts` in the checkout root:

```ts
import { final, machine, operation, run } from "./src/index.ts";

const workflow = machine({
  initial: "calculate",
  states: {
    calculate: operation(
      () => ({ type: "completed" }),
      { completed: "done" },
    ),
    done: final(),
  },
});

const result = await run(workflow);
console.log(`calculate --completed--> ${String(result.value)}`);
```

Run it with `node demo.ts`. No build is needed to develop against the source.

| Example | Command | Requirements |
| --- | --- | --- |
| Deterministic Operation | `npm run example` | Node only |
| Human input | `node examples/human.ts` | Terminal input |
| Suggestions and choices | `node examples/choices.ts` | Terminal input |
| Agent contract | `node examples/agent.ts` | Built-in fake runner |
| Agent escalation | `npm run example:agents` | Built-in fake runners |
| Child host and Human response | `npm run example:host` | Node only |
| Real Agent writes and verifies a file | `npm run example:pi` | Configured Pi through `pi-acp`; may use network and model credits |
| Real AGY writes and verifies a file | `npm run example:agy` | Configured Antigravity CLI (`agy`); may use network and model credits |
| Real DeepSeek Harness writes and verifies a file | `npm run example:deepseek` | Installed `dsh` with a configured ACP profile; may use network and model credits |

## Run your own workflows

Save this as `.machines/hello.ts` in your project:

```ts
import type { MachinePrimitives } from "@dna113p/machines";

export const description = "Prints the supplied message without an Agent.";

export default function hello(
  { machine, operation, final }: MachinePrimitives,
  input: string,
) {
  return machine({
    initial: "print",
    states: {
      print: operation(() => {
        console.log(input || "Hello from Machines.");
        return { type: "completed" };
      }, { completed: "done" }),
      done: final(),
    },
  });
}
```

From the checkout, run:

```bash
./machine list
./machine show hello
./machine run hello "Hello from Machines."
```

The command reports the Machine path and state progress, then prints `--> done`.
In another project, use the checkout's absolute `machine` path or install the npm
package below. The `MachinePrimitives` import is type-only; executing this definition
uses the primitives supplied by the launcher.

Discovery checks the nearest project `.machines/` and then `~/.machines/`.
Project definitions replace global definitions with the same name. Files can be
`name.ts` or `name/index.ts`; the single file wins if both exist. `agents.ts` is
reserved for Agent presets. Invalid definitions remain visible with their own
diagnostics; other valid Machines remain usable.

Read [Authoring Machines](docs/authoring.md) for Human input, Agent roles and
presets, feedback loops, and the programmatic launcher.

## Install from npm

Install the package in your project:

```bash
npm install @dna113p/machines
npx machine list
```

Or run the CLI without adding a project dependency:

```bash
npx @dna113p/machines list
```

The command is still named `machine`. For a global installation, run
`npm install --global @dna113p/machines`, then use `machine list` or `machine run`.

To install a build from a checkout instead:

```bash
npm ci
npm pack
```

Then install the generated `dna113p-machines-0.1.0.tgz` into a project:

```bash
npm install /absolute/path/to/machines/dna113p-machines-0.2.0.tgz
npx machine list
```

The package contains JavaScript and TypeScript declarations. Application code can
import `{ machine, agent, human, operation, final, run }` from `"@dna113p/machines"`.
Workflow definitions remain ordinary TypeScript outside `node_modules`.

For **Codex MCP**, **the portable Codex plugin**, or **the Pi extension**, follow
[Integrations](docs/integrations.md). No personal marketplace or developer-only
installation script is required for the direct MCP setup.

## Execution model and limitations

Machine definitions and Agent preset files are **trusted executable code**.
Discovery imports them to inspect metadata, including their relative imports.
Keep module initialization free of side effects and do work inside states.
Disposable discovery workers refresh imported metadata; they are not a sandbox.
Operations and configured Agents run with the launching process's available access
and can modify files or contact external services.

Pi and MCP runs belong to the current session. Closing or reloading that session
terminates its owned hosts; runs are not persisted or resumable. Process shutdown
does not undo files or Git changes. A Machine owns its own retry, approval, merge,
and cleanup decisions. See [Architecture](docs/architecture.md) for ownership and
process-lifecycle limits.

ACP permission requests are currently unsupported and fail the Agent state. Choose
a harness configuration that can carry out the intended bounded task and put
workflow decisions in Human states. The launcher defaults unnamed Agents to
`npx -y pi-acp`; [Agent presets](docs/authoring.md#agent-presets) let you select
another ACP command or runner explicitly.

The built-in `agy` preset selects the Antigravity CLI with AGY permission checks
enabled. [AGY configuration](docs/authoring.md#antigravity-agy) explains runner
settings and explicit opt-in to automatic tool approval. `npm run example:agy`
opts in for its temporary-directory demonstration.

The built-in `deepseek` preset runs DeepSeek Harness through `dsh --profile acp`,
reusing the ACP runner and preserving DSH's configured permissions. Select it with
`machine run my-workflow --agent default=deepseek -- "Do the task"`. See
[DeepSeek Harness configuration](docs/authoring.md#deepseek-harness-dsh) for setup,
custom profiles, and configuration overlays.

## Checks

```bash
npm run check          # typecheck and behavior tests
npm run build          # JavaScript, declarations, examples, and UI assets
npm run smoke:package  # install a tarball in a temporary project and exercise it
npm run build:plugin
npm run smoke:plugin   # exercise a relocated standalone plugin
```

## Releasing

The [publishing workflow](.github/workflows/publish.yml) uses a standard GitHub
runner and npm trusted publishing, without an npm token stored in GitHub.
Pushing a `vX.Y.Z` tag runs the checks above and publishes to npm if they pass.
The tag must match the stable version in `package.json`.

For example, to release the next minor version from an up-to-date, clean `main`:

```bash
npm version minor
git push origin main --follow-tags
```

Running **Publish to npm** manually in GitHub Actions performs the checks and a
publishing dry run; it does not publish a package.

Licensed under the [MIT License](LICENSE).
