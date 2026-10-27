# Architecture

Machines separates workflow decisions from execution and presentation. A Machine
can say “review after implementation” without knowing whether an Agent uses ACP,
a Human uses a terminal, or a run is displayed in Codex.

## Vocabulary and ownership

| Concept | Responsibility |
| --- | --- |
| Machine | Finite-state policy mapping returned events to the next state |
| State | Named position invoking one Agent, Human, or Operation, or a final state |
| Agent | Bounded request implemented by an `AgentRunner` |
| Operation | Trusted local function returning an event |
| Human | Input request returning `submitted`, or an explicitly enabled `question` event |
| Run | One execution of a Machine |
| Adapter | Mechanism connecting a primitive or run to an external interface |

XState owns transitions and actor lifecycle. Each primitive returns a semantic
event; the active state declares its accepted event types. Adapters return events
and report observations. Destination states stay in the Machine definition.

Workflow-specific retries, escalation, approval, merging, and cleanup belong in
Machines. Add shared runtime behavior when multiple real workflows require the
same mechanism and cannot reasonably own it themselves.

## Module boundaries

```text
CLI ──────────────────────→ launcher → runtime → AgentRunner / HumanRunner
Pi extension ──┐                          ↑
               ├─→ session → child host ─┘
MCP server ────┘       ↑
                      └── snapshots and notifications → adapter presentation
```

| Module | Owns |
| --- | --- |
| `src/index.ts` | Typed primitives, Machine validation, XState execution, observer contracts |
| `src/conversation.ts` | Compound Human/clarification state; the owner supplies the original session responder |
| `src/terminal-human.ts` | Default terminal Human input, selectors, raw-mode restoration |
| `src/machine-module.ts` | Shared module contract and metadata validation |
| `src/catalog.ts` | Definition and preset catalog reads |
| `src/acp.ts` | ACP process/session protocol, bounded Agent result, normalized activity |
| `src/agy.ts` | Antigravity CLI (agy) process protocol, bounded Agent result, normalized activity |
| `src/chatgpt-web.ts` | ChatGPT web conversation over the DevTools protocol, rig-bridge workspace prompt, bridge activity |
| `src/claude.ts` | Claude Code CLI headless execution, final-result decoding, permission options, normalized activity |
| `src/codex.ts` | Codex CLI execution, final-response decoding, sandbox options, normalized activity |
| `src/deepseek.ts` | DeepSeek Harness command/profile configuration over the shared ACP runner |
| `src/decision.ts` | Provider-neutral classification contract, validated outcome events, normalized observations |
| `src/jev.ts` | TypeSafe Choice HTTP transport, authentication, model selection, and bounded requests |
| `src/openrouter.ts` | OpenRouter Decisions Choice transport, independent credentials, optional result metadata |
| `src/laya.ts`, `src/von.ts` | Self-hosted Choice providers with independent configuration |
| `src/system-one-http.ts` | Shared bounded HTTP transport for the self-hosted providers |
| `services/laya/server.py` | Opt-in, externally managed single-checkpoint Python Choice bridge |
| `src/agent-protocol.ts` | Shared Agent prompt instructions and Machines event decoding |
| `src/agent-session.ts` | Named Agent session records, the continue-or-fresh decision for one call, and its evidence |
| `src/agent-limit.ts` | Typed provider usage-limit error and its recognition across module copies |
| `src/agent-limits.ts` | Limit-aware runner: fallback order, handoff note, reset waiting, per-run memory of limited presets, report-only requests, sessions kept by another preset |
| `src/discovery.ts` | Project/global definition locations and precedence |
| `src/agent-profiles.ts` | Named JSON profiles, atomic activation snapshots, strict provider filtering and scoped tuning |
| `src/agent-tuning.ts` | Public runner capability contract; adapters validate and construct tuned runners |
| `src/provider-order.ts`, `src/state-json.ts` | Legacy preference precedence and shared atomic user-state replacement |
| `src/launcher.ts` | Definition metadata, Agent bindings, preflight, single-use launch preparation |
| `src/discovery-worker.ts` | Fresh metadata imports in disposable workers |
| `src/host.ts` | One child run, IPC, Human request identity, owned process termination, run-status publication for the run |
| `src/session.ts` | Shared Pi/MCP run lifecycle, snapshots, response handling, retention, shutdown |
| `src/run-status.ts`, `src/run-watch.ts` | The run-status directory rule, one record per published run, session identity, and each session's watch list |
| `src/run-viewer.ts` | Which published runs one viewer shows; exported with the readers as `@dna113p/machines/run-status` |
| `src/cli.ts` | Command parsing, terminal progress, source inspection |
| `pi-extension/index.ts` | Pi tools, widgets, notifications, native input presentation |
| `pi-extension/wake.ts` | Session-scoped wake registrations, actionable snapshot events, cancellable busy delivery, persisted delivery identities |
| `mcp/server.ts` | MCP schemas, tool results, and the optional HTML resource |
| `codex/machines/ui/machines.html` | Status rendering and submission of the current Human request |

