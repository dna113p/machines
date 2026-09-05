> Archived implementation history. Current contributor guidance is in [AGENTS.md](../../AGENTS.md), and current design constraints are in [Architecture](../architecture.md). Phase gates below describe the original development process and are not requirements for new changes.

# Machines implementation plan

**Status:** Phase 13 Codex plugin implemented; awaiting desktop UX proof

**Implementation:** Phases 1-8 proven; Phases 9-11 implemented; Phase 12A-12C proven; Phases 12D and 13 implemented

**Current phase:** Phase 13, shared Codex MCP tools and optional live card, awaiting human UX proof

**Last updated:** 2026-09-04

## Purpose

Machines is a deliberately small XState runtime for composing three kinds of work:

- an **Agent** performs bounded work and returns an event;
- a **Human** supplies free-form input, suggestions, or an explicit restricted choice;
- an **Operation** performs trusted local computation and returns an event.

A **Machine** maps those events to state transitions. It is the only place that owns sequencing policy.

The initial product goal is to launch a useful machine from Pi that creates a Git worktree, asks Pi to implement a task inside it, runs one Pi review, and presents the result for human review. We will reach that goal through independently usable phases rather than building the final architecture in advance.

The existing `dna-primitives` and DNA repositories are not inputs to this implementation. They will not be renamed, migrated, wrapped, or used as compatibility targets.

## Simplicity directive: tracer bullets

**Treat every phase as a tracer bullet:** the smallest complete end-to-end path that the user can run to prove one capability. Complete means the path works, its failures are understandable, and the user can judge the experience. It does not mean preparing the design for later phases.

Future agents implementing this plan must use this order:

1. Start from the current phase's manual proof.
2. Write one sentence: `This phase proves ___ by adding only ___.`
3. Implement only the code exercised by that proof or required to produce an understandable failure.
4. Use XState and ordinary TypeScript directly before inventing a Machines abstraction.
5. Keep behavior in the Machine file unless the current runtime must own it for the current proof to work.
6. Introduce a seam only when two real implementations vary at that point. Until then, accept the concrete dependency directly.
7. Before requesting human proof, remove every helper, option, file, dependency, and configuration field that the current proof does not exercise.

The simplicity gate is passed only when all of these are true:

- Every new public concept appears in the current manual proof.
- Every new runtime path is covered by the current proof or an error-path test.
- The Machine definition remains more prominent and easier to understand than the runtime supporting it.
- The user can explain what happened during the run without learning internal architecture.
- Later phases could be deleted from this plan without leaving speculative machinery in the current implementation.

When a proposed addition is justified with words such as "later," "eventually," "reusable," "extensible," "provider-agnostic," or "just in case," leave it out of the active phase. Record it under that phase's adjustments and reconsider it only after a real proof creates the need.

Prefer deleting a premature idea over preserving it for compatibility. Complexity is admitted by demonstrated pressure, one piece at a time.

## Canonical vocabulary

- **Machine:** A finite-state policy that maps events to subsequent states.
- **State:** One named position in a Machine. A non-final state invokes one primitive.
- **Agent:** Bounded work performed by an Agent runner, initially Pi.
- **Human:** A request for human input. Suggestions preserve free-form input; choices explicitly restrict it.
- **Operation:** Trusted local code such as a function, command, or Git action.
- **Event:** The typed result of Agent, Human, or Operation work. Only the Machine maps it to a transition.
- **Run:** One live execution of a Machine with its current state and context.
- **Adapter:** A concrete implementation that connects a primitive to something external, such as Pi or a terminal.

`Step` is intentionally not a public concept. A state directly invokes `agent`, `human`, or `operation`.

## Governing constraints

1. XState owns state transitions and actor lifecycle. Machines will not implement a second FSM.
2. A new behavior begins as ordinary code in one Machine file.
3. Behavior moves into the core only after multiple proven Machines demonstrate that they cannot reasonably own it themselves.
4. The Machine owns workflow policy. Adapters implement external mechanics but never choose destination states.
5. Every actor returns one semantic event. The current state declares which event types it accepts.
6. Human input is free-form by default. Suggestions are presentation only; explicit choices are restrictive.
7. There is no generic planning or approval protocol. A human decision exists only when a Machine explicitly contains a Human state.
8. No phase begins until the preceding phase has been manually proven and its friction has been reviewed.
9. Later phases are forecasts, not commitments. Their scope must be revised using evidence from earlier phases.
10. Configuration, persistence, registries, and extensibility mechanisms are not added in anticipation of future use.

## Progress protocol

Each phase moves through these statuses:

```text
Planned -> Active -> Awaiting human proof -> Proven
                    \-> Revised -> Active
```

For every phase:

1. Re-read this plan, pass the simplicity gate, and revise the phase using evidence accumulated so far.
2. Implement only the active phase.
3. Verify the behavior through the public interface.
4. Provide a short manual proof script.
5. Wait for the user's proof and usability assessment.
6. Fix the active phase in place until it feels right.
7. Record proof evidence, surprises, and plan adjustments below.
8. Mark the phase Proven before starting another phase.

We will prefer one focused commit per phase. A phase is not considered proven merely because its automated tests pass.

## Progress summary

| Phase | Capability | Status | Human proof |
|---|---|---|---|
| 1 | XState plus Operation | Proven | Accepted; user authorized Phase 2 |
| 2 | Human input | Proven | Accepted; user authorized Phase 3 |
| 3 | Agent with a fake Adapter | Proven | Accepted; user authorized Phase 4 |
| 4 | Pi Agent Adapter | Proven | Accepted; user authorized Phase 5 |
| 5 | Exact Machine file loading | Proven | Accepted; user authorized Phase 6 |
| 6 | Named global and project discovery | Proven | Accepted; user requested the next phase |
| 7 | ACP Agent Adapter | Proven | Accepted; user ran real Pi and continued to Phase 8 |
| 8 | Worktree implementation Machine | Proven | Accepted; user delegated Human review for a full real-Pi dogfood run |
| 9 | Run visibility, then Pi interface | Awaiting human proof | Live CLI tracer tested; real workflow proof pending |
| 10 | Named Agent runners and user bindings | Awaiting human proof | Automated preflight and deterministic escalation proof complete |
| 11 | Discoverable Agent presets and one-run rebinding | Awaiting human proof | CLI discovery, override, and preflight tests complete |
| 12 | Async Pi extension | Active: 12D awaiting human UX proof | Real worktree task stayed asynchronous through conversation, revision, approval, merge, and cleanup |

