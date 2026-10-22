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

A workflow can publish a current sentence with
[`p.status({ now })`](authoring.md#run-status). `machine runs`, the Claude status
line, and `machine ui` show it in their run lists, falling back to the usual state
display when absent. JSON records keep both `now` and the state's name. The
sentence survives sleep and continuation.

A workflow can also leave a lasting note with an optional HTML page using
[`p.status({ note, page })`](authoring.md#run-status). `machine ui` shows the page
under its note in a sandboxed frame with scripts, styles, resource loading and
links disabled. Finished or failed notes in `machine runs` have `(page)` appended
when an attachment is present. JSON status records expose `note` and `page` for
other observers. The pair survives sleep, continuation and stopping; an explicit
note takes precedence over the final output summary.

## Commands

```bash
machine limits [--forget <preset> | --forget-all]  # shared usage limits and their reset or next probe
machine agents                                  # presets, fallbacks and covering usage limits
machine runs [--json] [--all]                      # running, waiting and sleeping runs; --all adds finished and lost ones
machine runs --for [<session>] [--project <dir>] [--json] [--all]   # the runs one viewer shows
machine respond <run-id> <request-id> <response>   # answer a waiting run
machine watch [<run-id-or-label-start> | --dir <path>]     # show other runs on this session's status line
machine unwatch <run-id-or-label-start> | --dir <path> | --all
machine ui [--port <port>] [--project <dir>]       # a live page of every run, with its Machine drawn as a graph
```

- `machine limits` lists remembered failures across runs. See
  [Usage limits](authoring.md#usage-limits) for scopes, storage and isolation.
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

To prefer one provider across all allowed Agent chains from the next run:

```bash
machine agents
machine prefer claude codex --until 21:00
machine prefer
machine prefer --clear
```

The labels match each preset's `harness`. At preparation, listed providers come
first in that order; candidates sharing a provider and candidates with unlisted
or missing labels keep their relative order. Only the bound preset and its
configured fallbacks participate. A singleton chain is unchanged. Already
prepared or running Machines keep their order.

The preference is stored atomically in
`$XDG_STATE_HOME/machines/provider-order.json`, falling back to
`~/.local/state/machines/provider-order.json`. `MACHINES_USER_HOME` selects an
alternate home for catalogs and state; an XDG path outside that home is ignored.
`--until` accepts an ISO date and time or the next local `HH:MM`. Without it the
preference has no time expiry. `machine prefer` shows the saved order, expiry
and whether it is in effect. Expired files are retained but ignored. Unknown
harness labels are accepted with a warning when no current preset uses them.

Use `machine prefer claude --above 30` to apply the saved order only while the
preferred provider has more than 30% remaining. Combine it with `--until 21:00`;
either condition ending releases the preference. Preparation reads the first
configured preset of that harness with a `quota` hook. At or below the threshold,
it keeps the order from `agents.ts`. With no hook or an unavailable reading, the
preference still applies. `machine prefer` says the condition cannot be checked.

`machine prefer` fetches a fresh workspace reading each time, naming the preset,
remaining percentage and condition. Only `order`, `until` and `above` are stored;
readings are never persisted in the preference file. Expiry and low readings do
not delete the file, so a later reading above the threshold can apply it again.

`MACHINES_AGENT_PREFER=claude,codex` overrides the file for one process;
`MACHINES_AGENT_PREFER=` disables it. `MACHINES_AGENT_FALLBACK=off` keeps the bound
preset alone, as do states that handle their own limits with `onLimit`.
`machine agents` shows the effective order above its listing, marks presets of
the first provider as preferred, and shows each complete sorted chain in the
fallback column. A run announces a changed first candidate once per role.

### Temporary model and provider profiles

Define named profiles in `.machines/profiles.json`. The JSON object maps names
to definitions. Machines reads `~/.machines/profiles.json` first and the nearest
project file second, replacing a whole profile with the same name. The selected
Machines home follows `MACHINES_USER_HOME`, just like `agents.ts`. Definition files
are data and execute no code. Nothing is activated merely by defining a profile.

For example, this complete `burn-codex` definition uses existing Codex models and
requests Fast mode for all presets explicitly identified by `harness: "codex"`:

```json
{
  "burn-codex": {
    "order": ["codex"],
    "allowedProviders": ["codex"],
    "overrides": [
      { "provider": "codex", "options": { "serviceTier": "fast" } }
    ]
  },
  "mixed-priority": {
    "order": ["codex", "dsh", "my-api-account"]
  }
}
```

```bash
machine profile list
machine profile show burn-codex
machine profile use burn-codex --until 21:00
machine profile show
machine agents
machine profile clear
# Reuse the same definition later:
machine profile use burn-codex --until 23:00
```

These commands are examples; creating a definition does not run them for you.
`use` requires a future deadline: an ISO date/time or the next local `HH:MM`,
using the same parsing as `machine prefer`. It validates scoped adapter options
before saving the activation. It does not start an Agent or verify every Machine's
role bindings; preparation checks those chains. `show NAME` validates adapter
support in this workspace. `list` lists reusable names without dumping options.

The activation contains the profile name, normalized deadline and a copy of its
definition. It is atomically stored with mode `0600` in
`$XDG_STATE_HOME/machines/agent-profile.json`, otherwise
`~/.local/state/machines/agent-profile.json`, following the same alternate-home
isolation as provider preferences. Editing a definition takes effect when you
activate it again. `clear` removes only this activation; definitions and legacy
preferences remain. Expired activations remain inspectable but have no effect.
Malformed persisted activations fail preparation rather than silently releasing
the filter. Clearing a malformed activation is supported.

`order` stably sorts each role's existing bound-preset/fallback chain. Unlisted
providers retain their relative order. `allowedProviders` independently filters
that chain by exact `harness` identity; absent permits every candidate, `[]`
permits none, and a candidate without a harness cannot pass a present filter.
Neither setting adds a preset or a provider to a chain. Thus `burn-codex` requires
each role's chain to already contain a Codex preset. If no permitted candidate
remains, preparation names the role and fails before any Agent executes. A named
profile is user-wide while active, so other workspaces using that home also obey
its filter and must support its scoped overrides.

`mixed-priority` includes DeepSeek or an API-backed account only if that exact
identity is already configured in the role's permitted chain. The shipped
DeepSeek preset's identity is `dsh`; a custom `deepseekAgent` preset must
set its own `harness` explicitly for selection. Profiles do not enable providers,
create accounts, add credentials, opt into extra usage, or authorize spending.
Use separately configured presets with distinct harness identities for account
choices. All existing billing rules and provider/account entitlements still apply,
including any cost the configured account assigns to Fast or Ultrafast mode.

Precedence and limit behavior:

- `MACHINES_AGENT_PREFER`, including an explicitly empty value, overrides profile
  **order** for that process. The filter and tuning remain active.
- Otherwise an active profile's `order` (including `[]`) replaces `machine prefer`.
  Without a profile order, the normal saved preference and its `--above` condition
  apply. `--above` only releases that legacy order, never the profile filter or tuning.
- `MACHINES_AGENT_FALLBACK=off` keeps only the bound preset and suppresses ordering
  and quota hooks as before. If that preset is excluded, preparation fails; it
  cannot escape the filter through a fallback.
- `onLimit` still reports a limit without swapping or waiting. It uses the bound
  preset if allowed; otherwise it uses the first allowed preset in the original
  configured chain. Preference order does not change that report-only selection.
- Expiry, deactivation, new definitions and environment-order changes affect newly
  prepared runs. Prepared/running Machines and their children keep the snapshot.
  Continuing a saved checkpoint prepares a new run and resolves current settings.

`machine profile show` displays the saved snapshot, expiry status, effective order
and order source. `machine agents` displays the active profile, effective model
identity, excluded presets and filtered/sorted chains. The public launcher exposes
`PreparedMachineRun.profile` and `AgentPresetSummary.profile`/`permitted` for other
interfaces. The profile functions and types are exported from
`@dna113p/machines/launcher`; adapter tuning is also exported from the root package.

#### Model tuning and adapter capabilities

Each override must name a `provider`, a `preset`, or both (both must match).
Use one override per matched preset; overlapping overrides fail rather than
silently merging. An unmatched scope also fails, catching misspelled identities.
For example, to tune one existing preset:

```json
{
  "one-model": {
    "overrides": [{
      "preset": "codex-review",
      "model": "your-configured-model",
      "forModel": "your-configured-model",
      "options": { "effort": "high", "serviceTier": "ultrafast" }
    }]
  }
}
```

`model` changes the actual adapter model. `forModel` optionally requires the
adapter's resolved model to match exactly; it prevents model-specific options
from being used with another model, even when a preset's display label is stale.
This constraint fails preparation on a mismatch. Each adapter also validates its
own supported keys, values and declared model restrictions.

Existing `codexAgent(...)` runners automatically support `model`, `options.effort`
(`none`, `minimal`, `low`, `medium`, `high`, `xhigh`) and `options.serviceTier`
(`fast`, `ultrafast`). These translate to `--model`,
`--config model_reasoning_effort=...` and `--config service_tier=...`.
Profile tuning takes precedence over the runner's explicit tuning options and
its environment-derived tuning, without changing `process.env`. Untuned values
retain preset/default precedence. Tuned runners capture their environment at
preparation. Commands, existing arguments, sandbox, output, ephemeral behavior,
credentials and configured environment remain owned by the preset.

`claudeAgent(...)` supports `model` and `options.effort` (`low`, `medium`, `high`,
`max`), translating to `--model` and `--effort` while preserving permission/tool
restrictions and the extra-usage guard. These shipped adapters validate the
supported option vocabulary, **not** a universal model catalog. The installed CLI
and account determine which model names and tiers they can execute; Machines
cannot establish availability offline. Pin `forModel` or provide an adapter with
stricter model rules when needed. Other shipped runners, including DeepSeek,
currently support ordering/filtering but require explicit custom opt-in for tuning.

Unknown keys, invalid values, mismatched `forModel`, unsupported adapter-declared
model combinations and runners without a tuning capability fail during preparation.
The shipped adapters refuse profile controls for permissions, tools, env, secrets,
commands, arguments, authentication, extra usage and billing opt-ins. Keep profiles
free of secrets: inspection displays valid tuning, and custom adapters are trusted
preset code responsible for maintaining the same boundary.

Wrapping a runner in an ordinary function drops the tuning capability. A harness
or model label does not configure that wrapper. Use `withAgentTuning` to explicitly
validate and rebuild a wrapper around a tuned inner runner, or leave it untunable.
`configureAgentTuning(inner, tuning)` preserves the inner adapter's validation.

#### Extending a provider without changing core

The small public `AgentTuningAdapter` contract has one synchronous method:
`configure(tuning: AgentTuning): { runner, model?, thinking? }`. Its input is a
cloned, deeply frozen JSON object with optional `model` and `options`. The adapter
must reject all unsupported keys/values and model combinations, construct a fresh
runner without effects, preserve configured execution controls, and report its
actual identity. It must not mutate the original runner, use global environment
changes, grant tools, switch accounts, or authorize billing. The returned identity
also supplies model-scoped limit memory. As with existing custom runners, Machines
trusts this local code; it cannot prove a custom implementation obeys its contract.

This complete deterministic example can be put in `.machines/agents.ts`. It uses a
unique JSON option and a model restriction without any core provider registry or
external call. A real adapter would construct its provider runner in `make`.

```ts
import type { AgentRunner, AgentTuningAdapter, JsonValue } from "@dna113p/machines";
import { withAgentTuning } from "@dna113p/machines";

function make(model = "plain", options: Readonly<Record<string, JsonValue>> = {}): AgentRunner {
  const runner: AgentRunner = (_request, report) => {
    report?.({ type: "identity", harness: "local-grid", model });
    return { type: "completed", model, lattice: options.lattice ?? null };
  };
  const adapter: AgentTuningAdapter = {
    configure(tuning) {
      const selected = tuning.model ?? model;
      if (!["plain", "grid"].includes(selected)) throw new Error("Unsupported grid model");
      const values = tuning.options ?? {};
      if (Object.keys(values).some(key => key !== "lattice")) {
        throw new Error("Supported grid options: lattice");
      }
      if (values.lattice !== undefined) {
        if (selected !== "grid") throw new Error("lattice requires the grid model");
        if (!Array.isArray(values.lattice) || !values.lattice.every(n => typeof n === "number")) {
          throw new Error("lattice must be an array of numbers");
        }
      }
      return { runner: make(selected, values), model: selected };
    },
  };
  return withAgentTuning(runner, adapter);
}

export default () => ({
  grid: { description: "Deterministic grid adapter", harness: "local-grid", runner: make() },
});
```

Pair it with this reusable profile:

```json
{
  "grid-demo": {
    "allowedProviders": ["local-grid"],
    "overrides": [{ "preset": "grid", "model": "grid", "options": { "lattice": [2, 3] } }]
  }
}
```

After activating `grid-demo`, bind a Machine role to `grid`, for example
`machine run my-workflow --agent worker=grid`. The role's allowed outcomes must
include `completed`. Changing its model to `plain` while retaining `lattice` fails
preparation before the runner can execute.

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
