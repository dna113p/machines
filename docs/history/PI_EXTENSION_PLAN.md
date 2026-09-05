> Archived implementation history. Current contributor guidance is in [AGENTS.md](../../AGENTS.md), and current design constraints are in [Architecture](../architecture.md). Phase gates below describe the original development process and are not requirements for new changes.

# Machines Pi extension implementation plan

**Status:** Phase 12D implemented; awaiting human UX proof

**Date:** 2026-09-03

## The outcome

From a normal Pi conversation, the model can discover Machines, start more than one run,
inspect their real state, and deliver an explicit Human response. Starting a Machine returns
immediately. A compact Pi widget continues to show the authoritative XState state while the
conversation remains usable.

The intended interaction is:

```text
Human: Build the dashboard and update its tests.

Pi: [discovers Machines and Agent presets]
Pi: [starts two appropriate Machines]

┌ Machines
│ ◆ 8f31  worktree-task    implement   1m 14s
│   pi-acp · gpt-5.6-sol · thinking high
│ ◆ a921  test-task        review      42s
└

...the Human and Pi can keep talking...

┌ Machines
│ ◇ 8f31  worktree-task    input needed
│   Review the implementation before merging.
└

Human: The implementation looks good, but fix the empty state first.
Pi: [calls machine_respond for run 8f31 with that feedback]
```

No extension approval layer is added. The selected Machine owns worktrees, reviews, merge,
cleanup, and every other safety or immutability policy.

## Non-negotiable requirements

- A start tool returns after validation and launch, not after the Machine finishes.
- Multiple runs can be active at once.
- XState remains the only workflow authority.
- Human input can be discussed naturally in the parent Pi conversation before it becomes a
  Machine event.
- Machine and Agent discovery use the same global/project resolution and validation as the
  CLI.
- The extension never accepts inline harness, model, environment, or thinking configuration.
  A run may only alias a Machine role to a configured Agent preset.
- Project-local Machine code is considered only in a Pi-trusted project.
- Output stays bounded and compact. Raw Agent output does not become a chat wall.

## Selected run container

Each active run gets one small child host process. Installed and inactive Machines use no
processes. This keeps the mapping literal: one future extension run id owns one child, and the
child owns one prepared XState run.

```text
Pi model
  │ calls tools
  ▼
Machines Pi extension
  │ owns run ids, bounded status, widget, notifications
  │ structured private IPC
  ▼
one Machine host process per run
  │ loads one Machine and Agent presets
  │ runs the existing XState runtime
  ▼
Machine definition + Agent runners
```

This seam earns its keep because:

1. The existing CLI owns terminal stdin. A detached CLI cannot safely receive a later Human
   response from Pi.
2. Machine and Agent stdout cannot interfere with Pi's TUI.
3. A child process gives every concurrent run its own stdout, stderr, Agent processes, Human
   request, and failure lifecycle. IPC carries structured events without parsing display text.

No measured memory pressure justifies a worker pool yet. A pool would add run multiplexing,
shared failure, and output attribution. Phase 12B therefore keeps the direct process-per-run
mapping and leaves later optimization evidence-driven.

### Approaches and current status

| Approach | Current status |
|---|---|
| Await `machine run` inside `machine_start` | Blocks the Pi turn and prevents concurrent conversational use |
| Spawn the current CLI and parse its output | Presentation text is not a protocol; Human stdin and reliable state are unavailable |
| Start a prepared run in-process | Rejected for the first Pi tracer because Machine output and failure share Pi's process |
| Start a prepared run in a child host | Selected: one process maps directly to one active run and exits at its terminal state |
| Pool several runs in shared workers | Deferred until measured memory pressure justifies multiplexing and shared failure |
| Add persistence immediately | Solves restart recovery before a same-session async run has been proven |
| Put workflow cleanup in the extension | Creates a second policy engine and violates Machine ownership |

## Ownership

### Machines runtime

- Continues to own XState actor execution and event validation.
- Adds one real seam now justified by two adapters: a `HumanRunner` used by the terminal CLI
  and by a headless caller.
- Validates restricted Human choices regardless of adapter.
- Does not know about Pi, tools, widgets, run ids, or child processes.

### Shared launcher module

