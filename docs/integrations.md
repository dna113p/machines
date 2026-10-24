# Integrations

## Agent defaults

MCP initialization and Pi's tool guidance direct coordinating agents to
inspect Machines **before delegated or multi-step implementation, debugging,
review, and verification**, without waiting for the user to name the tool. They
should actually launch a suitable workflow, not stop at discovery. Tiny edits,
simple answers, and single read-only commands remain direct. When no safe workflow
or working integration fits, the agent should explain the concrete fallback.

This is agent guidance, not a runtime enforcement hook or automatic model-spending
policy. Operations are preferred for mechanical checks. Existing permissions,
budgets, and Human decisions still apply. Worker prompts identify an already
running Machine state and discourage recursive delegation of the same assignment.

Put the same routing rule in a project's always-loaded `AGENTS.md` (and its
Claude instruction entry point) rather than relying only on optional skill
selection. Make `machine-project-setup`, `machine-builder`, and `machine-delegation`
available there.
The Machines Org umbrella demonstrates repository-local skill links, a Pi
extension entry point, and a no-model `verify` Machine without global installation.

Source-linked integrations pick up changes on reload. Rebuild built MCP entry
points with `npm run build` and reconnect/start a new client session. Portable
plugin installations need their complete bundle refreshed as described below.
Already-running conversations are not retroactively given new instructions.

## Install the skills for every agent

