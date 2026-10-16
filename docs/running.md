# Running, watching and continuing runs

The detail behind the [README](../README.md)'s run commands. The full reference
for run status records, continuation and answering is in
[Integrations](integrations.md#run-status-for-host-status-lines).

## Run status publication

Publication is on by default, in a private per-user directory
(`~/.local/state/machines/runs`, or under `XDG_STATE_HOME`), so nothing has to
be configured.

- Set `MACHINES_RUN_STATUS_DIR` to `off` to turn it off, or to a directory to
  move it.
- Runs hosted through `startMachineHost` publish when their host asks for it
  (`publishRunStatus: true`), and are answered through their host while
  active.
- A session shows the runs it started. `machine watch` adds runs it did not,
  such as a ticket a daemon runs.

## Commands

```bash
machine runs [--json] [--all]                      # running, waiting and sleeping runs; --all adds finished and lost ones
machine runs --for [<session>] [--project <dir>] [--json] [--all]   # the runs one viewer shows
machine respond <run-id> <request-id> <response>   # answer a waiting run
machine watch [<run-id-or-label-start> | --dir <path>]     # show other runs on this session's status line
machine unwatch <run-id-or-label-start> | --dir <path> | --all
machine ui [--port <port>] [--project <dir>]       # a live page of every run, with its Machine drawn as a graph
```

- `machine runs` shows each waiting run's prompt, request id and choices.
- A run started without a terminal, for example by a coordinating agent or a
  script, waits for `machine respond` instead of failing.
- Anything running as the same user can answer a waiting run, including an
  approval. See
  [answering a waiting run from outside](integrations.md#answering-a-waiting-run-from-outside).
- `watch` and `unwatch` take `--for <session>` first to manage another
  session's list. See [watching other runs](integrations.md#watching-other-runs).
- `machine runs --for` and the `@dna113p/machines/run-status` export answer
  which runs one session shows, so any application can
  [draw its own widgets](integrations.md#drawing-your-own-widgets).
- `machine ui` serves a local page of every published run. It draws each run's
  Machine with its current state and the path it took, answers waiting runs,
  and shows a project's own panels. See
  [watching runs in a browser](integrations.md#watching-runs-in-a-browser).

## Sleeping runs

Use `p.wait({ every: "10m" }, { due: "check" })` for a
[timed wait](authoring.md#timed-waits). By default its timer keeps the process
running. To sleep between checks without keeping a process open:

```sh
machine run my-workflow --sleep
machine continue <run-id>
```

`--sleep` requires run status publication.

**At a timed wait**, a sleeping run records its `due` time.

- Continuing before then reports that time and changes nothing.
- Once due, it takes the `due` transition, keeping `--sleep` for the next wait.

**At a Human request**, `--sleep` also ends the process. The sleeping record
holds `human` with the prompt, request id and choices, and no `due`.

- Answer it with `machine respond <run-id> <request-id> <response>`. This
  records `human.answer` and leaves the run sleeping.
- Wrong request ids, unoffered choices, discussion questions (`--question`) and
  second answers are refused.
- An unanswered `machine continue` reports the request and how to answer it,
  and changes nothing.
- After an answer, continuing uses it without asking again, checking the
  state's choices.
- Without `--sleep`, Human requests keep waiting in the running process.

**Where sleeping runs show.** `machine runs`, `machine ui` and the Claude
status line keep them visible even though their process has ended.

- They show the Human request or the due time. `machine runs --json` adds a
  `sleep` field with the same details and whether the request is answered or
  the wait is due.
- In the UI, an unanswered request has an answer form. Sending records the
  answer and says how the run wakes; there is no wake button.
- On the status line, an unanswered request needs attention just like a
  waiting run. An answered request or a timed wait uses a calm style with
  `answered` or its due time.

**Waking runs on a schedule.** An external scheduler or timer can call
`machine continue --due` to wake every answered or due sleeping run in order.
It skips runs started by a host, continues past failures, reports each
failure, and exits nonzero if any fail. Machines runs no background scheduler.

**Hosts** can use `startMachineHost({ machine, sleep: true, publishRunStatus: true })`.

- Its result includes `sleeping.human` with a request id, or `sleeping.due`.
- `machine respond` records a sleeping run's answer; its host wakes it with
  `startMachineHost({ continue: runId })`, keeping sleep for later waits.

## Continuing after a stop

Pi and MCP runs belong to the current session. Closing or reloading that
session ends the hosts it owns.

Published runs save a checkpoint at each state entry.
`machine continue <run-id>` continues an unfinished run after its process
stops, with the same id and trail.

- The saved step runs again from its start.
- Use [`p.data()` or XState context](authoring.md#saved-working-data) for data
  that must survive.
- Stopping a process does not undo files or Git changes.
- See [continuing a run](integrations.md#continuing-a-run) for checkpoint
  files and refusal rules.

A Machine owns its own retry, approval, merge and cleanup decisions. See
[Architecture](architecture.md) for ownership and process-lifecycle limits.

## Trust

Machine definitions and Agent preset files are **trusted executable code**.

- Discovery imports them, including their relative imports, to read their
  metadata. Keep module initialization free of side effects and do work inside
  states.
- Disposable discovery workers refresh imported metadata. They are not a
  sandbox.
- Operations and configured Agents run with the launching process's access
  and can change files or contact external services.

## Agent presets

ACP permission requests are not supported yet and fail the Agent state. Choose
a harness configuration that can carry out the bounded task, and put workflow
decisions in Human states.

The launcher runs unnamed Agents with `npx -y pi-acp`.
[Agent presets](authoring.md#agent-presets) select another ACP command or
runner explicitly.

| Preset | What it runs | Configuration |
| --- | --- | --- |
| `agy` | The Antigravity CLI, with AGY's permission checks on | [AGY](authoring.md#antigravity-agy): runner settings and explicit opt-in to automatic tool approval. `npm run example:agy` opts in for its temporary-directory demo. |
| `claude` | The installed Claude Code CLI, headless, with its existing login. Tools run only where Claude Code's own permission rules allow them; nothing prompts. | [Claude Code](authoring.md#claude-code): model, effort and tool-restriction presets |
| `codex` | The Codex CLI in a read-only sandbox | [Codex](authoring.md#codex): a preset that allows workspace edits, and running outside a Git repository |
| `chatgpt-web` | A new ChatGPT web conversation in a dedicated Chromium profile, working in the Agent's directory through rig-bridge | [ChatGPT Web](authoring.md#chatgpt-web): one-time connector and browser login setup |
| `deepseek` | DeepSeek Harness through `dsh --profile acp`, reusing the ACP runner and keeping DSH's configured permissions | [DeepSeek Harness](authoring.md#deepseek-harness-dsh): setup, custom profiles and configuration overlays |

Select one per role, for example
`machine run my-workflow --agent default=deepseek -- "Do the task"`.

### Decision runners

`decisionAgent(provider)` turns a classification into an Agent event without
changing the runtime. Every provider evaluates only the evidence it is given;
none is a coding agent.

| Provider | Preset | Notes |
| --- | --- | --- |
| `jevProvider()` | `jev` | Direct TypeSafe access |
| `openRouterDecisionProvider()` | `openrouter-decision` | Needs `OPENROUTER_API_KEY` |
| `layaProvider()` | `laya` | Self-hosted |
| `vonProvider()` | `von` | Self-hosted |

See [Self-hosted Laya/Von setup](local-decisions.md) for the opt-in Python
service and its deployment limits, and [Decision runners](authoring.md#decision-runners)
for swapping providers, confidence-aware routing and the opt-in live example.