- Resolves a Machine name from the current directory.
- Imports and validates its description, role declarations, and factory.
- Resolves global/project Agent presets and one-run role aliases.
- Produces a prepared run only after dependency preflight succeeds.
- Is used by both the CLI and the selected Pi run container so their launch semantics cannot
  drift.

### Machine host

- Owns exactly one prepared run.
- Preflights through the shared launcher before starting the XState run.
- Translates state, Agent activity, Human requests, completion, and failure into IPC messages.
- Drains stdout and stderr separately from IPC, so presentation text is never protocol.
- Accepts a Human response only for its currently pending request.
- Exposes termination to its owning interface without defining a Machine cancellation event.
- Does not choose transitions or interpret outcomes.

### Pi extension

- Registers model-callable tools.
- Captures `ctx.cwd` for discovery and launch.
- Assigns run ids and keeps an in-memory run map.
- Renders the widget and sends one-time attention/completion/failure notifications.
- Sends Human responses to the correct run.
- Terminates owned runs during `session_shutdown`, using the lifecycle mechanism selected in
  Phase 12B.
- Does not merge, clean, retry, approve, or decide Machine outcomes.

## Runtime seam: HumanRunner

The runtime addition should be no broader than:

```ts
interface HumanRequest {
  readonly prompt: string;
  readonly choices?: readonly string[];
  readonly suggestions?: readonly string[];
}

type HumanRunner = (request: HumanRequest) => string | Promise<string>;

interface RunOptions {
  readonly human?: HumanRunner;
  // existing Agent and observation options remain
}
```

When omitted, `run()` uses the existing terminal UI. The selected Pi run container supplies a
runner that records the request and waits for `machine_respond`. Choice validation remains
inside the runtime so terminal, Pi, and future adapters obey the same contract.

This does not turn Human into a workflow role or an approval abstraction. It only moves the
input transport behind the seam already occupied by the terminal implementation.

## Shared launcher interface

The CLI currently contains Machine loading, metadata validation, Agent preset resolution,
role aliasing, and preflight. Extract those mechanics without extracting CLI presentation.

The target interface is intentionally small:

```ts
listMachines({ cwd }): Promise<MachineSummary[]>
listAgentPresets({ cwd }): Promise<AgentPresetSummary[]>
prepareMachineRun({ cwd, machine, input, agents }): Promise<PreparedMachineRun>
```

`PreparedMachineRun.start()` accepts the existing observation callbacks plus a Human runner
and returns the existing final XState snapshot. A prepared run is single-use.

Preparation may import trusted TypeScript, but it must not start the XState actor. Therefore
unknown Machines, invalid metadata, missing roles, and bad role-to-preset aliases are returned
from `machine_start` before any Machine state runs.

## Pi tool interface

Use several tiny, explicit tools instead of one action-heavy mega-tool.

### `machine_list`

Input: none.

Returns each resolved Machine's name, description, path, declared Agent roles, and missing
bindings. This is the model-discovery surface corresponding to `machine list`.

Its model guidance routes fuzzy requests without another runtime abstraction: choose an
existing Machine by description; handle a one-off normally; when no Machine fits a reusable
workflow, propose a short state sequence and ask before creating persistent project policy.

### `machine_agents`

Input: none.

Returns each resolved preset's name, description, optional harness/model/thinking labels, and
source. This corresponds to `machine agents`.

### `machine_start`

```ts
{
  machine: string;
  input: string;
  agents?: Record<string, string>; // Machine role -> configured preset
}
```

The tool uses `ctx.cwd`; arbitrary working-directory input is intentionally absent. `machine`
must be a discovered name in the first tracer, not an arbitrary file path. It waits for shared
launcher preflight, starts the selected run container, and returns a compact `RunSnapshot`
immediately. The model may clarify fuzzy Human input, but must preserve its requirements and
scope.

### `machine_status`

```ts
{ runId?: string }
```

With an id, returns one run. Without an id, returns all active runs plus a bounded number of
recent completed or failed runs. It is how the model refreshes facts rather than inferring
progress from elapsed time.

### `machine_respond`

```ts
{ runId: string; response: string }
```

Requires that exact run to be waiting for Human input. Restricted choices are checked before
the pending request is resolved; an invalid response leaves the run waiting. Free-form and
suggested input pass through unchanged.