## Phase 1: XState plus Operation

**Tracer bullet:** This phase proves an Operation can drive an XState Machine to a final state by adding only the greenfield TypeScript setup, `machine`, `operation`, `final`, `run`, one example, and public-interface tests.

### Objective

Prove the smallest complete Machine without any external actor.

### Planned scope

- Create the greenfield repository and its minimal TypeScript setup.
- Add XState as the only runtime dependency.
- Expose the provisional interface `machine`, `operation`, `final`, and `run`.
- Run an Operation, receive its event, transition, and finish.
- Produce precise failures for thrown Operations, missing target states, and unhandled events.
- Add tests through the same public interface used by the example.

Provisional example:

```ts
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

await run(example);
```

### Manual proof

- Run the example and observe `calculate --completed--> done`.
- Change the returned event to an unhandled type and inspect the error.
- Throw from the Operation and inspect the error.
- Decide whether the Machine definition feels like ordinary XState with helpful vocabulary rather than a second framework.

### Exit criteria

- XState, not custom transition code, determines machine behavior.
- The example can be understood without reading the runtime implementation.
- Error messages identify the Machine state and event or actor failure.
- The user marks the phase proven.

### Explicitly absent

Human input, Agents, Pi, a CLI, file loading, discovery, persistence, configuration, and registries.

### Evidence and adjustments

- Automated evidence: `npm run check` passes type-checking and four public-interface tests; `npm run example` prints `calculate --completed--> done`.
- Human proof: Accepted; the user authorized Phase 2 after the Phase 1 handoff.
- Usability notes: The public example uses only `machine`, `operation`, `final`, and `run`; XState owns invocation, transitions, final-state completion, and missing-target validation.
- Changes to later phases: None yet; later phases remain provisional until human proof.

## Phase 2: Human input

**Tracer bullet:** This phase proves a Human state can wait for unrestricted terminal input and continue through a `submitted` event by adding only `human`, terminal input, one example, and its public-interface test.

### Revalidation question

Did Phase 1's state-helper interface remain simple enough that `human` can follow the same shape without introducing another abstraction?

### Planned scope

- Add `human(prompt, transitions, options?)`.
- Add one concrete terminal interaction.
- Pause a Run while waiting for input and continue it with a `submitted` event.
- Permit arbitrary input even when suggestions are displayed.
- Return the submitted value on the event without adding context policy to the primitive.

### Manual proof

- Run `operation -> human -> operation -> final`.
- Submit a suggested response.
- Run it again and submit an entirely different response.
- Confirm both responses reach the next state.
- Confirm the display clearly identifies the current state and question.

### Exit criteria

- A Human state has no implicit approval semantics.
- Suggestions do not constrain input.
- Waiting and continuation are understandable from the public interface.
- The user marks the phase proven.

### Explicitly absent

Agents, Pi, persistent waiting, forms, generic schemas, saved Runs, and approval machinery.

### Evidence and adjustments

- Automated evidence: `npm run check` passes type-checking and six tests, including unrestricted input with a displayed suggestion and clear failure when terminal input closes.
- Human proof: Accepted; the user authorized Phase 3 after the Phase 2 handoff.
- Usability notes: `Something entirely different` is carried on the `submitted` event even while `Use the default` is displayed; the example reaches `done` using an ordinary XState transition action.
- Changes to later phases: A generalized Human Adapter and automatic context policy were not added. The terminal is the one concrete interaction; a seam will be reconsidered when Pi creates a second real Human presentation in Phase 9.

## Phase 3: Agent with a fake Adapter

**Tracer bullet:** This phase proves an Agent state can give one supplied fake Agent its prompt, working directory, and allowed outcomes, receive one event, and let XState transition by adding only `agent`, the Agent request/runner interface, one fake, and one example/test.

### Revalidation question

Can Agent execution use the same event contract as Operation without introducing roles, bindings, capabilities, or provider configuration?

### Planned scope

- Add `agent(prompt, transitions, options?)`.
- Accept an Agent Adapter as a Run dependency.
- Implement a deterministic fake Adapter for tests and demonstration.
- Give the Adapter the resolved prompt, working directory when supplied, and allowed event types.
- Require it to return exactly one event.

### Manual proof

- Run `agent -> human -> operation -> final` with the fake Adapter.
- Observe the exact Agent request.
- Return a valid event and observe the transition.
- Return an illegal event and inspect the error.
- Confirm the Adapter cannot choose a destination state.

### Exit criteria

- `agent`, `human`, and `operation` share one understandable event model.
- Machine policy and Agent mechanics remain separate.
- No hypothetical provider seam has been added.
- The user marks the phase proven.

### Explicitly absent

Real Pi, Agent registries, roles, manifests, threads, capability models, and provider selection.

### Evidence and adjustments

- Automated evidence: `npm run check` passes type-checking and nine tests, including the exact Agent request, valid outcome, illegal outcome, and missing-runner failure.
- Human proof: Accepted; the user authorized Phase 4 after the Phase 3 handoff.
- Usability notes: The fake receives only `prompt`, `cwd`, and allowed `outcomes`; its `completed` event drives `Agent -> Human -> Operation -> final` without revealing transition targets.
- Changes to later phases: XState's native `machine.provide({ actors })` is sufficient to replace the fake with Pi in Phase 4. No provider registry, role, binding, capability model, or custom dispatch was added.

