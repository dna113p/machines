---
name: machine-delegation
description: Use proactively before delegating implementation, debugging, review, research, or other bounded multi-step work. Prefer Machine runs to native sub-agents, reusing or creating a scoped workflow with explicit outcomes. The user need not name Machines; keep trivial work direct.
---

# Machine delegation

Use a Machine run as the unit of delegated work. The coordinating agent owns the
user's goal, task boundaries, and integration of results; the Machine owns its
states, verification, retries, and escalation. Complete small local steps directly.
Launch a suitable Machine instead of native sub-agents without requiring the user
to name this skill. Discovery is a decision step, not the completed work: start the
selected workflow and inspect its result. Use deterministic Operations for checks
rather than paying another model to run commands. Never broaden permissions or
model spending merely to satisfy the preference. If the tools or a safe workflow
are unavailable, state the concrete reason for proceeding directly.

If already running as a Machine's Agent state, execute that bounded assignment
and return its evidence/outcome. Do not delegate it again unless explicitly asked
for bounded nested work by the owning assignment.

## Choose or create the Machine

Inspect `machine_list` and `machine_agents` in the target workspace. MCP requires
an absolute `cwd`; Pi uses the conversation's working directory. With only a shell,
run `machine list` and `machine agents` there (`./machine` in a source checkout).
See [Integrations](../../docs/integrations.md) if the tools are unavailable.

Evaluate candidate Machines by their descriptions, then read their returned source
paths or use `machine show <name>`. Check input format, Agent roles, actual workspace,
output artifacts, final states, and effects such as commits or publishing. A matching
name alone does not establish that the workflow fits the delegated task.

Decide whether to reuse, adapt, or create a Machine using
[machine-builder](../machine-builder/SKILL.md). A generic Machine's ability to
accept the task as a prompt is only one consideration; choose a workflow whose
states express the decisions and verification the task needs. Authoring a
task-specific Machine is part of the delegated work and needs no separate
permission. Keep global installation and unrelated workflow changes outside that
scope. Use the [delegation starter](references/delegation-machine.md) when there is no existing
result contract to follow. Add review or bounded revision states when the work
needs them, and Human states for decisions that belong to the user.

List again after edits. Resolve required roles using exact preset names from
`machine_agents`, passing role-to-preset overrides at launch. A listing's readiness
only checks metadata and bindings; the harness still needs to be installed and
configured. The built-in `codex` preset is read-only. Choose or configure a preset
that can perform the authorized task, following the builder's authoring guide.

## Supply a complete assignment

Workers do not inherit this conversation. Supply the context needed to act:

- The bounded objective, relevant facts, and acceptance criteria.
- The absolute workspace, files or references to read, and ownership of any edits.
- Applicable constraints, permitted effects, and what should produce a blocked outcome.
- A result location readable by the coordinator, and what evidence it must contain.

Follow the selected Machine's input contract. MCP/Pi accept JSON-serializable
input; CLI positional input is text, while `--input-file <file|->` accepts JSON.
Keep task details in input rather than hardcoding each assignment into a new
workflow. Give each run a distinct artifact destination.

**Plan result retrieval before launch.** `machine_status` exposes state, Human
requests, errors, and optional JSON Machine output, not arbitrary Agent transcripts
or event payloads. Have the Machine return useful JSON output, have the worker
write a report, or capture its returned event and save it in an Operation. The
Machine-owned options also support read-only Agent presets. Include findings or
changes, verification evidence, and blockers. An Operation's writes must stay
within the task's scope even when the Agent itself is read-only.

Delegate independent tasks concurrently only when their workspaces and writes are
compatible. Use isolated worktrees for overlapping code changes; runs do not create
worktrees automatically. Pass prerequisites through explicit artifacts before
starting dependent work. Give workers bounded assignments to complete themselves;
nested delegation needs an explicit reason and scope.

## Launch and supervise

Call `machine_start` with the discovered Machine name, task input, workspace, and
any preset overrides. Record the returned `run.id` with its task, workspace,
expected success state, and result path. Start once; a slow response is not a
reason to launch a duplicate. If the launch response is lost, inspect this session's
statuses before deciding whether another run is needed.

Continue independent work while the run executes. Read `machine_status` with its
exact `runId` when progress or a result is needed, spacing checks rather than
polling continuously. Interpret the current snapshot:

| Status | Coordinator action |
| --- | --- |
| `running` | Continue independent work or wait before checking again. |
| `waiting` | Read `human.prompt` and its choices or suggestions. Relay the question if the user's answer is not already clear from the conversation. Submit that answer with `machine_respond`, using the exact `runId` and current `human.requestId`; restrictive choices require an exact string. |
| `completed` | Check the final state and read the result artifacts. A final state such as `blocked` or `rejected` also counts as a completed run. |
| `failed` | Read the error and inspect partial effects. Correct the cause or report the blocker before considering a fresh run. |

Preserve existing user authorization when answering Human requests, and surface a
new decision when the request requires one. A desire to finish is not an answer.

The CLI fallback is `machine run <name> [--agent role=preset] -- <input>` in the
target workspace. It waits for completion and uses terminal Human input; retain
the shell session if running it asynchronously. It does not return an MCP run ID.

The current tools have no per-run cancel, arbitrary message, or resume operation.
`machine_respond` answers a pending Human request; it cannot steer a running Agent.
Edits to a definition apply to future runs. MCP/Pi runs belong to their session:
closing or reloading it terminates owned work, and only a limited number of finished
snapshots are retained. Keep needed evidence in artifacts. After interruption,
inspect existing effects before restarting; a new run is not a continuation or rollback.

## Collect and integrate

Finish only after the intended final state and requested artifact or effect are
verified. Read the report and inspect relevant changes or checks, then integrate
the result into the user's task. If evidence is missing, treat that as incomplete
work even if the run says `completed`. Report the useful result, any blocker, and
artifact paths; a run ID alone is not the delegated deliverable.