Native Pi dialogs are the default Human path: choices open a selector, suggestions open a
selector with `Other…` for direct text input, and a prompt without options opens direct text
input. The selected value goes straight to that run's host. Concurrent Human requests are
presented one at a time. Canceling a dialog leaves the run waiting; `machine_respond` remains
the conversational fallback after the Human supplies a clear answer in chat.

Pi requires TypeBox schemas for extension tool parameters. Use TypeBox only at this external
Pi seam; do not introduce Zod or make Pi's schema library part of the Machines runtime.

## Run snapshot

Every tool and widget reads the same extension-owned snapshot:

```ts
interface RunSnapshot {
  readonly id: string;
  readonly machine: string;
  readonly path: string;
  readonly cwd: string;
  readonly status: "starting" | "running" | "waiting" | "completed" | "failed";
  readonly state?: string;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly agent?: {
    readonly harness: string;
    readonly model?: string;
    readonly thinking?: string;
  };
  readonly human?: HumanRequest;
  readonly result?: string;
  readonly error?: string;
}
```

This is observation state, not a second FSM. Its status is derived only from the selected run
container's lifecycle and XState callbacks. It cannot send Machine events except through the
explicit Human response.

The snapshot keeps stable lifecycle information only: state, Agent identity, Human request,
result, and error. ACP output arrives as token fragments, so the Pi status surface does not
store or display it as activity. Harness-specific streaming remains outside this tracer.

## Private host protocol

Use Node's built-in child-process IPC so arbitrary stdout cannot corrupt control messages.

| Direction | Message | Meaning |
|---|---|---|
| extension -> host | `launch` | Discover, preflight, and start one Machine |
| host -> extension | `started` | Preflight succeeded and the XState run started |
| host -> extension | `state` | Authoritative XState state changed |
| host -> extension | `agentUpdate` | Existing harness-neutral Agent update |
| host -> extension | `humanRequest` | Human runner is waiting; includes a unique request id |
| extension -> host | `respond` | Response for that exact pending request |
| host -> extension | `completed` | XState reached a final state |
| host -> extension | `failed` | Preparation or execution failed with a useful message |

Every message is validated with Valibot at receipt. Unexpected order, duplicate responses, a
response for the wrong request, and child exit without a terminal message are explicit
failures. Host stdout and stderr are drained and discarded in this tracer; normalized Agent
updates remain observable.

## Widget and conversational UX

- Use `ctx.ui.setWidget("machines", ...)` above the editor.
- Show one compact line per active run: symbol, short id, Machine, state, and elapsed time.
- Show harness/model/thinking on a second line only while an Agent is active.
- Frame the bottom-pinned widget with Pi's border colors so it is visually distinct from chat.
- Use cyan for running, yellow for Human attention, green for completion, and red for failure.
- Show the Human prompt only for waiting runs.
- Keep a completed or failed final row visible briefly, then remove it automatically.
- Keep active runs visible while Pi is generating or the user is typing.
- Notify once when a run first needs input, completes, or fails.
- Do not inject automatic model turns when background status changes.
- Keep tool call/result rendering compact; detailed status remains available through
  `machine_status`.

When the widget requests attention, a native dialog sends explicit input directly to the
Machine without a parent-model turn. The Human can cancel it to inspect or discuss the run
with Pi; after a clear conversational answer, Pi calls `machine_respond`. This preserves both
the fast direct path and the conversational takeover path.

It is not takeover of the child Agent harness session. Attaching to native Pi, Codex, Claude,
Herdr, or tmux remains an Agent-runner concern and is not added to this extension.

## Lifecycle limits for the first version

- Runs are asynchronous relative to the conversation but live only for the current Pi
  extension session.
- Runs do not survive Pi exit, `/reload`, session replacement, or process failure.
- `session_shutdown` terminates all owned runs and clears the widget.
- Termination has the same recovery limitations as interrupting the CLI. The extension does
  not invent generic cleanup; each Machine remains responsible for safe, recoverable policy.
- There is no public `machine_stop` in the first tracer. Honest cancellation requires a later
  decision about cooperative Agent/Operation abort and Machine cleanup semantics.
- Completed/failed snapshots are held only in bounded memory for the current session.

