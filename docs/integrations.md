# Integrations

## Agent defaults

MCP initialization and Pi's tool guidance now direct coordinating agents to
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

## Project orchestrator setup

Use [machine-project-setup](../skills/machine-project-setup/SKILL.md) when the agent
is taking responsibility for initial project workflow setup, or meaningful gaps
prevent useful delegation. The orchestrator inspects actual project needs, creates
or adapts useful definitions and tests, and writes a compact `.machines/README.md`
(or updates the project's existing workflow map). Link that map from its existing
orchestrator instructions or a role-specific section of `AGENTS.md`.

The setup skill chooses project coverage; `machine-builder` implements individual
workflows; `machine-delegation` launches and supervises assignments. No new
orchestrator runtime or daemon is required. Existing coverage is reused instead
of scaffolding a generic suite or repeating setup on every task. Already-assigned
workers complete their state directly. Missing harnesses remain visible blockers,
and fixture validation is not evidence of live-agent performance or adoption.

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
| `machine_agents` | Absolute `cwd`; configured Agent preset names and metadata |
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

Pi exposes the same five tools using the conversation's current directory, with
a status widget and native Human dialogs. Canceling a dialog leaves its Machine
waiting; answer later through `machine_respond` with the current request ID.
Pi exit, session replacement, and reload terminate its session-owned runs.

## Run status for host status lines

Pi and MCP Apps clients render run snapshots in-process. A host that can only run
a command, such as Claude Code's status line, reads published run status instead.
Publication is opt-in: set `MACHINES_RUN_STATUS_DIR` to an absolute directory.
When it is unset nothing is written.

`machine run` and the MCP server then keep one file per run,
`<dir>/<runId>.json`, replaced atomically on each change (directory `0700`, file
`0600`):

```json
{
  "schemaVersion": 2, "id": "1a2b3c4d-…", "pid": 4242, "owner": "<session id>",
  "machine": "ticket", "path": "/work/.machines/ticket.ts", "cwd": "/work",
  "status": "running", "state": "review",
  "agent": { "harness": "claude", "model": "opus", "thinking": "high" },
  "startedAt": "2026-03-04T05:06:07.000Z", "updatedAt": "2026-03-04T05:08:12.000Z"
}
```

`status` is `running`, `waiting`, `completed`, or `failed`. `state` is the current
state as a string (JSON for a nested state). `agent` is present while an Agent
state has reported its identity, and `error` after a failure. `owner` is
`MACHINES_RUN_OWNER` when set, otherwise `CLAUDE_CODE_SESSION_ID`, otherwise
absent. `stateSince` is when the current state was entered. `label` is the first
line of `MACHINES_RUN_LABEL` (at most 160 characters) when a launcher sets it to
say what the run is for, such as a ticket id and title; it is the launcher's
choice to publish that text. `machine run` exports its run id as
`MACHINES_RUN_PARENT`, so a Machine started by one of its Operations or Agents
records that id as `parent`; the status line shows only top-level runs.

A run waiting for Human input is `waiting` and records the pending request in
`human`:

```json
"human": {
  "prompt": "Publish version 0.4.0?", "requestId": "9f8e7d6c-…",
  "choices": ["publish", "hold"]
}
```

`requestId` is new for every request. `choices` restricts the response to those
values; `suggestions` are offered but any text is accepted; `discussion: true`
means the request also takes a question. Each is present only when the Human
state has it. Records written before these fields existed have `schemaVersion`
1 and only `human.prompt`; readers should accept both versions. Once a run has
taken a response from its inbox, its record lists that delivery's id in
`deliveries`, which is how `machine respond` knows its response was applied. An
id stays listed for at least a minute, however many responses the run takes
after it, and never contains the response.

Machine input, Machine output, and Human responses are never recorded. A Human
prompt and its choices are written to the `0600` file while the request is
waiting, so choose a directory only you can read. Publication cannot change a
run: a missing or unwritable directory is ignored. Starting a run prunes records
that finished, or whose process is gone, more than an hour ago.

### Answering a waiting run from outside

With publication on, a waiting run can be seen and answered by any process
running as the same user: a terminal, a coordinating agent, a script, or a
presentation surface. They all read the same request, and the first valid
response wins. Set the same `MACHINES_RUN_STATUS_DIR` for the run and for
whatever answers it.

```bash
machine runs                 # running and waiting runs
machine runs --json          # the same runs as their records
machine respond <run-id> <request-id> <response>
machine respond --question <run-id> <request-id> <text>
```

`machine runs` prints each run's id, Machine, status, and state, and for a
waiting run its prompt, request id, and choices (tab-separated when its output
is not a terminal):

```text
1a2b3c4d-…	release	waiting	approve
  Publish version 0.4.0?
  request: 9f8e7d6c-…
  choices: publish, hold
```

`machine respond` checks the response against the current record before it
delivers anything. It fails with a nonzero exit when the run is unknown, is not
waiting, is waiting on a different request id, or restricts `choices` to values
that do not include the response. `--question` sends a discussion question
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
inbox or finishes, and a new response is refused until then. **Anything that can write to the directory as you can answer a waiting
run**, including approvals, so do not point `MACHINES_RUN_STATUS_DIR` at a
shared directory.

`machine run` still asks on its own terminal, and whichever of the terminal and
the inbox gives the first valid response is used. Terminal input outside a
request's `choices` is reported and asked for again instead of failing the run.
A published run started without terminal input, for example by a coordinating
agent or a script, waits for `machine respond` instead of failing, and prints
the exact command to its standard error. With publication off it fails at its
first Human state with "Terminal input closed before a response", as before.
Runs hosted by the MCP server take a response from their own `machine_respond`
tool or from the inbox. That tool is answer-only, so a question to a hosted
request that allows discussion goes through the inbox with
`machine respond --question`.

For Claude Code, set the variable in the `env` of its settings so the runs it
launches publish there, and call the dependency-free renderer from `statusLine`:

```json
{
  "env": { "MACHINES_RUN_STATUS_DIR": "/home/you/.cache/machines/run-status" },
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

A session sees the runs it owns; runs without an owner appear in sessions whose
project directory contains the run's working directory. Finished runs stay for
30 seconds. A run whose process disappeared without finishing is shown as `lost`
for the same time, so the status line must run where it can see that process.
Set `NO_COLOR` (to any value, even an empty one) for plain text and `COLUMNS`
to change the 120-column truncation.

## Troubleshooting

For an isolated global catalog, set `MACHINES_USER_HOME` to an absolute directory;
Machines reads global definitions and presets from that directory's `.machines/`.
Explicit programmatic `home` options take precedence. This is useful for tests or
separate workflow collections without changing the operating-system home directory.

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