## Discovery and launch

Discovery combines the nearest project directory with the global directory. Each
listing uses a disposable worker so edits to definitions, presets, and imported
helpers are visible without restarting the interface. An invalid definition has
an `error` in its listing; valid definitions remain available. The CLI displays
all entries and exits unsuccessfully if any definition is invalid.

Workers isolate module caches and ordinary output, not file or network permissions.
Importing metadata still executes code. Definition factories run during launch
preparation, so side effects that require a successful preflight belong inside an
Operation rather than the factory.

The launcher resolves required semantic Agent roles and configured presets before
starting the actor. Missing bindings, invalid overrides, or invalid definitions
fail preflight. It then wraps each role's runner so that a usage limit swaps to
the bound preset's allowed fallbacks or waits for the reset; the runtime still
receives one runner per role. An Agent state that names an `onLimit` event keeps
that policy in the Machine: the runtime asks the runner to report the limit and
delivers it as the event, and the wrapper neither swaps nor waits for that
request. Preparation also snapshots an unexpired named profile. Its strict provider filter
intersects each role's configured chain before any runner can execute, including
report-only requests. Model tuning uses an explicit capability on the runner;
adapters own validation and construct fresh runners. The launcher has no provider
option switch. Expiry or deactivation affects newly prepared runs, not an existing
prepared run or its child Machines. Checkpoint continuation prepares a new run and
therefore resolves current settings. The resulting prepared run can be started once. Long-lived hosted
runs get a fresh child process; direct runtime users own their own definitions.

## Session and process lifecycle

Pi and MCP delegate to the same session module. The session owns hosts from the
start of launch, keeps authoritative snapshots, and closes permanently. Presentation
adapters subscribe to changes and format them for their own surfaces.

Each pending Human prompt has a unique request ID. A response names both the run
and that request. Claiming a request before asynchronous delivery prevents two
answers from being accepted, and the identity prevents a stale card or dialog from
answering a later prompt. Restricted choices are validated for every interface.