Persistence, reconnection, unattended daemon execution, and cross-session notifications are
separate capabilities. Add them only after same-session async use demonstrates the need.

## Implementation phases

Each subphase is a tracer bullet and stops for human proof.

### Phase 12A: Headless Human input and shared launch preparation

**Status:** Proven; the user authorized Phase 12B.

**Proves:** one prepared Machine can use either terminal or programmatic Human input while CLI
behavior and validation remain unchanged.

Implement:

- Add `HumanRequest`, `HumanRunner`, and `RunOptions.human`.
- Keep the current terminal input as the default adapter.
- Extract `listMachines`, `listAgentPresets`, and `prepareMachineRun` from the CLI.
- Make the CLI consume the shared launcher without changing its visible behavior.

Proof:

1. Existing tests remain green.
2. A fake Human runner receives prompt/options and resumes a Machine.
3. Invalid restricted input fails consistently.
4. CLI and shared launcher produce identical missing-role and bad-alias errors before an
   Operation marker can be written.

Automated evidence: `npm run check` passes type-checking and 49 tests covering the terminal
default, injected Human input, restricted-choice validation, shared discovery, preparation,
single-use start, and CLI/launcher error parity.

### Phase 12B: One child host per active run

**Status:** Proven; the user authorized Phase 12C.

**Proves:** the simplest run container that keeps Pi conversational can prepare, start,
observe, answer, and finish one Machine safely enough for the first extension tracer.

Implement:

- Add one private host module whose interface starts one child and returns its metadata,
  result promise, Human response method, and owner-only termination method.
- Use the shared launcher inside the child.
- Validate the small IPC protocol with Valibot.
- Drain child stdout and stderr without parsing or displaying them.

Proof:

1. Starting returns before the Machine completes and ordered state updates remain available.
2. A Human request pauses until the matching response arrives.
3. Two runs do not steal state, output, or Human responses from each other.
4. The owning caller can terminate a waiting host.
5. Thrown Operations and unexpected child exits are distinct failures.

Automated evidence: `npm run check` passes type-checking and 56 tests. Seven focused host
tests cover launch metadata, ordered state, restricted Human response, two concurrent hosts,
Agent updates, execution failure, owner termination, unexpected exit, and preflight failure.

### Phase 12C: Pi tools, concurrency, and compact widget

**Status:** Proven; the user authorized Phase 12D after the real concurrency proof.

**Proves:** a real Pi conversation can discover and start multiple Machines without blocking,
and their authoritative states remain visible.

Implement:

- Add the optional Pi extension directory in the Machines repository.
- Register the five tools and concise model guidance.
- Keep one in-memory map keyed by run id.
- Render the compact multi-run widget and one-time notifications.
- Terminate owned runs and clear UI on `session_shutdown`.

Install for development by symlinking `pi-extension/index.ts` to
`~/.pi/agent/extensions/machines.ts`; do not create an umbrella installer or Pi config file.

Proof:

1. `pi -e <extension>` loads with no extension error.
2. Pi uses `machine_list` and `machine_agents` rather than guessing names.
3. Two deterministic Machines remain active concurrently and both appear in the widget.
4. `machine_start` returns while both are still running.
5. `machine_status` matches their XState reports.
6. Reload/session shutdown terminates both runs and clears the widget.

Automated evidence: `npm run check` passes type-checking and 61 tests. Five extension tests
exercise the registered tool interface with real child hosts, including two concurrent Human
waits, exact-id responses, widget lifecycle, compact expansion, notifications, and shutdown.
Pi 0.84.4 loads the globally symlinked entrypoint and all five TypeBox tools in RPC mode
without an extension error. A real model-driven Pi call also discovers Machines and Agent
presets concurrently, starts two deterministic runs in parallel, and reports both waiting at
their separate Human prompts; session shutdown leaves no host processes behind.

### Phase 12D: Conversational Human round trip and real dogfood

**Status:** Implemented; awaiting human UX proof.

**Proves:** the parent Pi conversation can carry a real Machine's Human review without taking
over workflow authority.

Proof first; add only presentation fixes exposed by the proof:

