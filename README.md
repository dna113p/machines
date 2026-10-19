# Machines

Reusable workflows that coordinate Agents, local operations and human decisions.

A Machine writes a repeatable process down as states. An Agent implements a
change, an Operation checks it, a Human approves it or sends feedback. Each
state returns an event, and the Machine decides what happens next.

A state can [run another Machine](docs/authoring.md#using-another-machine) with
`p.use()` and route on its ending, receiving its output.

```text
implement (Agent) → check (Operation) → review (Human) → done
        ↑                                  │
        └──────────── feedback ────────────┘
```

XState runs the transitions. The same workflow runs from a terminal, Pi or
Codex.

For ready-made software workflows, see
[Machine Shop](https://github.com/dna113p/machine-shop). To run a Machine for
each ticket automatically, see
[Machines Dispatch](https://github.com/dna113p/machines-dispatch).

**When to use one:** whenever sequencing, verification, retries or a Human
decision would help, even for a one-off task. Tiny edits, simple answers and
single commands stay direct. Agents should look for a suitable Machine before
delegating or rebuilding a multi-step workflow by hand; users don't have to
name Machines first. See [agent defaults](docs/integrations.md#agent-defaults).

## Quickstart

Needs **Node.js 24 or later** and npm. From a checkout:

```bash
npm ci
npm run check
npm run example
```

The example needs no credentials or Agent and prints:

```text
calculate --completed--> done
```

This is all of it. Save it as `demo.ts` in the checkout root and run
`node demo.ts`; no build is needed.

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

### More examples

Offline, Node only:

| Example | Command |
| --- | --- |
| Deterministic Operation | `npm run example` |
| Human input (needs a terminal) | `node examples/human.ts` |
| Suggestions and choices (needs a terminal) | `node examples/choices.ts` |
| Agent contract, with a fake runner | `node examples/agent.ts` |
| Agent escalation, with fake runners | `npm run example:agents` |
| Child host and Human response | `npm run example:host` |
| Decision-based failure triage, from a fixture | `npm run example:decision` |

With a real Agent. These may use the network and your model plan or credits:

| Agent | Command | Needs |
| --- | --- | --- |
| Pi | `npm run example:pi` | Pi configured through `pi-acp` |
| Antigravity | `npm run example:agy` | The `agy` CLI configured |
| Claude Code | `npm run example:claude` | The `claude` CLI, logged in |
| Codex | `npm run example:codex` | The Codex CLI configured |
| ChatGPT web | `npm run example:chatgpt-web` | rig-bridge connected to ChatGPT, in a signed-in automation browser profile |
| DeepSeek Harness | `npm run example:deepseek` | `dsh` with a configured ACP profile |

Each real-Agent example writes a file and verifies it. The decision example
also runs live with `-- --live --provider NAME`, where `NAME` is `jev`,
`openrouter`, `laya` or `von` (Laya and Von are self-hosted).

## Write your own Machine

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

Then, from the checkout:

```bash
./machine list
./machine show hello
./machine run hello "Hello from Machines."
```

It prints the Machine's path and each state, then `--> done`. From another
project, use the checkout's absolute `machine` path or install the npm package.
The `MachinePrimitives` import is type-only: the launcher supplies the real
primitives.

How Machines are found:

- The nearest project `.machines/` first, then `~/.machines/`. A project
  Machine replaces a global one with the same name.
- A Machine is `name.ts` or `name/index.ts`; if both exist, the single file
  wins.
- `agents.ts` is reserved for Agent presets.
- A broken definition stays listed with its own error, and the others keep
  working.

Structured input: `machine run <name> --input-file file.json`, or
`--input-file -` for stdin. Positional string input still works.

Next: [Authoring Machines](docs/authoring.md) covers Human input, Agent roles
and presets, feedback loops, saved data, timed waits, Operation retries,
structured input and output, and the programmatic launcher.

## Delegate work through Machines

Three skills teach coding agents to use Machines. They ship in the npm package
and the portable plugin.

| Skill | What it does |
| --- | --- |
| [machine-project-setup](skills/machine-project-setup/SKILL.md) | The project orchestrator's entry point. Inspects the project's major work, reuses or builds the Machines it needs, verifies them, and records delegation routes in `.machines/README.md` (or the project's equivalent). |
| [machine-delegation](skills/machine-delegation/SKILL.md) | Has a coordinating agent run Machines instead of native sub-agents: find or create a workflow, launch it, supervise it, collect its result. |
| [machine-builder](skills/machine-builder/SKILL.md) | Creates a task-specific Machine when no existing one fits. |

Example prompts:

> Set up this project's Machines as its orchestrator. Build the workflows that
> support its major work, verify the safe paths, and establish delegation routes.

> Use machine-delegation to review the parser and its tests. Reuse an existing
> Machine if one fits, or create one for this task, then bring back the findings.

A few rules of thumb:

- Run setup when onboarding a project or when coverage has a real gap, not for
  every assignment. It builds working workflows, not just recommendations, and
  doesn't impose a fixed suite.
- The orchestrator owns the map. Workers carry out the Machine state they were
  given.
- Existing budgets, permissions and Human approvals stay in force.
- Delegated runs belong to the session that started them. The skills add no
  durable sessions and no free-form messaging between agents.

Install the skills for Claude Code, Codex, Pi and Antigravity in every project:

```bash
npx skills add dna113p/machines --global --skill '*' \
  --agent claude-code codex pi antigravity
```

To link them from a checkout instead, see
[Integrations](docs/integrations.md#install-the-skills-for-every-agent).

## Install from npm

```bash
npm install @dna113p/machines
npx machine list
```

Other ways:

- Without a project dependency: `npx @dna113p/machines list`.
- Globally: `npm install --global @dna113p/machines`, then `machine list`.
- From a checkout: `npm ci && npm pack`, then
  `npm install /absolute/path/to/machines/dna113p-machines-0.5.0.tgz`.

The command is always `machine`. The package ships JavaScript and TypeScript
declarations; import `{ machine, agent, human, operation, wait, final, run, defineEndings, Type }`
from `"@dna113p/machines"`. Keep your workflow definitions as ordinary
TypeScript outside `node_modules`.

For **Codex MCP**, the **portable Codex plugin** or the **Pi extension**, see
[Integrations](docs/integrations.md). The direct MCP setup needs no personal
marketplace or developer-only install script.

## Watch and answer runs

Every run the `machine` command starts publishes its status to a private
per-user directory (`~/.local/state/machines/runs`, or under
`XDG_STATE_HOME`). Nothing needs configuring. Set `MACHINES_RUN_STATUS_DIR` to `off` to turn it off, or to a
directory to move it.

A finished run with declared endings records `ending: { name, kind }`, where
`kind` is `succeeded`, `failed`, or `cancelled`; its `status` remains `completed`.

| Command | What it does |
| --- | --- |
| `machine runs` | Running, waiting and sleeping runs, with each waiting run's prompt, request id and choices |
| `machine respond <run-id> <request-id> <response>` | Answer a waiting run from anywhere |
| `machine ui` | A live local page of every run, drawing its Machine as a graph |
| `machine watch <run>` | Show a run this session didn't start (say, a daemon's ticket) on its status line |
| `machine continue <run-id>` | Continue a run whose process stopped, from its last checkpoint |

A running `p.use` child appears inside its parent's state path, graph, and trail,
including in `machine ui`, `machine runs`, and the status line.

A run with no terminal, for example one started by an agent or a script, waits
for `machine respond` instead of failing. Anything running as the same user
can answer a waiting run, approvals included.

Status-line hosts such as Claude Code can show running Machines too: see
[run status for host status lines](docs/integrations.md#run-status-for-host-status-lines).

Every flag, sleeping runs, and how continuation works are in
[Running, watching and continuing runs](docs/running.md).

## Good to know

- **Machine files are trusted code.** Discovery imports them, and their
  relative imports, to read their metadata. Operations and Agents run with
  your access and can change files or reach external services. Discovery
  workers are not a sandbox.
- **A Machine owns its own decisions:** retries, approvals, merges and
  cleanup. Stopping a process does not undo file or Git changes.
- **Runs can sleep.** `machine run <name> --sleep` ends the process at a timed
  wait or a Human request, and `machine continue` picks it up later. Machines
  runs no background scheduler.
- **ACP permission requests aren't supported yet:** they fail the Agent state.
  Pick a harness configuration that can do the bounded task, and put decisions
  in Human states.
- **Agents default to Pi** (`npx -y pi-acp`). Built-in presets select Claude
  Code, Codex, Antigravity, ChatGPT web, DeepSeek Harness or a decision
  provider instead; see [Agent presets](docs/running.md#agent-presets).

[Architecture](docs/architecture.md) covers ownership and process lifecycle.

## Checks

```bash
npm run check              # typecheck and behaviour tests
npm run test:laya-service  # optional Python bridge tests via uv; no model weights
npm run build              # JavaScript, declarations, examples and UI assets
npm run smoke:package      # install a tarball in a temporary project and exercise it
npm run build:plugin
npm run smoke:plugin       # exercise a relocated standalone plugin
```

## Releasing

Bump the version in `package.json` on a branch and merge it. When `main` gets
a stable version npm doesn't have, CI runs the checks, publishes to npm and
tags the commit `vX.Y.Z`. Details in [Releasing](docs/releasing.md).

## For applications

- `@dna113p/machines/host` runs a Machine under your own lifecycle; hosted
  results include optional JSON workflow output.
- `@dna113p/machines/run-status` and `machine runs --for` tell you which runs
  one session shows, so you can
  [draw your own widgets](docs/integrations.md#drawing-your-own-widgets).

Licensed under the [MIT License](LICENSE).

## The Machines family

| Project | What it does |
| --- | --- |
| **Machines** (this repository) | The runtime: write a workflow as states, and run it with Agents, checks and people |
| [Machine Shop](https://github.com/dna113p/machine-shop) | Ready-made software workflows to copy into a project |
| [Machines Dispatch](https://github.com/dna113p/machines-dispatch) | A local daemon that runs a Machine for each ticket that is ready |
| [Machine Wars](https://github.com/dna113p/machine-wars) | A concept: ranking Agents so a Machine can pick one |
