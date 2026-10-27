---
name: machine-delegation
description: Use proactively before delegating implementation, debugging, review, research, or other bounded multi-step work. Keep work this conversation understands; delegate what does not need its context, preferring Machine runs to native sub-agents, reusing or creating a scoped workflow with explicit outcomes. The user need not name Machines; keep trivial work direct.
---

# Machine delegation

When acting as project orchestrator, consult the project's `.machines/README.md`
or existing workflow map before choosing a route. On initial setup or meaningful
missing/stale coverage, use [machine-project-setup](../machine-project-setup/SKILL.md)
to build the useful project workflows before repeated delegation. Reuse established
coverage for normal tasks; workers do not repeat project setup.

The conversation that understands a piece of work should do it; handing it to a
fresh Agent loses that context. Delegate when the context is not needed: a separate
feature that can run in parallel, a review that needs clean eyes, or work for later
as a ticket. Split work by context, not by kind: changes whose decisions depend on
each other stay in one conversation or ticket; unrelated changes get their own.
Keep using Machines for what they add: deterministic Operations for checks, a
fresh Agent for review, and a route that delivers the finished work.

When you do delegate, use a Machine run as the unit of work instead of a native
sub-agent, without requiring the user to name this skill. The coordinating agent
owns the user's goal, task boundaries, and integration of results; the Machine owns
its states, verification, retries, and escalation. Discovery is a decision step,
not the completed work: start the selected workflow and inspect its result. Never
broaden permissions or model spending merely to satisfy the preference. If the
tools or a safe workflow are unavailable, state the concrete reason for proceeding directly.

If already running as a Machine's Agent state, execute that bounded assignment
and return its evidence/outcome. Do not delegate it again unless explicitly asked
for bounded nested work by the owning assignment.

## Choose or create the Machine

Restrict by reversibility, not by judgment. Preserve explicit assignment constraints.

| Reported: the Agent decides | Enforced: the Machine stops, or a person decides |
| --- | --- |
| Scope additions and assumptions | Forbidden paths and irreversible effects: publishing, deleting or migrating data, contract changes, force pushes, credentials |
| Edge cases, review notes, test/plan ordering, authorized worktree commits | Unmet acceptance criteria, regressions, safety defects, weakening or deleting existing tests |

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
needs them, and Human states only for enforced-column decisions.

List again after edits. Resolve required roles using exact preset names from
`machine_agents`, passing role-to-preset overrides at launch. Listed readiness checks
only metadata and bindings, not an installed harness. The built-in `codex` preset is
read-only; choose or configure one that can perform the authorized task.

## Supply a complete assignment

Workers do not inherit this conversation. Supply the context needed to act:

- The bounded objective, relevant facts, and acceptance criteria.
- The absolute workspace, files or references to read, and ownership of any edits.
- Applicable constraints, permitted effects, and what should produce a blocked outcome.
- A result location readable by the coordinator, and what evidence it must contain.

State these five fields for each assignment:

1. Its goal.
2. The paths it may change.
3. Its acceptance criteria.
4. How it will be verified.
5. What is forbidden.

A field that cannot be filled means the unit is not scoped yet.

Write a ticket or assignment as the problem and its fences, not the design: the
Goal (who needs what, and why), Acceptance as observable results, what is Forbidden,
and where the context lives, such as the originating conversation or thread. Paths
are a hint. Leave implementation choices, exact wording, and test lists to the
Agent; it reports them as assumptions.

Require a non-empty `summary` with evidence, plus optional string-list result fields:

- `assumptions`: answers the Agent assumed.
- `scopeAdditions`: paths or work added beyond the initial scope, within authorization.
- `openQuestions`: irreversible questions only; report other uncertainty as findings.
- `needs`: what a person must supply or decide on `blocked`.

Follow the selected Machine's input contract. MCP/Pi accept JSON-serializable
input; CLI positional input is text, while `--input-file <file|->` accepts JSON.
Keep task details in input rather than hardcoding each assignment into a new
workflow. Give each run a distinct artifact destination.

**Plan result retrieval before launch.** `machine_status` exposes state, Human
requests, errors, and optional JSON Machine output, not Agent transcripts or event
payloads. Have the Machine return JSON output, have the worker write a report, or
save its returned event in an Operation, whose writes stay within the task's scope
even when the Agent is read-only. Include findings or changes, evidence, and blockers.

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

Continue independent work while the run executes; read `machine_status` with its
exact `runId` when a result is needed. In Pi 1.4+, `machine_start` registers the
initiating session for wake delivery on completion, failure, and each new
unanswered Human request: yield the turn when no independent work remains, and
avoid blocking wait tools and status polling. On a wake, retrieve `machine_status`
with the message's exact run id before reporting or relaying the current Human
question. A wake never authorizes an agent to answer a Human decision itself.

For an external run, call `machine_attach({ target: "<ticket-or-run-id>" })` in the
Pi session that should continue; `machine_detach` with the same target cancels it.
Attachment observes without owning, answering, or stopping the run, and
`machine_watch` stays passive. See the
[Pi integration](../../docs/integrations.md#wake-the-coordinating-pi-session) for
the shared run-status directory, reloads, closed sessions, and retrieval limits.

| Status | Coordinator action |
| --- | --- |
| `running` | Continue independent work or wait before checking again. |
| `waiting` | Read `human.prompt` and its choices or suggestions. Relay the question if the user's answer is not already clear from the conversation. Submit that answer with `machine_respond`, using the exact `runId` and current `human.requestId`; restrictive choices require an exact string. |
| `completed` | Check the final state and read the result artifacts. A final state such as `blocked` or `rejected` also counts as a completed run. |
| `failed` | Read the error and inspect partial effects. Correct the cause or report the blocker before considering a fresh run. |

Preserve existing user authorization when answering Human requests, and surface a
new decision when the request requires one. A desire to finish is not an answer.

A `blocked` or parked run is a completed run to read, not a failure to retry blindly.
A run with green checks delivers a draft with open findings; only an enforced stop
parks it, with work kept and a written note of what remains. Resolve mechanical
failures within the workflow; take irreversible decisions or login needs to a person.
Read the note before continuing from the kept work through the owning interface.

Tell an editing Agent that checks it cannot run in its environment are the
workflow's to run, so a sandboxed Agent returns its work instead of `blocked`.

To display an external run, use `machine watch <ticket-or-run-id>` where status
is published. `machine runs` lists available runs; `--all` includes ended runs.
Watching only displays status; it neither owns nor answers the run.

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

Read the reviewer's structured report: each acceptance criterion met or not,
findings tagged by severity. Let an Operation, not the reviewer's verdict word,
decide what happens next.