## Phase 4: Pi Agent Adapter

**Tracer bullet:** This phase proves the existing `agent` primitive can use real Pi to create one file in a supplied directory and return one allowed event by adding only one Pi runner and the smallest supported `return_event` mechanism.

### Revalidation question

What is the narrowest supported way to start Pi in a working directory and give it one constrained outcome-reporting tool?

This must be answered from the actual Pi installation and supported extension or invocation interface at the start of the phase. The plan does not preselect a transport.

### Planned scope

- Implement one Pi Agent Adapter directly, without a provider registry.
- Start Pi with a prompt and working directory.
- Expose ordinary work tools plus one `return_event` tool.
- Derive allowed return-event types from the current state's transitions.
- End the Agent invocation after one valid event.

### Manual proof

Run a Machine that asks Pi to create `hello.txt`, then uses an Operation to verify the file before reaching a final state.

The user verifies:

- Pi worked in the requested directory.
- The prompt made the task and allowed outcomes clear.
- `return_event` was understandable.
- There was no abstract planning approval.
- The resulting file and transition were easy to inspect.

### Exit criteria

- One tiny Agent task succeeds through the Machine using real Pi.
- Failures name the concrete Pi invocation or invalid event.
- The Pi-specific implementation has not leaked into Machine definitions.
- The user marks the phase proven.

### Explicitly absent

Pi as the human interface, resumable conversations, multiple harnesses, remote Agents, skill binding, and execution manifests.

### Evidence and adjustments

- Automated evidence: `npm run check` passes type-checking and eleven tests. `npm run example:pi` used real Pi to create `/tmp/machines-pi-eoyFz3/hello.txt`; the following Operation verified its exact contents and the Machine reached `done`.
- Human proof: Accepted; the user authorized Phase 5 after the Phase 4 handoff.
- Pi interface findings: Pi 0.84.4 supports a non-interactive JSON event stream, explicit extension and tool selection, and terminating a run from a tool result. The Adapter starts a sessionless Pi with only `read`, `write`, and the tiny `return_event` extension. Closing the child process's stdin is essential; leaving it open makes Pi wait for input before starting.
- Changes to later phases: Phase 5 can import the concrete `piAgent` directly. No provider selection, Pi configuration, retry policy, role, registry, or generalized harness was needed.

## Phase 5: Exact Machine file loading

**Tracer bullet:** This phase proves one ordinary typed Machine file can be loaded and run without compilation from an exact caller-supplied path by adding only one executable command, one Pi-style default factory shape, and one example/test Machine file.

### Revalidation question

What did the first real Pi Machine need from its file interface? Do not design inputs or metadata beyond that evidence.

### Planned scope

- Move a Machine definition outside the core package.
- Load it by an exact path supplied by the caller.
- Use a default-exported factory that receives the Machines primitives, avoiding package-resolution ceremony in global files.
- Add the smallest executable command needed to run an exact file.
- Show the exact resolved file before execution.

Command:

```bash
machine run ./.machines/write-file.ts "Create hello.txt"
```

### Manual proof

- Run the file by exact path.
- Edit only the Machine file and observe changed behavior.
- Supply an invalid path and inspect the error.
- Confirm the caller can always tell which file will execute.

### Exit criteria

- Useful behavior can be changed without changing Machines core.
- A Machine file remains normal, readable code.
- No registry or installation step is required.
- The user marks the phase proven.

### Explicitly absent

Named discovery, project overrides, Machine inheritance, merging, package registries, and installation manifests.

### Evidence and adjustments

- Automated evidence: `npm run check` passes type-checking and thirteen tests, including exact `.ts` loading with input and an invalid-path failure. The real-Pi command loaded `/home/user/projects/machines/.machines/write-file.ts`, created `/tmp/machines-file-cFRuBC/hello.txt`, verified its exact contents, and reached `done`. A typed Machine outside the package also loaded directly from `/tmp`, proving the type-only `machines` import adds no runtime resolution requirement.
- Human proof: Accepted; the user authorized Phase 6 after the typed Machine file handoff.
- File-interface notes: Mirroring Pi extensions, a `.ts` file imports the `MachinePrimitives` type and default-exports one sync or async factory. The factory receives the five proven primitives plus one input string. Node runs the TypeScript directly with no compilation step, and the launcher supplies the concrete Pi runner.
- Changes to later phases: Phase 6 may resolve a name to an exact path and then follow this behavior. No reusable loader module, discovery seam, metadata, or configuration was added in anticipation of it.

## Phase 6: Named global and project discovery

**Tracer bullet:** This phase proves a Machine can be listed, shown, and run by name with predictable nearest-project precedence and global fallback by adding only one discovery function and the three planned command forms.

### Revalidation question

Did exact-path execution prove valuable enough that naming and discovery solve a real usability problem rather than hiding execution?

### Planned scope

- Add `machine list`, `machine show <name>`, and `machine run <name> <input>`.
- Discover user-global Machine files from a single conventional directory.
- Discover the nearest project-specific Machine directory by walking upward.
- Recognize both `<name>.ts` and `<name>/index.ts`; an index Machine may use ordinary relative imports.
- Make the resolved source path visible in list, show, run, and errors.

Locations chosen by the user:

```text
~/.machines/
<project>/.machines/
```

Resolution rules:

1. Find the nearest `.machines` directory while walking upward from the working directory.
2. Within one directory, `<name>.ts` wins over `<name>/index.ts` if both exist.
3. A matching project Machine wins; otherwise use the user-global Machine.
4. A project Machine replaces the global Machine completely.
5. Definitions are never implicitly merged or inherited.
6. No configuration file is required merely to discover these directories.

### Manual proof

- Run a global Machine by name.
- Add a project Machine with the same name and confirm it wins.
- Run from a nested directory and confirm upward discovery.
- Remove the project definition and confirm the global definition returns.
- Use `machine list` and `machine show` to identify the exact source every time.

