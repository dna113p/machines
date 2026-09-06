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
| Human | Input request returning a `submitted` event with the response |
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
| `src/terminal-human.ts` | Default terminal Human input, selectors, raw-mode restoration |
| `src/machine-module.ts` | Shared module contract and metadata validation |
| `src/catalog.ts` | Definition and preset catalog reads |
| `src/acp.ts` | ACP process/session protocol, bounded Agent result, normalized activity |
| `src/agy.ts` | Antigravity CLI (agy) process protocol, bounded Agent result, normalized activity |
| `src/agent-protocol.ts` | Shared Agent prompt instructions and Machines event decoding |
| `src/discovery.ts` | Project/global definition locations and precedence |
| `src/launcher.ts` | Definition metadata, Agent bindings, preflight, single-use launch preparation |
| `src/discovery-worker.ts` | Fresh metadata imports in disposable workers |
| `src/host.ts` | One child run, IPC, Human request identity, owned process termination |
| `src/session.ts` | Shared Pi/MCP run lifecycle, snapshots, response handling, retention, shutdown |
| `src/cli.ts` | Command parsing, terminal progress, source inspection |
| `pi-extension/index.ts` | Pi tools, widgets, notifications, native input presentation |
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
fail preflight. The resulting prepared run can be started once. Long-lived hosted
runs get a fresh child process; direct runtime users own their own definitions.

## Session and process lifecycle

Pi and MCP delegate to the same session module. The session owns hosts from the
start of launch, keeps authoritative snapshots, and closes permanently. Presentation
adapters subscribe to changes and format them for their own surfaces.

Each pending Human prompt has a unique request ID. A response names both the run
and that request. Claiming a request before asynchronous delivery prevents two
answers from being accepted, and the identity prevents a stale card or dialog from
answering a later prompt. Restricted choices are validated for every interface.

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