1. Start `implement-review` or `worktree-task` from Pi using a selected Agent preset.
2. Continue an unrelated conversation while the Agent works.
3. Observe yellow attention when the Machine reaches Human review.
4. Ask Pi for status/details, discuss the result, and provide feedback in natural language.
5. Confirm Pi calls `machine_respond` with the exact run id and response.
6. Exercise one revision loop, then approve.
7. For `worktree-task`, confirm merge and cleanup occur before green completion.
8. Start a second Machine during the first run and confirm neither steals the other's Human
   response or status.

Dogfood evidence: A real `worktree-task` launched from Pi in a disposable Git repository and
returned immediately. Pi answered an unrelated question during implementation, notified at
Human review, sent one natural-language revision through `machine_respond`, then sent
`approve`. The Machine fast-forwarded `main`, removed its worktree, reached `done`, and left
seven passing project tests. Phase 12C's two-run proof covers concurrent response isolation.

The only code adjustment from dogfood was subtractive: `machine_status` no longer includes a
`Recent` field. ACP text arrived as token deltas such as JSON punctuation and partial words;
state, Agent identity, Human prompt, and errors are the useful stable status.

A real fuzzy-routing probe asked for a scheduled release-note collection, Agent verification,
Human approval, and publishing workflow. Pi inspected all four available Machines, rejected
the poor matches, proposed `scheduled trigger -> collect -> verify -> approval -> publish ->
report`, and created or started nothing.

A real Pi screenshot then exposed two UX gaps: Human suggestions required a parent-model turn,
and the bottom widget blended into chat. The extension now presents choices and free-form
feedback through native Pi dialogs that respond directly to the exact child host, serializes
concurrent dialogs, and frames the existing bottom-pinned widget. Canceling keeps the prior
conversational path available.

The direct path is proven through Pi 0.85's real RPC UI protocol: a fixture Human request
emitted a selector containing `approve`, `details`, and `Other…`; an `approve` UI response
completed the child immediately without a `machine_respond` tool call or another parent Agent
turn.

Phase 12 is proven only when this feels clearer than launching the CLI directly.

## Test strategy

- Runtime tests cross the `run()` interface with terminal and fake Human adapters.
- Launcher tests cross its three public functions with disposable global/project directories.
- Host tests cross `startMachineHost()` with disposable Machine files and real child IPC.
- Extension tests use a small fake Pi adapter that records registered tools and widget calls;
  do not expose that fake through the production interface.
- One real installed Pi proof verifies official extension loading, TypeBox schemas, tool
  discoverability, concurrent run lifecycles, and TUI rendering.
- Dev Machines tests continue to own Git/worktree/merge/cleanup policy verification.

## Files expected to change

In the independent Machines repository:

- `src/index.ts` — Human runner seam only.
- `src/launcher.ts` — shared discovery, validation, preparation, and launch mechanics.
- `src/host.ts` — one-run child host and its small parent-side handle.
- `machine` — consume the launcher; retain CLI presentation.
- `pi-extension/index.ts` — optional Pi tools and widget.
- focused runtime, launcher, host, and extension tests.
- `README.md`, `PLAN.md`, and this plan as evidence changes.

In Dev Machines only after the interface is proven:

- update `README.md` and the versioned/installed `machine-builder` skill with the exact Pi
  invocation and Human-response behavior.

No source changes belong in the DNA orchestration repository, Dev Machines workflow files,
ticketd, or any Agent harness for this phase.

## Explicitly deferred

- persistence or recovery after Pi exits;
- daemon/background execution independent of Pi;
- a generic cancellation event or cleanup policy;
- native Agent-session attachment, multiplexer panes, or Herdr ownership;
- automatic Human-response inference from arbitrary chat messages;
- automatic model/harness selection or capability matching;
- inline Agent configuration;
- tickets, Beads, scheduling, retries, or approval frameworks;
- remote execution and cross-device notifications.

## Decisions to revisit only after dogfood

1. Is same-session lifetime enough, or did a real run get lost on reload/exit?
2. Is `machine_status` sufficient for detail, or is an interactive `/machines` overlay useful?
3. Is explicit `machine_respond` understandable when multiple runs wait simultaneously?
4. Do users need cooperative cancellation badly enough to define runtime abort semantics?
5. Does any real Agent runner expose a session attachment target worth adding to
   harness-neutral Agent updates?