### Exit criteria

- Discovery is predictable without documentation lookup.
- Overrides never hide their source.
- No config, registry, merge algorithm, or installer has appeared.
- The user marks the phase proven.

### Evidence and adjustments

- Automated evidence: `npm run check` passes type-checking and eighteen tests. Discovery tests cover nearest-project lookup from a nested working directory, project override, global fallback, `<name>.ts` over `<name>/index.ts`, an index Machine importing neighboring TypeScript, visible list/show paths, and missing-name guidance. A real named Pi run resolved `write-file` to `/home/user/projects/machines/.machines/write-file.ts`, created `/tmp/machines-file-zPH8CM/hello.txt`, verified it, and reached `done`.
- Human proof: Accepted; the user confirmed discovery worked and requested the next phase.
- Discovery notes: `machine list`, `machine show <name>`, and `machine run <name> [input]` all use one resolver. It finds only the nearest project `.machines` directory, overlays its names onto `~/.machines`, sorts the result, and always displays the selected path. Exact paths remain supported.
- Changes to later phases: The user chose to prove ACP Agent execution before building the worktree Machine. The worktree Machine moved to Phase 8. No registry, configuration, manifest, merge behavior, installer, watcher, or cache was added.

## Phase 7: ACP Agent Adapter

**Tracer bullet:** This phase proves the existing Agent interface can run real Pi through a generic ACP subprocess by adding only one `acpAgent(command, args?, options?)` Adapter, the official stable ACP client, and focused fake-protocol tests.

### Revalidation question

Can ACP replace the direct Pi process mechanics without changing `agent`, `AgentRunner`, or any Machine definition?

### Planned scope

- Add `acpAgent(command, args?, options?)`, returning the existing `AgentRunner`. Optional environment overrides select harness-owned profiles without changing the Machine.
- Speak stable ACP v1 over NDJSON to one subprocess per Agent state.
- Initialize, create one session at the requested `cwd`, send one prompt, stream Agent text, and return one Machines event.
- Use one final `MACHINES_EVENT` text marker because Pi ACP does not wire client-supplied MCP servers into Pi.
- Route the existing Pi example and Machine launcher through `npx -y pi-acp`.
- Keep the proven direct Pi Adapter until the ACP path is manually accepted.

### Manual proof

```bash
npm install
npm run example:pi
```

Confirm that:

- the startup output identifies real Pi;
- Pi creates `hello.txt` in the printed temporary workspace;
- the Operation verifies its exact contents;
- the Machine reaches `done` through `MACHINES_EVENT {"type":"completed"}`;
- the Machine definition contains no ACP or Pi-specific code.

### Exit criteria

- The unchanged Agent state succeeds through real `pi-acp`.
- `acpAgent` accepts an executable rather than defining a provider registry.
- Missing working directories, missing outcomes, transport failures, and missing result events fail clearly.
- The user marks the phase proven.

### Explicitly absent

ACP v2, session reuse, persistence, native takeover, attention notifications, provider configuration, named Agent roles, client filesystem or terminal capabilities, generic approvals, and a return-event MCP server.

### Evidence and adjustments

- Automated evidence: `npm run check` passes type-checking and twenty-three tests, including a fake ACP subprocess, subprocess environment overrides, required-input failures, and a missing-event failure.
- Real-Agent evidence: `npm run example:pi` started Pi 0.84.1 through published `pi-acp`, created `/tmp/machines-pi-hoXCcN/hello.txt`, verified `Hello from Machines.`, returned `completed`, and reached `done`.
- Human proof: Accepted; the user ran `npm run example:pi`, inspected the real Pi output, and continued to the worktree phase.
- ACP notes: Machines uses stable ACP v1. The official TypeScript SDK uses Zod internally; Machines exposes and writes no Zod schemas. Harness selection remains the executable and arguments; harness-specific profile selection is an environment override such as Pi's `PI_CODING_AGENT_DIR`. The first proof received no ACP permission requests. If one is received, the Adapter rejects it and reports that permission input is not implemented rather than creating a vague approval flow.
- Changes to later phases: Phase 8 should use `acpAgent` for both Agent states. Delete the direct Pi Adapter only after this phase is accepted. Native takeover remains a later Adapter concern and must not alter Machine definitions.

## Phase 8: Worktree implementation Machine

### Revalidation question

Can the complete useful behavior remain in one Machine file using only the three proven primitives?

### Planned scope

Create one Machine file in the independent `/home/user/projects/dev-machines`
repository whose policy is:

```text
Operation: create a worktree from a base commit
    -> Agent: Pi implements in the worktree
    -> Agent: Pi performs one advisory review
    -> Human: inspect and approve or provide feedback
         -> approved: Operation: merge the approved work
                      -> Operation: remove the worktree
                      -> final
         -> feedback: Agent revises in the same worktree
                      -> Human reviews again
```

The automated review runs exactly once. Human-requested revisions return directly to Human review. The Human remains the authority. Human approval authorizes integration; it does not complete the Machine. Merge and cleanup must both succeed before the Machine reaches its final state. A failure preserves a non-final, recoverable state rather than reporting success.

Git worktree creation, review prompts, revision loops, merge, and cleanup policy remain ordinary code and policy in the Machine file. They do not become core concepts.

### Manual proof

- Use a disposable Git repository and an explicit base commit.
- Confirm the worktree starts at that commit.
- Confirm Pi modifies only the worktree.
- Inspect the implementation.
- Confirm the automated reviewer runs exactly once.
- Inspect the review evidence.
- Request one revision in free text.
- Inspect the revision and approve it.
- Confirm the approved work is merged into the original branch.
- Confirm the temporary worktree is removed.
- Confirm the Machine reaches `done` only after both operations succeed.

### Exit criteria

- The first genuinely useful workflow succeeds end to end.
- The Machine is readable as a single policy definition.
- Machines core contains no Git, review, revision, or worktree knowledge.
- Approval, merge, cleanup, and completion are distinct states.
- The user marks the phase proven.