Install the three skills once, at user level, so every project can start with
`machine-project-setup` instead of only `machine-builder`. The cross-agent
[`skills` CLI](https://github.com/vercel-labs/skills) keeps one copy in
`~/.agents/skills` and links each agent's skills directory to it:

```bash
npx skills add dna113p/machines --global --skill '*' \
  --agent claude-code codex pi antigravity
```

Codex and Pi read `~/.agents/skills` directly. Claude Code reads
`~/.claude/skills`, and Antigravity reads `~/.gemini/antigravity/skills`. Run
`npx skills update --global` after a Machines release to refresh the copy.

When you work from a Machines checkout, link the skills to the checkout instead,
so edits apply without reinstalling:

```bash
for s in machine-builder machine-delegation machine-project-setup; do
  ln -sfn "$PWD/skills/$s" ~/.agents/skills/$s
  ln -sfn ~/.agents/skills/$s ~/.claude/skills/$s
  ln -sfn ~/.agents/skills/$s ~/.gemini/antigravity/skills/$s
done
```

Skip the lines for agents you do not use. A project's own `.claude/skills` or
`.agents/skills` links still take precedence for that project.

## Project orchestrator setup

Use [machine-project-setup](../skills/machine-project-setup/SKILL.md) when the agent
is taking responsibility for initial project workflow setup, or meaningful gaps
prevent useful delegation. The orchestrator inspects actual project needs, creates
or adapts useful definitions and tests, and writes a compact `.machines/README.md`
(or updates the project's existing workflow map). Link that map from its existing
orchestrator instructions or a role-specific section of `AGENTS.md`.
Use layered gates from the project's own scripts and one advisory review; green
checks deliver a draft with open findings.

The setup skill chooses project coverage; `machine-builder` implements individual
workflows; `machine-delegation` launches and supervises assignments. No new
orchestrator runtime or daemon is required. Existing coverage is reused instead
of scaffolding a generic suite or repeating setup on every task. Already-assigned
workers complete their state directly. Missing harnesses remain visible blockers,
and fixture validation is not evidence of live-agent performance or adoption.

Setup can also establish one reusable project agent and audit the same binding
later. Discover supported interfaces from the installed provider; reuse a matching
manager and record its identity, ownership, capabilities, cost, limits and
verification in the map. A stable project-agent identity is separate from each
request or run. A Machine-backed route need not provide a durable session.

Overlord, when selected, owns its managers and delegation. Discover its optional
`overlord-context` and `overlord-tools` skills: persistent guidance and authorized
tool grants are separate. Drip, when used, owns the shared project binding,
feedback delivery and presentation. Feedback uses that binding with a stable
request key, the person's note and response evidence. Neither integration is
required or implemented by these instructions. Missing integration or authorization
remains a gap; do not silently switch a configured provider. Availability audits
use unpaid checks and preserve service, access, publishing and spending limits.
Private ticket destinations are valid, and ticket creation does not authorize
execution. See the skill's [workflow map reference](../skills/machine-project-setup/references/project-workflows.md)
for the binding record and repair boundaries.

## Codex through direct MCP

From an arbitrary checkout, build and register the server:

```bash
npm ci
npm run build
codex mcp add machines -- node "$PWD/dist/mcp/server.js"
```

This command records the current checkout's absolute built entry point. Keep that
checkout available, or register again after moving it. It requires no marketplace
or helper skill. Start a new Codex thread and ask “Show me the Machines available
here.” The [official MCP guide](https://developers.openai.com/codex/mcp) describes
stdio server registration and configuration.

The five tools are:

| Tool | Inputs and result |
| --- | --- |
| `machine_list` | Absolute `cwd`; definitions, descriptions, missing Agents, per-file errors |
| `machine_agents` | Absolute `cwd`; configured Agent preset names, metadata, and usage-limit fallbacks |
| `machine_start` | Absolute `cwd`, Machine name, optional input/preset overrides; immediate run snapshot |
| `machine_status` | Optional exact `runId`; authoritative current-session snapshots |
| `machine_respond` | Exact `runId`, current `human.requestId`, and response; submits one waiting request |

Preserve the IDs returned by the tools. A stale request or repeated submission is
rejected. When explicit choices are present, send one of those exact strings.

Codex CLI can use text and structured tool results. Clients supporting MCP Apps
can also render the attached live card, which polls status and submits Human input.
Client support for the card varies; the same tools work without it.

## Portable Codex plugin

Build the self-contained plugin from the checkout:

```bash
npm ci
npm run build:plugin
npm run smoke:plugin
```

The result is `build/codex/machines/`, containing the manifest, compiled server,
production dependencies, widget assets, and the machine-project-setup, machine-builder,
and machine-delegation skills. Copy the entire directory when distributing it.
Node 24 or later must be on the receiving system's
PATH; the original checkout is unnecessary after copying. Build does not modify
your Codex installation or global configuration.

The plugin MCP configuration uses `command: "node"`, a relative server argument,
and `cwd: "."`. Codex resolves the plugin's relative working directory against
the installed plugin root, so no checkout-specific path or shell expansion is
needed. The source `codex/machines/` directory is an input to this build, not the
complete installable bundle.
This path behavior is implemented by the
[Codex 0.153.2 plugin parser](https://github.com/openai/codex/blob/rust-v0.153.2/codex-rs/codex-mcp/src/plugin_config.rs#L281-L288).

Install the resulting directory through your chosen local/repository marketplace
using the [official plugin packaging guide](https://developers.openai.com/plugins/build/plugins#install-a-local-plugin-manually).
For example, copy the complete bundle to a marketplace repository's
`plugins/machines/`, and add this entry to its `.agents/plugins/marketplace.json`:

```json
{
  "name": "machines-local",
  "interface": { "displayName": "Machines local" },
  "plugins": [{
    "name": "machines",
    "source": { "source": "local", "path": "./plugins/machines" },
    "policy": { "installation": "AVAILABLE", "authentication": "ON_INSTALL" },
    "category": "Productivity"
  }]
}
```

From that marketplace root, the current Codex CLI accepts:

```bash
codex plugin marketplace add "$PWD"
codex plugin add machines@machines-local
```

Existing marketplaces can add the plugin entry to their current list instead of
replacing their catalog. Use the direct MCP route when a marketplace is unnecessary.
Choose one installation route per Codex environment to avoid duplicate tools.

After updating the build, replace the complete bundle in the marketplace and
refresh the installation using the host's plugin management controls. Start a new
thread after installing or updating. The plugin version comes from its checked-in
manifest; release changes should bump it along with the package version.

The bundled configuration pre-approves the launcher tools. Discovery imports
trusted code, and start/respond can continue work that modifies files or contacts
external services. Tool annotations describe those capabilities. Configure your
preferred tool-approval policy in Codex if you need different behavior; workflow
Human states remain defined by each Machine.

Use [machine-delegation](../skills/machine-delegation/SKILL.md) when the coordinating
agent should delegate work through Machines, including creating a task-specific
workflow when none fits. It uses [machine-builder](../skills/machine-builder/SKILL.md)
for authoring. Direct MCP registration exposes the tools only; load these skill
instructions separately or use the portable plugin to include all three skills.

## Pi extension

For a checkout on POSIX systems:

```bash
mkdir -p ~/.pi/agent/extensions
ln -s "$PWD/pi-extension/index.ts" ~/.pi/agent/extensions/machines.ts
```

Run this from the Machines checkout after `npm ci`. Choose an unused destination;
the command does not replace an existing extension. Pi discovers it on startup;
use `/reload` after a source update. Keep the checkout available while using the
symlink. A locally installed npm package also includes the built extension at
`node_modules/@dna113p/machines/dist/pi-extension/index.js`.

Pi exposes the same five launcher tools using the conversation's current directory, with
a status widget and native Human dialogs. Canceling a dialog leaves its Machine
waiting; answer later through `machine_respond` with the current request ID.
Pi exit, session replacement, and reload terminate its session-owned runs.

To show a ticket that Dispatch runs in that same widget, subscribe from the
Pi session that should display it:

```text
/machine-watch fix-login
/machine-watch
/machine-unwatch fix-login
```

`/machine-watch` without an argument lists subscriptions. The corresponding
agent tools are `machine_watch({ target: "fix-login" })`, `machine_watch({})`,
and `machine_unwatch({ target: "fix-login" })`. A target is a ticket's id at the
start of its published label, or a run id prefix. Ticket subscriptions also
match later attempts, including tickets that have not started yet. They do not
launch work. Sub-runs and unrelated tickets stay hidden.

Subscriptions use Pi's actual session id and the existing run watch-list files.
They survive reload and resume of that session, but a new session has its own
list. The widget refreshes once a second, even while a subscription has no run.
It shows the ticket label, state, Agent, and pending question, alongside Pi-owned
runs without duplicate rows. Sleeping tickets stay visible; finished or lost
published runs disappear after 30 seconds from their last update.

Watching is passive and read-only: `machine_watch` never wakes the model.
External questions do not open Pi's native input dialog; answer them through
their owning application. `machine_respond` refers only to Pi-owned runs.
Unwatching or closing Pi never stops a watched run.
Both Pi and Dispatch must read the same run-status directory (below); subscribing
reports that directory, and refuses when publication is off. The adapter also
picks up changes made by `machine watch` when that CLI uses the same session id.

### Wake the coordinating Pi session

Machines has its own wake mechanism; no Drip installation or process is required.
In Pi 1.4 or later, a run spawned through `machine_start` automatically registers
the initiating Pi session before Human or terminal events arrive. Completion,
failure, and each new unanswered Human request send a model-facing message with
`triggerTurn: true` and `deliverAs: "followUp"`. Progress does not wake the model.
An unanswered sleeping Human request also wakes it; timed sleeps and recorded
answers do not.

For an externally started run, explicitly register in the Pi session that should
continue:

```text
/machine-attach fix-login
/machine-detach fix-login
```

The agent tools are `machine_attach({ target: "fix-login" })` and
`machine_detach({ target: "fix-login" })`. Targets use the same ticket-label or
run-id prefix matching as passive watches, including future ticket attempts.
Attachment immediately considers current matching records, even old terminal
ones; use an exact run id to limit it to one attempt. Attachment also shows
matching runs in the widget. It neither launches a process nor acquires ownership.
An `owner` field or a passive watch alone never registers wake delivery.

After starting or attaching, continue independent work, then **yield the turn**
when none remains. Do not keep the model busy with status polling or a blocking
wait tool. Busy events remain in a local cancellable queue until `agent_settled`,
after retries and automatic follow-ups finish. Manual compaction does not emit
that event: after success, failure, or cancellation, the observer releases queued
events when Pi becomes idle with no pending messages. Branch summarization uses
the same idle recovery after success, failure, or cancellation, even when no
tree-navigation outcome event is emitted. Automatic compaction and new agent
activity still require full agent settlement. Delivery rechecks the registered
session identity and registration before calling Pi. It never targets whichever
session happens to be displayed instead.

On a wake, call `machine_status({ runId: "<exact-id-from-message>" })` to retrieve
the authoritative owned snapshot or attached published record. Registered spawned
terminal snapshots remain retrievable for the registration's lifetime, beyond the
session's five-terminal-run cache, including after their wake is delivered. Detach
or runtime shutdown releases these retained snapshots. Attached records
remain retrievable after the widget's 30-second expiry, for as long as the record
and attachment remain. Published snapshots contain a summary rather than arbitrary
Agent transcripts or full workflow output; plan result artifacts before launch.
Report results or relay the current question. A wake **does not authorize a Human
decision**: obtain the Human's clear answer before responding. Owned runs retain
their native Pi dialogs and `machine_respond`; external runs must be answered
through their owner (or `machine respond` when that owner supports it).

Detach the same target to remove its registration and cancel pending events
unless another overlapping registration still covers the run. Detaching an
automatically registered spawned run by its id unregisters wakes without stopping
its host or disabling its native Human dialog. `machine_unwatch` removes only a
passive watch; it does not detach. Shutdown, session switch, and reload invalidate
all active registrations and queued callbacks, and stop polling. They still
terminate spawned hosts under existing ownership rules; external hosts keep
running. Reattach external runs explicitly in the replacement runtime. Passive
watch lists may survive reload; active wake registrations do not.

Delivered event identities persist in Pi session entries, keyed by run id,
start/continuation identity, event, and Human request id. Repeated snapshots,
overlapping registrations, and reattachment do not replay the same event. New
attempts, continuations, and Human requests can wake separately. Delivery receipts
are session-wide, including across tree navigation; a fork has a new session id.

Both the external publisher and Pi must use the same run-status directory;
`MACHINES_RUN_STATUS_DIR=off` disables external attachment. Publication is a local
snapshot mechanism polled once per second, so a transient Human wait answered
between polls may not be observed. A missing/pruned record cannot be retrieved.
Wake delivery requires a running Pi session with these APIs: it cannot resume a
closed session, restart Pi, or start a replacement agent. Pi's message API gives
no durable acknowledgment of model execution; a crash or provider failure after
handoff may require manual status retrieval. Deterministic recording-API tests
verify delivery policy, not live provider continuation.

## Run status for host status lines

Pi and MCP Apps clients render their own run snapshots in-process; Pi also reads
published runs for its subscriptions. A host that can only run
a command, such as Claude Code's status line, reads published run status instead.
Publication is on by default and needs no setup: every process of one user
publishes to and reads from the same private directory, so a run started
anywhere, by a coding agent, a terminal, or a daemon, is on the status line, in
`machine runs`, and within reach of `machine respond`.

One variable refines it:

| `MACHINES_RUN_STATUS_DIR` | Run status |
| --- | --- |
| unset | Published in `$XDG_STATE_HOME/machines/runs` when `XDG_STATE_HOME` is an absolute path, otherwise in `~/.local/state/machines/runs` |
| `off`, or empty | Off: nothing is written, and the commands that read run status say so |
| a directory | Published there instead; a relative path is resolved against the working directory |

To move the directory, give the same absolute path to every process that starts
runs or reads them: the coding agent, a daemon that hosts runs, and the status
line. The same holds for `XDG_STATE_HOME`: a service that does not inherit the
one your shell sets uses `~/.local/state`. A process given its own Machines home
through `MACHINES_USER_HOME` publishes under that home, in
`<home>/.local/state/machines/runs`, whatever `XDG_STATE_HOME` says, so an
isolated catalog also keeps its runs out of your own directory. Where no
absolute home can be found, publication is off.

`machine run`, the MCP server, and a host that asks for it (below) keep one file
per run, `<dir>/<runId>.json`, replaced atomically on each change. The
directory is created by the first write, as `0700`, and each file is `0600`:

```json
{
  "schemaVersion": 2, "id": "1a2b3c4d-…", "pid": 4242, "owner": "<session id>",
  "machine": "ticket", "path": "/work/.machines/ticket.ts", "cwd": "/work",
  "status": "running", "state": "review",
  "agent": { "harness": "claude", "model": "opus", "thinking": "high" },
  "startedAt": "2026-03-04T05:06:07.000Z", "updatedAt": "2026-03-04T05:08:12.000Z"
}
```

`status` is `running`, `waiting`, `sleeping`, `completed`, or `failed`. A sleeping
run has either a timed wait's `due` timestamp or a `human` request with a
`requestId`; see [continuing a run](#continuing-a-run). `state` is the current
state as a string (JSON for a nested state). While a `p.use` child runs, its
state is nested under the parent use state, for example `{"review":"check"}`.
Further children extend that same path. `machine runs` and the status line show
this value; `machine ui` shows the dotted path `review.check`. `agent` is present
while an Agent state has reported its identity, and `error` after a failure. `owner` is
`MACHINES_RUN_OWNER` when set, otherwise the session id the coding agent gives
the commands it starts (`CLAUDE_CODE_SESSION_ID`, then `CODEX_THREAD_ID`, then
`PI_SESSION_ID`), otherwise absent; see
[how a host names its session](#drawing-your-own-widgets). `stateSince` is when
the current state was entered. `label` is the first
line of `MACHINES_RUN_LABEL` (at most 160 characters) when a launcher sets it to
say what the run is for, such as a ticket id and title; it is the launcher's
choice to publish that text. `machine run` exports its run id as
`MACHINES_RUN_PARENT`, so a Machine started by one of its Operations or Agents
records that id as `parent`; the status line shows only top-level runs.

`graph` is the Machine's states and transitions, published when the run starts
and extended when a child starts: `initial`, `states` (each with an `id`, a `kind`
of `agent`, `human`, `operation`, `final`, `group`, or `state`, an Agent's `role`, and the `parent`
group of a nested state), and `edges` (`from`, `to`, and the `event` taken). Ids
are state paths joined by dots, so a nested state is `review.round`. A Machine
with more than 300 states or 1000 transitions publishes no graph. A `use` state
is a group whose outgoing edges name the child's endings. The child's graph
needs its input, so its states and edges join that group only when it starts.
Repeated entries do not duplicate states or edges. If adding a child would
exceed either limit, the graph stays as drawn so far. `trail` is the
states the run entered, oldest first, each with the time it was entered, as the
same dotted paths, including child states in entry order; it keeps the latest
200. Both are additions to version 2:
a reader that does not know them ignores them.

A top-level final that takes a declared ending also has `ending` on its graph
state: `succeeded`, `failed`, or `cancelled`. `machine ui` draws each kind with its
own colour and label, including before the run reaches it.

The graph does not depend on publication. `machineGraph(definition, endings?)` from
`@dna113p/machines` returns it for any Machine definition a program holds, or
undefined for one too large to draw. The value `startMachineHost` resolves to
carries the run's initial `graph` whether or not the host publishes. Its
`onGraph` callback reports each grown graph, and `onState` reports the nested
state values a trail is made of. A prepared launcher's `start({ onGraph })`
receives the same graph updates.

`listMachines()` from `@dna113p/machines/launcher` reads a module's optional
`endings` export without building the Machine. Each summary's `endings` array
contains the name, kind, and optional output schema of each declared ending.
Malformed exports list with `error`; modules without the export omit the field.
`machine list` prints each ending's name and kind under its Machine.

A run hosted through `startMachineHost` from `@dna113p/machines/host` publishes
the same record when its host asks with `publishRunStatus: true` and
publication is on in the hosting process, as a daemon that runs tickets does. A
host that does not ask publishes nothing, whatever its environment says: a
program that presents its runs itself, such as Pi with the extension loaded, is
not changed by publication being on. Two options replace the environment for that one run:
`label`, shortened as `MACHINES_RUN_LABEL` is, and `owner`. When an option is
absent the environment rule above applies; an empty one publishes the run
without that field. The run exports its id as `MACHINES_RUN_PARENT` to its
Operations and Agents, as `machine run` does. The host publishes, not the hosted
process, so `pid` is the host's: a hosted process that is terminated or exits is
recorded as `failed` with the reason, and a run whose host is gone shows as
`lost`. The value `startMachineHost` resolves to carries the run's `id`, which
is the id of its record; a session built on it, such as Pi's, reports that same
id for the run, so it is the id to give `machine watch`.

Without the sleep option, such a record carries `"answeredBy": "host"`. Its Human requests are answered
only through the host's own `respond` and `ask`: the run reads no inbox, its
`human` has no `requestId`, and `machine respond` refuses it. The field is absent
from every other record and did not exist in earlier version 2 records. A caller
that publishes its own record for the run, as the MCP server does so that its
runs keep their inbox, passes `publishRunStatus: "caller"`: the host then writes
nothing, and the run still hands its id down to the runs it starts.

A hosted active Human wait also publishes `humanEventId`, a separate random
observation identity used to deduplicate wake events. It remains stable for that
request, changes for the next request even if the prompt is identical, and is
cleared when the request ends. It is not a response request id and does not
enable `machine respond`. Older hosted publishers without either request or
observation identity cannot provide distinct Human wake events; terminal events
still work.

Use `startMachineHost({ machine, sleep: true, publishRunStatus: true })` to end
the child process at a Human request or a future timed wait. Sleep requires
publication to be on and the host to publish successfully; caller publication
is not supported. `run.result` resolves with `{ state, sleeping: { human } }`
or `{ state, sleeping: { due } }`. The Human request includes its `requestId`.
The sleeping record publishes that request id, omits `answeredBy`, and carries
`continuedBy: "host"` so `machine continue --due` skips it. Answer with
`machine respond <run-id> <request-id> <response>` and wake it through its host
with `startMachineHost({ continue: runId })`. Recording the answer never starts
the run. Sleep requests do not call `onHumanRequest`.

While an Agent state waits for a [usage limit](authoring.md#usage-limits) to
reset, the record stays `running` and carries the wait in `limit`:

```json
"limit": {
  "text": "implementer reached its usage limit; waiting for the reset at 2026-10-10T21:00:00Z",
  "until": "2026-10-10T21:00:00Z"
}
```

`text` is a ready one-line summary. `until` is when the wait is expected to end:
the earliest stated reset, or the end of the wait limit when no reset is stated.
The field is removed when the Agent resumes or the state is left; a swap between
presets that are tried again during the wait leaves it in place. It did not
exist in earlier version 2 records, and readers should ignore fields they do not
know. `machine runs` prints the summary under the run, and MCP and Pi run
snapshots carry the same `limit`.

A run waiting for Human input is `waiting` and records the pending request in
`human`:

```json
"human": {
  "prompt": "Publish version 0.4.0?", "requestId": "9f8e7d6c-…",
  "choices": ["publish", "hold"]
}
```

The optional presentation fields are `headline` (one sentence, at most 160
characters), `recommended` (an exact choice or suggestion name), `effects` (a map
from those names to sentences of at most 160 characters), `discards` (names that
destroy work), `reason` (why the recommendation, at most 1000 characters), and
`page` (an inert HTML body fragment of at most 200,000 bytes of UTF-8). A discard
cannot be recommended. `recommended`, `effects` and `discards` name entries in
`choices`, or in `suggestions` when there are no choices; they require one of
these lists. These fields travel unchanged in hosted requests, sleeping
requests and published records, and appear only when set. Readers should ignore
fields they do not know. Hosts may show the headline first, mark the recommendation
and discarding entries for both choices and suggestions, show their effects,
and display the page beside the prompt, or omit the page. The prompt stands alone;
responses still use the original strings, and suggestions still allow free replies.
See [Human input](authoring.md#events-and-human-input) for validation and page content rules; a host must isolate pages it renders.

`requestId` is new for every request. `choices` restricts the response to those
values; `suggestions` are offered but any text is accepted; `discussion: true`
means the request also takes a question. Each is present only when the Human
state has it. Records written before these fields existed have `schemaVersion`
1 and only `human.prompt`; readers should accept both versions. Once a run has
taken a response from its inbox, its record lists that delivery's id in
`deliveries`, which is how `machine respond` knows its response was applied. An
id stays listed for at least a minute, however many responses the run takes
after it, and never contains the response.

When a run finishes, `machine run`, the MCP server, and a host that asks for
publication all three publish the optional `note` field if the final output
is an object with a non-empty string `summary`. It is trimmed and limited to
2000 characters, including a trailing `…` when shortened
at a word boundary (a single word longer than the limit is cut to fit).
Empty or whitespace-only summaries leave the field absent. The whole note,
including its line breaks, is available in JSON. This optional field keeps
`schemaVersion` at 2; readers should accept records with or without it.

A run that finishes in a declared ending also publishes `ending` as `{ name, kind }`.
The `kind` is `succeeded`, `failed`, or `cancelled`, as declared by the Machine;
all three leave `status` as `completed`. The `state` and `note` fields are unchanged.
Runs of modules without `endings`, sleeping runs, and runs stopped by an execution
error have no `ending`. This optional field also keeps `schemaVersion` at 2.

The status record omits Machine input and output fields other than that summary.
Human responses are omitted except for `human.answer` recorded while sleeping,
which is cleared when the run continues. The checkpoint described below does
keep input, saved working data, and `context`, which may contain sensitive values.
A Human prompt and its choices are written to the `0600` file while the request
is waiting or sleeping. The standard directory is private to you; one you name
instead should be a directory only you can read and write.

The first status publication is best effort. Where the directory cannot be created or
written, as in a read-only home, a sandbox, or a container, a run goes on
exactly as one with publication off: it is not published, nothing is reported,
and the directory is not tried again at each state. Reading a directory that
does not exist yet finds no runs; it is not an error.

The directory does not grow without bound. Each run that starts removes:

- the record of a run that finished, or whose process is gone, more than an hour
  ago, with its inbox and any response left for it, unless it has a checkpoint;
- what an interrupted write or delivery left behind more than an hour ago;
- an inbox with no record beside it, left when a run was pruned without it,
  more than an hour after it was last written;
- a [watch list](#watching-other-runs) that has not changed for 30 days.

A running or waiting run keeps its record for as long as its process lives.
Files Machines did not name are never removed, and nothing is removed while no
run starts. A record whose process id now belongs to another process counts as
running until that process ends.

### Continuing a run

Reserve Human sleep for enforced-column decisions; [deliver green drafts with open findings](authoring.md#agents).

```sh
machine continue <run-id>
```

For waits that can last days, start with `machine run <name> --sleep`. At a
future [timed wait](authoring.md#timed-waits), the CLI writes status `sleeping`
with an ISO `due` time and ends its process successfully. The checkpoint keeps
`sleep: true`; every CLI continuation keeps sleeping at subsequent waits and
Human requests. `--sleep` is refused when publication is off or the initial
status record cannot be written.

At a Human request, `--sleep` also ends the process successfully. Its record is
`sleeping` with `human: { prompt, requestId, choices?, suggestions?, discussion?,
headline?, recommended?, effects?, discards?, reason?, page? }` and no `due`.
The checkpoint retains the Human state; continuation rebuilds its request from
the definition, including these presentation fields. Record a plain answer while
no process is running:

```sh
machine respond <run-id> <request-id> approve
machine continue <run-id>
```

`respond` stores the string in `human.answer` and updates `updatedAt`, leaving
the run sleeping. It never starts the run. A wrong request id, a response outside
the offered choices, or a second answer is refused. Sleeping runs refuse
`--question` even when discussion is allowed: only a plain response can be
recorded while the run sleeps, and refusing a question leaves the request open.
A run sleeping at a timed wait takes no response.

On an unanswered Human request, `continue` reports the prompt, choices, request
id and the command to answer it, exits successfully and changes nothing. After
an answer, it gives that answer to the restored Human state once without showing
the prompt again; the state's choice checks still apply. Without `--sleep`,
Human requests are answered while their process runs, as usual.

Before a timed wait's deadline, `machine continue <run-id>` reports the due time, exits
successfully, and changes nothing: it does not claim the run, import its Machine,
or publish a status. Once due, it takes the wait's `due` transition. A sleeping
run's recorded pid may have been reused and does not block continuation. Without `--sleep`, the wait stays an
in-process timer, including when continued with time left on its saved deadline.

An external scheduler or timer can call `machine continue --due`. It selects
sleeping runs with a recorded Human answer or a timed wait whose deadline has
passed, then continues them one after another in `updatedAt` order. It skips
records with `continuedBy: "host"`; only their host wakes them. If a continuation
fails, it goes on with the remaining runs, reports each failed run to stderr,
and exits nonzero. No eligible runs is a successful no-op. Machines starts no
background process or timer to call this command.

Every published run keeps `<run-id>.checkpoint.json` beside its status record.
It is private (`0600`) and replaced atomically at each state entry. A crash during
replacement leaves the previous checkpoint whole. It contains:

- `schemaVersion: 2` and `id` (version 1 checkpoints still continue);
- `machine: { name, path, sourceHash }`, with the SHA-256 hash of the Machine file;
- `input`, Agent override bindings in `agents`, `home`, and `cwd`;
- `state: { value, path, kind, enteredAt, due? }`, with the full XState state value,
  dotted active paths, a kind of `agent`, `operation`, `human`, `wait`, `final`, or
  `state`, and the wait's deadline in `due`;
- `sleep: true` when the CLI was started with `--sleep` or the host enabled `sleep`;
- `data`, XState `context`, and `writtenAt`;
- optional `children`, a single-element array holding the active child's
  `machine: { name, path, sourceHash }`, `input`, `state`, `data`, `context`, and
  recursively its own `children`. Each parent stays at its `use` state while
  the child runs.

No copy of the Machine source is stored. The checkpoint is removed when the run
reaches a final state; failed and interrupted runs keep theirs, and pruning keeps
the associated record. Turning `MACHINES_RUN_STATUS_DIR` off also disables
checkpoints. Once publication succeeds, invalid `p.data()` values or a checkpoint
write failure fail the run and remove its stale checkpoint, with a diagnostic.
Context uses normal JSON conversion; if that fails, the run continues and its
checkpoint is removed until a later state has serializable context. Such a run
cannot be continued while it has no checkpoint.

Continuation accepts a due or answered sleeping record, a failed record, or a
running/waiting record whose pid is dead. A running or waiting run with a live pid,
a completed run, and any run with no checkpoint are refused with a reason.
A private claim prevents two processes
from continuing the same run or overwriting a sleeping run's answer; a dead claim
owner can be replaced immediately.
Parallel state values with more than one active path are refused.

The run uses the saved working directory, home, input, and Agent overrides. Its
id, start time, owner, label, parent, and trail remain, its pid is updated, and a
previous failure is cleared. The saved step runs again from its start, including
asking a Human again unless a sleeping run's answer was recorded, without
rerunning entry actions. See
[saved working data](authoring.md#saved-working-data) for serialization rules and
repeatable steps.

If the Machine file changed but the saved state still exists, continuation uses
the new file and publishes `continued: { at, machineChanged: true }` in the status
record. An unchanged file sets `machineChanged: false`. If the saved state is
missing, continuation names it in an error before any step runs.

A program can continue through the public host API:

```ts
const run = await startMachineHost({ continue: runId, publishRunStatus: true });
const result = await run.result;
```

The host loads the saved launch settings and keeps the same id and record.
`run.continued.machineChanged` reports a changed Machine. Hosted continuation
defaults to `publishRunStatus: true` so the host updates that record itself;
explicitly disabling publication or assigning it to a caller is refused.
It passes a sleeping run's recorded answer to the restored Human state without
asking again. It keeps the checkpoint's `sleep` setting unless the host supplies
`sleep` explicitly, and its result can resolve with `sleeping` again.

### Answering a waiting run from outside

With publication on, a waiting run can be seen and answered by any process
running as the same user: a terminal, a coordinating agent, a script, or a
presentation surface. They all read the same request, and the first valid
response wins. With the standard directory there is nothing to set; if you move
it, set the same `MACHINES_RUN_STATUS_DIR` for the run and for whatever answers
it. With publication off these commands fail and say how to turn it on.

```bash
machine runs                 # running, waiting and sleeping runs
machine runs --json          # the same runs as their records
machine runs --all           # every published run, also finished and lost ones still recorded
machine respond <run-id> <request-id> <response>
machine respond --question <run-id> <request-id> <text>
```

`machine runs` prints each run's id, Machine, status, and state, and for a
waiting or sleeping Human request its prompt, request id, and choices
(tab-separated when its output is not a terminal). A run's label follows as a
fifth column when it has one, and a sixth says `watched` for a run this session
[watches](#watching-other-runs). It lists the running, waiting and sleeping runs
of every session and project; `--for` narrows it to
[what one viewer shows](#drawing-your-own-widgets). `--all`, with or without `--json`, lists every published
run: also the ones whose records remain after they finished, as `completed` or
`failed`, or after their process disappeared, as `lost` (in JSON such a record
keeps the status it last published). For a completed or failed run, the first
non-empty line of its note is printed beneath the row; `--json` includes the
whole note. A run answered through its host shows
`answered through its host` in place of a request id:

```text
1a2b3c4d-…	release	waiting	approve
  Publish version 0.4.0?
  request: 9f8e7d6c-…
  choices: publish, hold
```

A sleeping run stays listed without `--all` and is never `lost`, regardless of
its pid. A timed wait prints `due: <iso>` and, once due, `due now`. A Human
request prints how to answer it; after an answer is recorded it prints
`answered` and how the run wakes, with `machine continue <run-id>` or its host.
`--json` adds `sleep` to sleeping records: either
`{ "for": "answer", "requestId": "…", "choices": ["publish", "hold"], "answered": false }`
(choices are optional), or `{ "for": "time", "due": "<iso>", "isDue": false }`.
The booleans reflect the recorded answer and the current clock.

`machine respond` checks the response against the current record before it
delivers anything. It fails with a nonzero exit when the run is unknown, is
answered through its host, is not waiting, is waiting on a different request id,
or restricts `choices` to values that do not include the response. `--question` sends a discussion question
instead of an answer and is refused unless the request has `discussion: true`.
Words after the request id are joined into one response; put `--` before a
response that starts with a dash.

The command exits zero once the run's record has left that request and names
this delivery among the responses it took, even if the run has taken a response
to a later request since. If that does not happen within five seconds, or the
run leaves the request without taking the response because something else
answered first, it exits nonzero with a "not confirmed" message.
A response still unread is taken back and one the run read too late is
discarded, so the same response is never applied later or twice. Read the run's
new record before answering again.

Delivery uses a private inbox beside the records: one `0600` file per run,
`<dir>/<runId>.inbox`, written atomically and removed by the run as it reads it.
There is no network listener and no daemon. A response for another request id,
or one the request does not allow, is discarded and never applied to a later
request.

The inbox holds one response at a time, and a second is refused while one is
pending. Only the run removes a file from its inbox. While `machine respond`
waits, it holds the same file under a second name of its own,
`<dir>/.<runId>.<delivery>.inbox.sent`; the run removes that name to take the
response and the sender removes it to take the response back, so exactly one of
them succeeds and neither can act on a response that arrived later. A response
that was taken back stays in the inbox, emptied, until the run next reads its
inbox or finishes, and a new response is refused until then.

**Anything that can write to the directory as you can answer a waiting run**,
including approvals. That is why the standard directory is a private per-user
one, created `0700`: no other user can read a request or leave a response. It
is also all that protects a waiting run, so do not loosen its permissions and do
not point `MACHINES_RUN_STATUS_DIR` at a shared directory. Set it to `off`
where no process of yours should be able to answer a run from outside it.

`machine run` still asks on its own terminal, and whichever of the terminal and
the inbox gives the first valid response is used. Terminal input outside a
request's `choices` is reported and asked for again instead of failing the run.
A published run started without terminal input, for example by a coordinating
agent or a script, waits for `machine respond` instead of failing, and prints
the exact command to its standard error. With publication on by default this is
what a script or a CI job gets as well. With publication off, or where the run
could not be published, it fails at its first Human state with "Terminal input
closed before a response": set `MACHINES_RUN_STATUS_DIR=off` for a run that
should fail there instead of waiting.
Runs hosted in any other program through `startMachineHost` are answered through
that program while active. With `sleep: true`, `machine respond` records an answer
while sleeping, and the host continues the run.
Runs hosted by the MCP server take a response from their own `machine_respond`
tool or from the inbox. That tool is answer-only, so a question to a hosted
request that allows discussion goes through the inbox with
`machine respond --question`.

For Claude Code, call the dependency-free renderer from `statusLine`. That is
the whole setup: the runs Claude Code launches, a daemon that hosts runs as the
same user, and the status line all use the standard directory, so there is no
`env` block to add and no path to repeat anywhere.

```json
{
  "statusLine": {
    "type": "command",
    "command": "node /path/to/machines/claude/statusline.mjs",
    "refreshInterval": 5
  }
}
```

A checkout has the script at `claude/statusline.mjs`; an installed package at
`node_modules/@dna113p/machines/claude/statusline.mjs`. `refreshInterval`
(seconds) is optional and keeps elapsed time advancing while the conversation is
idle. To keep an existing status line, call the script from it with the same stdin:

```bash
input=$(cat)
printf '%s' "$input" | your-status-line
printf '%s' "$input" | node /path/to/machines/claude/statusline.mjs
```

A labelled run leads with its label; an unlabelled one with its short id. It
prints one to three lines per run and nothing when there is nothing to show:

```text
● org-2 → machines: Continue an existing ChatGPT web conversation
  ticket › review · 2m 5s (31m 40s total) · claude-opus-5-5 · high
● 1a2b3c4d  verify › verifyOrg · 12s
◆ 5e6f7a8b  release › input needed · 41s
  Publish version 0.4.0?
```

A session sees the runs it owns and the runs it
[watches](#watching-other-runs); runs without an owner also appear in sessions
whose project directory contains the run's working directory. Finished runs stay for
30 seconds. Sleeping runs stay visible until they continue or finish. An
unanswered sleeping Human request uses the same yellow `◆ input needed` style
as a waiting run. An answered request uses a calm `◇` with `answered`; a timed
wait uses `◇` with `due in …` or `due now`. Neither needs a person's action:
its host or `machine continue --due` wakes it.
A running or waiting run whose process disappeared is shown as `lost`
for the same time, so the status line must run where it can see that process.
Set `NO_COLOR` (to any value, even an empty one) for plain text and `COLUMNS`
to change the 120-column truncation.

### Watching runs in a browser

```bash
machine ui [--port <port>] [--project <dir>]
```

serves a live page on `127.0.0.1` (port 4777, or the next free one) of every
published run: what is waiting on you, what is running or sleeping, and what
finished, with each run's Machine drawn as a graph, its current state marked, the states and
transitions it has taken counted, and the path it took so far. A waiting run
that takes outside responses is answered from the page, as `machine respond`
answers it; a run answered through its host, such as a daemon's, names where to
answer it instead. The page loads nothing from outside, accepts requests only
under its own host name, and answers a run only with a token it was served.

Sleeping Human requests without an answer appear under "Waiting on you" with
the existing answer form. Sending an answer records it while the run stays
sleeping; the page says "Answer recorded" and names `machine continue <run-id>`
or the host that wakes it. Sleeping requests take plain answers only, so the
form offers no discussion-question checkbox. Answered requests and timed waits
appear under "Sleeping", with their request or due time. There is no wake button.

A project adds its own panels beside the runs, such as its tickets or pull
requests, in `.machines/ui.json` in the project (the nearest directory above the
current one that has a `.machines` directory, or `--project`):

```json
{ "panels": [{ "title": "Tickets", "command": ["node", "scripts/ui-panels.mjs", "tickets"], "refreshSeconds": 10 }] }
```

Each command runs in the project directory every `refreshSeconds` (10 by
default) and prints one JSON object: `{ "summary"?, "items": [{ "text",
"detail"?, "status"?, "href"?, "at"? }] }`, where `status` is `ok`, `warn`,
`bad`, `active`, or `idle`, `href` is a web link, and `at` a time. Commands are
project code, trusted as `.machines/` Machines are; a command that fails or
prints something else shows its error in its panel.

### Watching other runs

A session can pull in runs it did not start: a ticket that a daemon runs, or a
run started by another session or under another project. Nothing is configured.
The session is identified as a run's `owner` is, by `MACHINES_RUN_OWNER` and
otherwise by the session id its coding agent gives it, so an agent inside Claude
Code, Codex, or Pi only runs the command.

```bash
machine runs                   # running, waiting and sleeping runs, with their labels
machine runs --all             # every published run, also finished and lost ones
machine watch org-9            # runs whose id or label starts with org-9
machine watch --dir ../other   # runs working in that directory or below it
machine watch                  # what this session watches, and the published runs each entry matches now
machine unwatch org-9          # also: unwatch --dir <path>, unwatch --all
machine watch --for <session> org-9   # the same commands for another session's list
```

- `machine watch <text>` names every top-level run whose id starts with the
  text, or whose label starts with it as a whole leading part: the label ends
  there or goes on with something other than a letter, a digit, `-`, or `_`.
  `org-9` matches the labels `org-9 → machines: …` and `org-9: …`, not
  `org-90 …`. Matching is case-sensitive, and the text is one non-empty line.
- `machine watch --dir <path>` names every top-level run whose working
  directory is that path or inside it. The path is kept absolute.
- An entry keeps matching runs that start later, so a ticket can be watched
  before its run exists. `machine watch` lists a matched run for as long as its
  record remains, with the status `machine runs --all` gives it, so it also
  says how a watched run ended, with the first non-empty line of its note
  beneath the row when present.
- `--for <session>`, first, makes `machine watch` and `machine unwatch` read
  and change the list of the session it names instead of this process's own.
  A program that draws [its own widgets](#drawing-your-own-widgets) for a
  viewer manages that viewer's list this way, without setting a variable.

A watched run is shown even when another session owns it or it works outside
the project. Everything else is as for any run: sub-runs stay hidden, a run is
listed once however many entries name it, and at most five runs are shown.

The list is one file per session beside the records,
`<dir>/.watch.<session id>.json` (`0600`, replaced atomically), which the
status line reads itself with the `session_id` Claude Code gives it:

```json
{ "schemaVersion": 1, "watches": [{ "text": "org-9" }, { "dir": "/work/other" }] }
```

Record readers skip it, as they skip every name that starts with a dot. A
session id that is not safe as a file name is refused. Removing the last entry
removes the file, and writing a list or starting a run removes other sessions'
lists that have not changed for 30 days. A missing, unreadable, or malformed list watches
nothing; it is never an error on the status line. The commands fail with a
message when publication is off or when nothing names the session.

### Drawing your own widgets

Any application can show Machine runs in its own way from what is already
published: an extension for Codex or Pi, a web app, an editor panel. The Claude
Code status line above is one such consumer. Nothing is configured and nothing
new runs; there are three ways to read the same directory:

| Read with | You get |
| --- | --- |
| `machine runs --for <session> --json` | The runs one viewer shows, each ready to draw |
| `@dna113p/machines/run-status` | The same rule and the readers, in your own process |
| The files | The [records](#run-status-for-host-status-lines) and [watch lists](#watching-other-runs) themselves; the rule is then yours to apply |

A viewer is one surface that shows runs: a session of a coding agent, a browser
tab, a status line. It is named by a session id and may have a project
directory. The rule that decides what it shows is the status line's:

- only top-level runs: a run started from inside another Machine is never shown;
- the runs its session owns, unowned runs working in its project directory or
  below it, and the runs its session [watches](#watching-other-runs), whoever
  owns them;
- a run recorded as running or waiting whose process is gone is `lost`;
- a sleeping run stays visible regardless of its pid and never becomes `lost`;
- a finished or lost run stays for 30 seconds and then drops out;
- each run once, the ones that can still change first, then the most recently
  updated. Runs updated in the same millisecond keep the order they were read
  in from the directory, for the command, the library, and the status line
  alike.

Both ways below take a snapshot. Read again to refresh, as the status line does
every few seconds, and read where the runs' processes can be seen, or every run
looks `lost`.

```bash
machine runs --for "$SESSION" --project "$PWD" --json   # what that viewer shows
machine runs --for --json                               # for this process's own session
machine runs --for "$SESSION" --all                     # as text, and with older finished and lost runs
machine watch --for "$SESSION" org-9                    # change what that viewer watches
```

`--for` takes the viewer's session id; with no id after it, the viewer is this
process's own session, and the command fails when nothing names one.
`--project` is the viewer's project directory, compared as an absolute path;
without it only owned and watched runs are selected. `--all` also keeps the
finished and lost runs that the 30 seconds would have dropped, for as long as
their records remain. Without `--json` the runs are printed in the columns of
`machine runs`. Without `--for`, `machine runs` shows every session's
running, waiting and sleeping runs, adding `sleep` to sleeping JSON records.

Each viewer item is the published record with these additions:

```json
{
  "schemaVersion": 2, "id": "1a2b3c4d-…", "pid": 4242, "owner": "<session id>",
  "machine": "release", "path": "/work/.machines/release.ts", "cwd": "/work",
  "status": "waiting", "state": "approve",
  "human": { "prompt": "Publish version 0.4.0?", "requestId": "9f8e7d6c-…", "choices": ["publish", "hold"] },
  "startedAt": "2026-03-04T05:06:07.000Z", "updatedAt": "2026-03-04T05:08:12.000Z",
  "shown": "owned",
  "answer": { "via": "respond", "runId": "1a2b3c4d-…", "requestId": "9f8e7d6c-…" }
}
```

- `status` is the effective one: what the record says, or `lost`.
- `shown` says why the viewer shows the run: `owned`, `project`, or `watched`,
  the first of them that holds.
- `answer` is present while the run waits on a Human request that something
  can answer. `"via": "respond"` carries the two ids for
  `machine respond <runId> <requestId> <response>`; `"via": "host"` means only
  the program hosting the run can answer it, so a widget shows the prompt and
  offers no input. `human` still has the prompt, choices, and suggestions.
- `sleep` is present for a sleeping run. Its `RunSleep` value is
  `{ for: "answer", requestId, choices?, answered }` or
  `{ for: "time", due, isDue }`. An unanswered sleeping request also gets
  `answer`; an answered one or a timed wait does not.

Nothing is added for presentation: no colour, layout, or shortening, and no
limit on how many runs are returned. Recorded text is the run's own, so escape
it for your surface as the status line strips control characters.

The library gives the same answer without starting a process:

```ts
import {
  readRunStatuses, readRunWatches, runStatusDirectory, runsForViewer,
} from "@dna113p/machines/run-status";

const directory = runStatusDirectory(); // undefined while publication is off
const runs = directory === undefined ? [] : runsForViewer(readRunStatuses(directory), {
  sessionId,
  projectDir: "/work/project",
  watches: readRunWatches(directory, sessionId),
});
for (const run of runs) draw(run.label ?? run.id, run.status, run.shown, run.answer);
```

`runsForViewer(records, viewer, options)` is pure apart from probing whether
each process is alive; `options` takes `now`, `all`, and an `isAlive` of your
own. `runSleep(record, now)` returns the same `RunSleep` details directly,
or `undefined` for a run that is not sleeping; `now` defaults to `Date.now()`.
`ViewerRun.sleep` uses the `now` passed to `runsForViewer`.
The module also exports `runSessionId`, `RunSleep`, the types of a record, a watch, a
viewer, and an item, and `settledRunVisibleMilliseconds`. It only reads:
publishing stays with the runtime, and a viewer's watch list is changed with
`machine watch --for`.

**Naming the session.** A viewer shows the runs whose `owner` is its session
id, so the host and the runs it starts must agree on that id. Any host can set
`MACHINES_RUN_OWNER` in the environment of the commands it starts and pass the
same value to `--for`; the id may use letters, digits, `.`, `_`, and `-`. Where
it is not set, the id is the one the coding agent already gives its commands:

| Host | Variable | Given to |
| --- | --- | --- |
| Any | `MACHINES_RUN_OWNER` | Whatever the host starts with it set; takes precedence |
| Claude Code | `CLAUDE_CODE_SESSION_ID` | The commands a session runs; also the `session_id` its status line receives |
| Codex | `CODEX_THREAD_ID` | The commands a thread runs |
| Pi | `PI_SESSION_ID` | The commands its `bash` and `powershell` tools run, not `!` commands typed by the user |

The first one that is set names the session, in that order. A run started from
inside one of these agents is therefore owned by that session: it is shown
there, and in another session only when that session watches it.

## Troubleshooting

For an isolated global catalog, set `MACHINES_USER_HOME` to an absolute directory;
Machines reads global definitions and presets from that directory's `.machines/`.
Explicit programmatic `home` options take precedence. This is useful for tests or
separate workflow collections without changing the operating-system home directory.
A process with that variable also publishes its
[run status](#run-status-for-host-status-lines) under that directory.

- **Node cannot load TypeScript from a dependency:** install the built tarball;
  source exports are for checkout development. Keep workflow definitions outside
  `node_modules` and use Node 24 or later.
- **A definition has an error or missing Agent:** inspect `machine list` and
  `machine agents`, correct metadata or presets, and list again. Imports refresh
  on the next discovery call. Run preflight remains strict.
- **The Agent fails on a permission request:** ACP permission interaction is not
  implemented. Use a harness configured for the intended task; Human states
  handle workflow decisions, not ACP permission prompts.
- **A run disappeared after reload:** runs are session-scoped and have no durable
  resume mechanism. Inspect effects already produced before starting another run.
- **The Codex card is absent:** use `machine_status` and `machine_respond`; visual
  resource rendering depends on the MCP client.
- **Agent output is too noisy:** ACP callers can select `output: "capture"`;
  the launcher already captures final text. The CLI's `o` hotkey toggles normalized
  activity while an Agent runs and is suspended during Human input.