`machine run` asks on its own terminal. Run-status publication is on unless
`MACHINES_RUN_STATUS_DIR` turns it off, in a private per-user directory that
every reader and writer finds by one rule (`runStatusDirectory`; the standalone
status line carries a tested copy). It is presentation and never changes a run:
a run that cannot write its first record is simply not published. With
publication on, `machine run` also
publishes the pending request and its request ID, and takes the first valid
response from either the terminal or a private per-run inbox file written by
`machine respond`; the MCP session takes inbox responses through the same
session `respond` path as its tool, and inbox questions through the session's
`ask`. The inbox is a second way to deliver a response to the owning run, not a
second owner: the run still validates the request ID and choices, and a response
to any other request is discarded. A run hosted directly through
`startMachineHost` publishes its status only when its host asks, and without an inbox: its host remains the
only way to answer it, its record says so, and `machine respond` refuses it. See
[Integrations](integrations.md#answering-a-waiting-run-from-outside).

A session's watch list changes only which published runs its status line shows.
It gives no ownership of a run and no way to answer one.

Pi wake registration is separate from watch lists and execution ownership.
The extension registers each spawned run on the session's first synchronous
snapshot, before child Human or terminal callbacks. Explicit `machine_attach`
registrations observe published external runs with the same target matching as
watches, without admitting them to `MachineSession`. `machine_status` reads
attached records independently of widget retention; response and termination
remain with the original owner.

The wake adapter selects completion, failure, and unanswered Human requests,
and deduplicates by execution/continuation and request identity. It retains busy
events locally until Pi's `agent_settled`. A manual compaction outcome permits
idle recovery without that event. Tree navigation permits recovery when Pi clears
its branch-summary busy state, including failure and cancellation without an
outcome event. Neither path clears an agent barrier; automatic compaction and new
agent activity still require settlement. The adapter retains registered spawned terminal snapshots
through delivery until detach or shutdown, independently of the session's five-run
terminal cache. It reconciles current snapshots to discard answered or obsolete
Human requests, then rechecks the bound session before handing
off `sendMessage` with `triggerTurn` and `followUp`. Pi starts continuation;
Machines neither polls through its model nor starts another agent process.
Session entries persist delivery receipts, not active registrations. Detach
cancels uncovered queued events; shutdown/replacement closes the registration
generation and polling resources. A new runtime requires renewed attachment.
No wake event supplies a Human answer or changes Machine policy. See
[wake registration and its limits](integrations.md#wake-the-coordinating-pi-session).

Which runs a viewer shows is one rule, `runsForViewer` in `src/run-viewer.ts`:
`machine runs --for` prints its answer, and `@dna113p/machines/run-status`
exports it with the readers, so that an application draws its own widgets
without a second copy. It selects and orders; presentation stays with whatever
draws. The standalone status line cannot load it and carries a tested copy, as
it does of the directory rule. See
[Integrations](integrations.md#drawing-your-own-widgets).

Closing a session terminates active and starting hosts. Host termination includes
ordinary descendants in the host's owned process group on POSIX and process-tree
termination on Windows. Deliberately detached processes can escape normal ownership;
Machines should await work they own and avoid launching untracked background jobs.
Abrupt operating-system termination cannot guarantee cleanup. Stopping processes
also cannot reverse a completed external action.
The automated process-lifecycle checks run on Linux; the Windows termination path
has not been exercised in this environment.

Human drafts and focus belong to the presentation adapter while the request ID is
unchanged. The card polls authoritative status; it does not decide transitions or
persist a second copy of the workflow state.

## Discussion-capable Human states

Existing Human runners may still return strings. An opt-in request with
`discussion: true` additionally permits `{ type: "question", text }`; its Human
state must explicitly handle `question`. Questions never bypass restricted
choices or become implicit approvals. The public host's `ask(question, requestId)`
claims the exact current request separately from `respond(answer, requestId)`.
The child emits the Machine event; the adapter never chooses a destination state.

`@dna113p/machines/conversation` exports `conversation(options, on)`, authoring
sugar for a bounded Human -> owner-supplied clarification -> Human loop. It keeps
one pending decision, accepts a final explicit answer, and delegates its outcome
to the surrounding Machine. Its reply callback owns the agent/session reference;
the helper does not create an assistant or promise that another call to the same
Agent role resumes the original native session. For arbitrary clarification
policies, use ordinary `human`, `agent`, and `operation` states instead.

Drip uses this public host/runtime boundary to show every Machine run and route
its Human steps through a shared web/CLI focus. Existing Pi/MCP presentation
adapters remain answer-only unless they explicitly implement the question channel.
The default terminal Human selector is also answer-only; Drip's `chat` command
provides the discussion-capable terminal surface, and `machine respond --question`
sends a question to a published run, started by `machine run` or hosted by the
MCP server, whose request allows discussion.

## Distribution

Development runs source TypeScript on Node 24. `npm run build` emits JavaScript and
declarations under `dist/`, rewrites relative TypeScript import extensions, and
copies UI assets at the same relative paths used by the server. The npm package
exports built entry points so runtime loading works inside `node_modules`.

`npm run build:plugin` assembles a self-contained directory with built code, UI,
authoring instructions, and production dependencies. It needs Node on PATH but
has no dependency on the source checkout after copying. Packaging smoke tests
exercise a real installed tarball and a relocated plugin, including discovery,
the MCP widget resource, and a hosted Human response.

The earlier implementation plans are retained in the repository's
[history directory](https://github.com/dna113p/machines/tree/main/docs/history) for rationale.
Their phase ordering and manual proof gates describe past work.

## External execution owners

The supported `@dna113p/machines/host` export exposes `startMachineHost`, the
run's id, its observations, correlated Human responses, termination, and final
state/output.
External applications can own hosted runs without importing private modules or
parsing terminal output. Hosted input and optional output are JSON values.

Ticket discovery, persistence, scheduling, and tracker updates belong to the
separate `machines-dispatch` application. Machines has no dependency on ticketing.
External owners decide how to interpret output; a final state alone does not
prove that a ticket should close.