### Evidence and adjustments

- Automated evidence: `npm run check` passes twenty-five runtime tests, including invocation-time Agent prompts and symlink discovery. Dev Machines has three passing disposable-repository tests covering direct approval, free-form feedback and revision, dirty-source refusal, fast-forward identity, worktree removal, temporary branch deletion, and final completion.
- Human proof: Accepted. At the user's request, the assistant acted as the Human reviewer in a real `machine run worktree-task` dogfood run. Real Pi implemented commit `4e48f7f`; one separate real Pi review returned two findings; free-form Human feedback produced revisions `9d6871e` and `0c1f110`; approval fast-forwarded `main`; cleanup removed the temporary worktree and branch; only then did the Machine print `done`.
- End-to-end friction: Invocation-time Agent prompts successfully carried exact Human feedback without adding workflow policy to the runtime. The Human gate was understandable and supported repeated unrestricted feedback. ACP exposed Agent final text but hid tool calls and progress, producing several multi-minute silent periods that looked stalled. Each fresh Agent also repeated the full Pi startup banner. Testing from the actual temporary worktree exposed and corrected an assumption that the Machines repository would remain a filesystem sibling.
- Changes to Phase 9: Revalidate Phase 9 around the observed presentation gap. The first candidate improvement is visible state and Agent activity or heartbeat information during silent ACP work, while preserving the CLI and Machine as the only sequencing authority. Do not add a broad Pi interface before proving which minimal presentation solves the confusion.

## Phase 9: Run visibility, then Pi interface

**Tracer bullet:** This phase first proves the CLI can continuously expose the
authoritative current XState state during silent Agent work by adding only an optional
state observer and one live CLI status line.

### Revalidation question

Does a visible current state and heartbeat resolve the worst confusion during a run?
After proving that, which Pi interactions still improve the experience?

### Planned scope

- Let `run` optionally report each distinct XState state value.
- Have the CLI print the Machine name and state on entry.
- During a run, update one spinner, state, and elapsed-time line in interactive terminals.
- Collapse each finished state into a short, color-coded timeline entry.
- Capture Agent final text in the CLI instead of printing Agent prose and protocol lines.
- Let `o` expand and hide a bounded live view of normalized Agent activity.
- Display the runner-reported harness, model, and thinking level during every Agent run.
- Require one-line Machine descriptions and surface them through `machine list`.
- Pause live rendering while a Human is typing.
- Present Human suggestions and restricted choices as interactive selectors; only suggestions include `Other…`.
- Keep plain state lines for pipes and CI.
- Keep status presentation read-only; XState remains the only sequencing authority.
- Use this CLI proof to decide whether a Pi extension is still useful and, if so, what it must display.

Current interaction:

```text
$ machine run worktree-task "Add mock scenarios"
◆ worktree-task
  /home/user/.machines/worktree-task.ts

✔ create worktree · 0s
⠹ implement · 31s · [o] activity
```

An active Agent also reports its execution identity beneath the state line:

```text
  pi-acp · openai-codex/gpt-5.6-sol · thinking medium
```

The tracer adds one in-process, harness-neutral Agent update callback for presentation.
It does not add persistence, a wire protocol, or a Pi extension. Those require evidence
from this proof.

### Manual proof

- Run the worktree Machine from an interactive terminal.
- Confirm the current state and elapsed time update without appending lines.
- Confirm Agent prose and protocol output do not obscure the Machine timeline.
- Confirm the live line pauses while Human input is active.
- Complete Human review and one feedback loop.
- Decide whether this is enough visibility and what a Pi widget would still need.

### Exit criteria

- The CLI always makes the authoritative current state visible.
- Silent work looks active without inventing fake progress.
- Status output observes the Machine and cannot drive transitions.
- The user decides whether to proceed to a Pi extension.
- The user marks the phase proven.

### Evidence and adjustments

- Automated evidence: `npm run check` passes type-checking and thirty-five tests, including authoritative state ordering, Human input lifecycle markers, restricted choice validation, ACP output capture, harness-neutral Agent identity/activity updates without protocol JSON, and required validated discovery descriptions.
- Dev Machines evidence: six disposable-repository tests pass, including direct approval, on-demand review details, free-form revision feedback, merge and cleanup, and dirty-source refusal.
- Terminal evidence: A real `pi-acp` TTY proof showed one updating cyan Agent line, its `pi-acp`, `openai-codex/gpt-5.6-sol`, and `medium` thinking identity, expanded live shell-tool activity with `o`, hid it again with `o`, collapsed the state into one green completion line, and kept protocol JSON off-screen. Separate TTY proofs confirmed restricted choices omit `Other…`, suggestions retain it, and raw hotkey mode is restored afterward.
- Human proof: Pending
- Pi usability notes: `quietStartup` in Pi-owned settings removes the injected startup block. CLI capture also keeps Agent prose, the separate Pi update notice, and `MACHINES_EVENT` off the main display. The selected workflow may surface a compact summary and let the Human request full details.
- V1 decision: Pending

## Phase 10: Named Agent runners and user bindings

**Tracer bullet:** This phase proves one Machine can select two semantic Agent roles and
escalate between different supplied runners by adding only static role names, one resolved
runner map, and one global/project TypeScript binding convention.

### Demonstrated pressure

A reviewer may begin with Antigravity and Gemini Flash, then escalate after repeated
failures to Claude Code and Opus. Changing only `model` on one fixed runner cannot express
that policy, while passing provider configuration through every FSM state would couple the
Machine to harness mechanics.

### Scope

- Add `using` to an Agent state; omission selects `default`.
- Replace the singular Run dependency with an exact name-to-`AgentRunner` map.
- Keep the request received by each runner unchanged: prompt, working directory, and
  allowed outcomes only.
- Discover `~/.machines/agents.ts` and the nearest project `.machines/agents.ts`.
- Let project bindings replace matching global names.
- Reserve `agents.ts` for bindings so Machine discovery ignores it.
- Require named CLI Machines to export one-line `agentRoles` descriptions.
- Validate binding modules, declared roles, used roles, and missing runners before the
  XState actor starts.
- Keep a second exact runtime lookup and the existing event/outcome validation.
- Preserve current CLI behavior by supplying its ACP Pi runner as `default`.

The binding file is ordinary TypeScript. It default-exports a function that receives the
launcher's installed adapter constructors. Phase 10 returned named `AgentRunner` functions;
Phase 11 wraps each runner in one described preset. This avoids requiring a globally linked
Machines package to be resolvable from `~/.machines`.

### Manual proof

1. Run `npm run example:agents` and observe two fast reviews followed by one strong review.
2. Create a Machine declaring one named role without configuring it.
3. Confirm `machine run` names the missing role and its description before any Operation
   executes.
4. Add that role to a project `.machines/agents.ts` and confirm the Machine completes.
5. Add the same role globally and locally with distinguishable fake outcomes; confirm the
   project binding wins.

### Exit criteria

- FSM states, rather than runners, visibly own escalation policy.
- A selected runner can change harness, model, thinking, and Agent directory without
  changing the Machine interface.
- Every missing dependency fails before Machine side effects begin.
- Named runner configuration stays outside Machine input and Agent requests.
- The user judges the role declaration, binding file, and error output understandable.

### Explicitly absent

Serialized Agent specifications, provider or capability registries, dynamic role names,
automatic retries, process-crash recovery, model catalogues, persistence, and Pi extension
launching.

### Evidence and adjustments

- Automated evidence: `npm run check` passes type-checking and forty-two tests. Tests prove
  exact named selection, unchanged runner requests, project-over-global bindings, invalid
  binding errors, reserved binding-file discovery, and preflight before the first Operation.
- Deterministic proof: `npm run example:agents` invokes `fastReviewer` twice, switches to
  `strongReviewer`, and reaches `done`.
- Human proof: Pending.

## Phase 11: Discoverable Agent presets and one-run rebinding

**Tracer bullet:** This phase lets a CLI caller or an Agent conversation inspect the
available Agent presets and replace one Machine role for one invocation, without passing
harness configuration through the Machine or changing the runtime API.

### Scope

- Make every entry in `agents.ts` a preset with a required one-line `description`, one
  `runner`, and optional `harness`, `model`, and `thinking` discovery labels.
- Add `machine agents` using the same global/project resolution as Machine runs.
- Let `machine run` accept repeatable `--agent role=preset` options before its input.
- Preserve exact-name binding as the default: a preset named `strongImplementer` satisfies
  the `strongImplementer` role without an override.
- Validate malformed presets, unknown roles, unknown presets, duplicate overrides, and
  missing dependencies before the first Machine Operation runs.
- Keep `AgentRequest`, `AgentRunner`, Machine definitions, and XState execution unchanged.

Example:

```bash
machine agents
machine run worktree-task \
  --agent strongImplementer=opusImplementer \
  -- "Implement the dashboard"
```

Pi and other coding Agents can use `machine list` and `machine agents` for discovery, then
invoke the same CLI. A dedicated Pi extension remains separate because genuinely async
launch, Human attention, status, and takeover need one coherent supervision design; a
blocking tool wrapper would not prove that experience.

### Manual proof

1. Configure at least two described presets in `~/.machines/agents.ts`.
2. Confirm `machine agents` shows both presets, their optional identity labels, and source.
3. Run a Machine with `--agent default=<alternate-preset>` and confirm the alternate runner
   identity appears in the live widget.
4. Try an unknown role and unknown preset; confirm both fail before Machine work begins.
5. Ask an Agent to discover and choose a Machine and preset using only the two list commands.

### Exit criteria

- Humans and Agents can see what presets exist and why they would choose each one.
- A one-run choice is an alias from a Machine role to a configured preset, not an inline bag
  of provider options.
- Global, project, and one-run precedence is explicit and validated.
- The user judges the CLI invocation and error messages understandable.

### Explicitly absent

Arbitrary inline harness/model objects, provider schemas, capability matching, persistence,
async supervision, and a Pi extension.

### Evidence and adjustments

- Automated evidence: `npm run check` passes type-checking and forty-four tests. Tests prove
  required preset descriptions, optional identity metadata, project-over-global preset
  resolution, Agent listing, one-run rebinding, and failure before Operations for unknown
  roles or presets.
- Human proof: Pending.

## Phase 12: Async Pi extension

**Tracer bullet:** This phase proves a Pi conversation can discover, start, observe, and
respond to multiple same-session Machine runs without blocking by adding one headless Human
adapter, one shared launcher, one proven run container, and one optional Pi interface.

The complete phased design, tool shapes, selected run container, ownership rules, UX,
lifecycle limits, tests, and manual dogfood proof are in
[`PI_EXTENSION_PLAN.md`](./PI_EXTENSION_PLAN.md).

Phase 12A through Phase 12C are proven. Phase 12D's real conversational dogfood run is
implemented and awaiting the user's UX judgment. Each active run uses one child
host; do not add a worker pool before measured memory pressure requires it. In particular,
do not collapse the interface into a blocking
`machine run` tool or add persistence, cancellation semantics, multiplexer takeover, tickets,
or workflow cleanup to the Pi interface.

Phase 12A automated evidence: `npm run check` passes type-checking and 49 tests. The tests
cover injected and terminal Human runners, restricted-choice enforcement, validated Machine
and Agent discovery, single-use prepared runs, and matching CLI/launcher preflight failures.

Phase 12B automated evidence: `npm run check` passes type-checking and 56 tests. The host
starts asynchronously after shared preflight, keeps concurrent Human requests separate,
reports Agent updates, distinguishes workflow failure from unexpected exit, and can be
terminated by its owner.

Phase 12C automated evidence: `npm run check` passes type-checking and 61 tests. Five focused
extension tests cover exact tool registration and guidance, Machine and Agent discovery, two
concurrent waiting child hosts, exact-id response routing, compact/expanded rendering,
notifications, and shutdown cleanup. Pi 0.84.4 also loads the globally symlinked extension
and all five TypeBox tools in RPC mode without an extension error. In a real model-driven
proof, Pi discovered Machines and Agent presets concurrently, started two deterministic runs
in parallel, and reported both paused at their separate Human prompts; session shutdown left
no host processes behind.

Phase 12D dogfood evidence: From a real Pi conversation, `worktree-task` started in a
disposable repository and returned immediately. Pi answered an unrelated question while its
Agent worked, surfaced Human review, routed free-form revision feedback by exact run id, then
routed approval. The Machine produced two commits, fast-forwarded `main`, removed its
temporary worktree, and finished `done`; all seven dogfood tests passed. The proof exposed one
presentation defect: ACP stream fragments made `Recent` status unreadable. The Pi extension
now omits raw activity and reports only stable state, Agent identity, Human requests, and
terminal errors. A later fuzzy-routing probe inspected four Machines, rejected every poor
match, proposed a six-state reusable workflow, and created or started nothing. A real Pi
screenshot then showed that Human suggestions still required a parent-model turn and the
widget blended into chat. Native Pi selectors/input now respond directly to the exact waiting
host, canceled dialogs retain the conversational fallback, concurrent dialogs are serialized,
and a subtle frame separates the bottom-pinned widget from chat. Pi 0.85's real RPC UI
protocol confirmed that selecting `approve` completed a child without `machine_respond` or
another parent Agent turn.

## Phase 13: Codex interface

**Tracer bullet:** Prove Codex can use Machines without a Codex-specific runtime by exposing
the existing launcher and child host through five MCP tools, then layering one optional live
card over the same status and response calls.

The MCP server owns only current-session run ids and observation snapshots. Codex CLI uses
the text/structured tool results. Hosts with MCP Apps support may render the resource attached
to `machine_start`; its choice buttons and free-form input call `machine_respond` directly.
The runtime, Machine definitions, Agent runners, and Pi extension remain unchanged.

Unlike Pi extensions, MCP calls do not receive a trusted per-call working directory. The
three discovery/launch calls therefore take one explicit absolute project `cwd`; status and
response use only the exact run id. This keeps project selection visible without adding a
config file, ambient process assumption, or another registry.

### Evidence and adjustments

- Automated evidence: `npm run check` passes type-checking and 66 tests. Three MCP tests
  prove the exact five-tool surface, optional MCP Apps resource, explicit project validation,
  discovery, asynchronous hosted start, restricted-choice rejection, direct response, and
  final-state observation.
- Plugin evidence: the Codex plugin manifest passes the official local validator and is
  installed from the personal marketplace through a development symlink.
- The plugin explicitly pre-approves its five launcher tools. A real Codex CLI probe caught
  the default side-effect approval gate before release; that duplicate ceremony belongs to
  neither the interface nor the Machine and is disabled in the plugin-owned MCP config.
- Real Codex CLI evidence: a fresh non-interactive session discovered the local `review`
  Machine, started it without an approval prompt, observed its restricted Human request,
  responded `approve`, observed `done`, and exited without leaving a host process behind.
- Human proof: Pending in a new Codex desktop thread.

### Explicitly absent

A second workflow engine, durable runs, a shared daemon, desktop-only execution paths,
automatic approvals, cancellation policy, multiplexer takeover, and UI-owned run state.

## V1 completion condition

V1 is complete only when Phases 9 through 11 are proven by the user. Passing tests, reaching a final XState state, or demonstrating the CLI is insufficient if the experience remains confusing.

## Deferred capabilities

These are intentionally outside the initial plan:

- persistence and crash recovery;
- tickets, Beads, and unattended scheduling;
- parallel states and child Machines;
- Machine inheritance or implicit composition;
- plugin and provider registries;
- resumable Agent threads;
- remote execution;
- exact execution manifests;
- generic approval frameworks;
- automatic worktree cleanup;
- compatibility with DNA repositories.

A deferred capability may be proposed only with:

1. a concrete failed or painful scenario from a proven phase;
2. the smallest interface change that resolves it;
3. a new manual proof;
4. an explicit update to this plan before implementation.

## Open decisions

These decisions are deliberately postponed until their phase supplies evidence:

| Decision | Earliest decision phase | Current position |
|---|---:|---|
| Exact public helper shapes | 1-3 | Keep each phase's addition minimal |
| Pi Agent invocation mechanism | 4 | Proven with Pi's non-interactive JSON stream and one terminating `return_event` extension |
| Machine file extension and loading mechanism | 5 | Typed `.ts` default factory, modeled after Pi extensions, loaded directly without compilation |
| CLI input convention | 5 | One string formed from the arguments after the exact file path |
| Exact global directory convention | 6 | User chose `~/.machines/`; projects use the nearest `.machines/` |
| Pi command, tool, or extension interface | 9 | Phase 12D proves the five async tools through a real revision-and-approval conversation; user UX acceptance remains |
| Persistence | After V1 | Do not implement without demonstrated loss |

## Plan change log

| Date | Change | Reason |
|---|---|---|
| 2026-09-04 | Added the five-tool Codex MCP adapter and optional live status/response card | Codex CLI and desktop can share the existing headless host while presentation remains optional and workflow policy stays in the Machine |
| 2026-09-04 | Routed Human options directly through native Pi dialogs and framed the widget | Explicit selections should reach the waiting Machine without a parent Agent turn; the screenshot also showed the status area needed visual separation |
| 2026-09-04 | Added fuzzy Machine routing and confirmed-creation guidance | Pi may select an existing Machine autonomously, while new persistent workflow policy remains an explicit Human choice |
| 2026-09-03 | Completed the Phase 12D real conversational dogfood run and removed raw activity from Pi status | Pi stayed usable during Agent work and correctly routed revision and approval, but token-delta fragments were noise rather than status |
| 2026-09-03 | Implemented the Phase 12C Pi extension tracer and global development symlink | Five tools are enough to discover, start, observe, and answer concurrent same-session runs; Pi owns presentation while each child-hosted Machine keeps workflow authority |
| 2026-09-03 | Implemented the Phase 12B one-run child host tracer | One process per active run keeps ownership, output attribution, Human routing, and failure isolation literal; pooling remains deferred until actual memory pressure appears |
| 2026-09-02 | Implemented Phase 12A and reopened the run-container choice for a focused 12B comparison | The CLI and future Pi interface now share validation and can inject Human input; child isolation should be earned by reproduced lifecycle or output failures rather than assumed |
| 2026-09-02 | Planned Phase 12 as an async Pi extension with one isolated host per run | A blocking CLI wrapper cannot support concurrent conversational use, and in-process execution would conflict with Pi stdin/stdout and teardown; private IPC preserves one XState authority while enabling Human responses |
| 2026-09-02 | Implemented the Phase 11 preset discovery and one-run rebinding tracer | CLI and conversational Agent callers need to inspect user preferences and swap one semantic role without editing a third-party Machine or passing provider options through it |
| 2026-09-02 | Implemented the Phase 10 named-runner tracer | A real escalation may replace Antigravity and Gemini with Claude Code and Opus; static role names plus user-owned bindings keep that policy in the FSM without passing harness configuration through states |
| 2026-09-01 | Split Human selector input into unrestricted `suggestions` and restricted `choices` | A flow sometimes needs only declared outcomes; `Other…` now appears only when free-form input is explicitly preserved |
| 2026-09-01 | Added harness-neutral Agent identity updates and displayed harness, model, and thinking beneath active Agent states | The widget should describe the selected runner without coupling presentation to ACP; ACP is only the first translator into the generic Agent update interface |
| 2026-08-31 | Replaced appended heartbeats with one `yocto-spinner` status line and paused it for Human input | The first real user run showed that repeated heartbeat lines and Pi startup output made the flow noisy; current Yocto coordinates direct stdout/stderr writes with one dependency |
| 2026-08-31 | Implemented Phase 9's first run-visibility tracer | The real Phase 8 run had multi-minute silent ACP periods; one optional state observer and a CLI heartbeat expose honest liveness without adding a second state machine or speculative Pi protocol |
| 2026-08-30 | Marked Phase 8 Proven after a full dogfood run | Real Pi implementation, one advisory review, two Human feedback revisions, approval, fast-forward merge, cleanup, and final completion all succeeded through the installed global Machine |
| 2026-08-30 | Implemented Phase 8 and moved it to Awaiting human proof | The single Dev Machines workflow now owns worktree creation, implementation, one review, Human feedback, fast-forward merge, cleanup, and completion policy |
| 2026-08-30 | Marked Phase 7 Proven | The user ran the real Pi ACP example, inspected its output, and authorized continuation to the real workflow |
| 2026-08-30 | Created the independent Dev Machines repository and assigned Phase 8 workflow policy to it | Shared workflow definitions should be versioned separately from the Machines runtime and installed alongside definitions from other sources |
| 2026-08-30 | Inserted and implemented Phase 7 ACP Agent Adapter | The user chose to prove a generic ACP-to-AgentRunner Adapter with Pi before building the full worktree Machine |
| 2026-08-30 | Marked Phase 6 Proven | The user confirmed named global and project discovery worked and requested the next phase |
| 2026-08-30 | Implemented Phase 6 and moved it to Awaiting human proof | One resolver provides visible named list/show/run behavior with local precedence, global fallback, and file or directory Machine forms |
| 2026-08-30 | Marked Phase 5 Proven and tagged `phase-05-proven` | The user accepted typed exact-path loading and authorized global/project location logic |
| 2026-08-30 | Revised Phase 5 from `.mjs` to Pi-style typed `.ts` Machine files and fixed the Phase 6 locations | The user asked for TypeScript authoring in `~/.machines/` and project `.machines/` directories |
| 2026-08-29 | Implemented Phase 5 and moved it to Awaiting human proof | One executable loads an ordinary Machine factory from an exact visible path and runs it with real Pi |
| 2026-08-29 | Marked Phase 4 Proven and tagged `phase-04-proven` | The user explicitly authorized Phase 5 after the Phase 4 handoff |
| 2026-08-29 | Implemented Phase 4 and moved it to Awaiting human proof | Real Pi creates one file, returns one constrained event, and an Operation verifies the result end to end |
| 2026-08-29 | Marked Phase 3 Proven and tagged `phase-03-proven` | The user explicitly authorized Phase 4 after the Phase 3 handoff |
| 2026-08-29 | Implemented Phase 3 and moved it to Awaiting human proof | One supplied fake Agent receives a bounded request and returns an event through XState's native actor provisioning |
| 2026-08-29 | Marked Phase 2 Proven and tagged `phase-02-proven` | The user explicitly authorized Phase 3 after the Phase 2 handoff |
| 2026-08-29 | Implemented Phase 2 and moved it to Awaiting human proof | The terminal Human tracer bullet accepts unrestricted input, exposes it on `submitted`, and fails clearly on closed input |
| 2026-08-29 | Marked Phase 1 Proven and tagged `phase-01-proven` | The user authorized work on Phase 2 after the Phase 1 handoff |
| 2026-08-29 | Implemented Phase 1 and moved it to Awaiting human proof | The Operation tracer bullet passes its automated checks; Phase 2 remains blocked on user assessment |
| 2026-08-29 | Added the tracer-bullet simplicity directive and gate | Make future phases prove current behavior before admitting abstractions or speculative machinery |
| 2026-08-29 | Created the greenfield phased plan | Establish a proof-driven path without reusing or renaming DNA code |
