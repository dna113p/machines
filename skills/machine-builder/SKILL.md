---
name: machine-builder
description: Use proactively for multi-step implementation, debugging, review, or verification that benefits from explicit stages and decisions. Discover and use a suitable Machine, or design and verify a task-specific TypeScript workflow. The user need not explicitly request Machines; keep trivial work direct.
---

# Machine builder

For project-wide workflow setup owned by the project orchestrator, start with
[machine-project-setup](../machine-project-setup/SKILL.md). It chooses coverage
for the project's major work; use this builder to implement individual definitions.
Do not repeat project setup for each assignment.

Before starting multi-step work, discover suitable Machines instead of waiting for
the user to ask for one. Use an existing workflow when it fits; writing a new
Machine is not the goal. For delegated work, follow
[machine-delegation](../machine-delegation/SKILL.md). If already executing an Agent
state inside a Machine, do that assigned work directly rather than recursively
wrapping it in another Machine. Preserve the authorized effects and model budget.

Decide which workflow serves the user's task. Creating or adapting a project
Machine is an implementation choice within the authorized task; proceed without
separate permission to author it. Choose its states, roles, branches, and completion
conditions from the work itself. A Machine can be useful for one assignment;
future reuse is optional. Keep small steps direct when a workflow adds no value.

Use [Authoring Machines](../../docs/authoring.md) for the definition contract and
examples. Before choosing a workflow, inspect available Machines and Agent presets
with `machine list` and `machine agents`, or the connected `machine_list` and
`machine_agents` tools. Reuse, adapt, or create a definition based on the task's
needs. Existing Machines and examples are starting points, not a fixed menu.
Make consequential checks and decisions explicit in states when they need to
control progress. Choose the complexity needed to complete the task reliably.

Machine Shop is an optional starter library of common software-task Machines,
kept in its own repository at `https://github.com/dna113p/machine-shop`. Nothing
here requires it; clone it to try a default or adapt one, as
[machine-project-setup](../machine-project-setup/SKILL.md) describes.

Look for common task sequences and recurring manual workflows while doing the
work. Convert them into Machines when explicit steps would improve repeatability
or code quality. Parameterize assignment details so the workflow can serve the
next task. Build around the process observed in the project.

Use deterministic Operations for mechanically checkable work: project type checks,
focused tests, linting, schema or artifact validation, and filesystem or Git
invariants. Inspect actual exit codes and outputs, record useful evidence, and
route failures to repair, escalation, or a blocked result. Required checks must
pass before success; an Agent's claim of completion is not verification. Use
Agents for judgment and open-ended changes, with bounded repair loops where
appropriate. Choose checks that establish the task's completion conditions.

For a new definition, capture the intended states, returned events, and completion
condition. Put the definition in the requested location; project `.machines/` is
the default for project-specific work. Authoring a Machine does not expand the
task's authorized effects; preserve that scope when running it. Global installation
is a separate choice.

Export a non-empty one-line `description` explaining when to use the Machine and
a default factory accepting the supplied primitives and input. Import runtime
types from `@dna113p/machines`, for example:

```ts
import type { Event, MachinePrimitives } from "@dna113p/machines";
```

Use public package exports for runtime imports and relative imports for
project-local helpers. A sibling checkout's `src/` is not the package interface.
Install the package locally when editor or type-checker resolution is needed;
the launcher supplies primitives and type-only imports are erased at execution.

Declare semantic `agentRoles` for named Agents, then use those exact roles in states.
Select harnesses and models through presets, keeping environment details out of
workflow policy. A provider usage limit normally swaps to a fallback preset or
waits; give an Agent state `onLimit: "<event>"` only when the workflow itself
should branch at a limit, for example to skip a cross-provider review or ask a
Human. The [bundled examples](../../dist/examples/) show runtime usage
after the package is built; authoring examples in the guide also work before a build.

Keep module initialization side-effect free: discovery imports definitions and
their helpers. Put external work inside Operations or Agent requests so preflight
can finish before effects occur. Let XState choose the next state from the event
returned by a primitive. Use Human `suggestions` when free-form feedback is useful
and `choices` when only the declared responses are valid.
Use `present: "presenter"` with an optional Agent role to explain a Human question from the run history; `presentWith` supplies Machine facts.

Verify discovery and bindings, then exercise the intended branches with fake
Agent runners or injected Human input where possible. A successful run reaches
the intended final state and produces the requested artifact or effect. Run real
external work only within the user's authorized scope. Report what was verified
and any branch that still requires a configured harness or human interaction.

## Checks the Machine owns

Restrict by reversibility, not by judgment. Preserve explicit assignment constraints.

| Reported: the Agent decides | Enforced: the Machine stops, or a person decides |
| --- | --- |
| Scope additions and assumptions | Forbidden paths and irreversible effects: publishing, deleting or migrating data, contract changes, force pushes, credentials |
| Edge cases, review notes, test/plan ordering, authorized worktree commits | Unmet acceptance criteria, regressions, safety defects, weakening or deleting existing tests |

### Always

- Keep the project's gate list in one place that every route reads. Enforced.
- Run layered checks: shape and focused always, area suites when changed paths
  match their `when` globs, independent groups concurrent. Report all failures;
  a repair reruns only the failed check. Enforced.
- Deterministic Operations judge checks, never an Agent's claim. Enforced.
- Forbidden paths and irreversible effects are hard stops; require authorization
  before an irreversible effect. Enforced.
- A run with green checks delivers a draft with its open findings instead of
  sleeping; delivery does not authorize irreversible effects. Reported.
- Ask for one advisory review with structured acceptance, regression and safety
  findings. Let an Operation, not the reviewer's verdict word, decide the next
  state; only those findings cause one revision. Enforced; other notes are reported.
- Match a reviewer's findings across rounds by their place in the conversation,
  never by their wording. Reported.
- A stuck run ends with its work kept and a written note of unresolved findings
  and any enforced stop; do not silently discard partial work. Reported.
- Tell editing Agents that checks they cannot run in their environment are the
  workflow's to run, so a sandboxed Agent returns its work instead of `blocked`. Enforced.

### On request

- Write tests first with an Operation observing a red check before implementation,
  then green after it. Enforced when requested; otherwise test ordering is reported.
- Add a read-only falsify step: is the assignment wrong, already done, or underspecified?
  Require options and a recommendation for questions. Reported unless an enforced issue.
- Add a hard scope check: an Operation compares the changed paths against allowed
  paths after each editing Agent. Enforced when requested; otherwise additions are reported.
- Add a second review round. Reported findings; enforced issues still gate delivery.
- Add a Human state for a budget decision. Enforced when requested; otherwise
  a used-up budget with green checks delivers with reported findings.

## Recovering from failures

Not every step needs a failure path. A step needs one only when its failure is
expected and something sensible can happen next. Let pure logic throw: a thrown
error fails the run visibly, which is better than a quiet ending. Catching an
error only to end the run hides it.

- A passing outside failure (network, `gh`, registry, a lock file): use the
  [Operation `retry` option](../../docs/authoring.md#retrying-a-passing-failure).
- An Agent crashes or returns nothing: use the
  [default re-ask and a `fallback` role](../../docs/authoring.md#agents).
- An Agent report has the wrong shape: use Machine Shop's optional
  [send-back helper](https://github.com/dna113p/machine-shop/blob/main/docs/catalog.md#recovery).
- A check may be flaky: use Machine Shop's optional
  [single rerun](https://github.com/dna113p/machine-shop/blob/main/docs/catalog.md#recovery).
- A stop that needs explanation: add an optional Human `present` role; it fills presentation fields without changing the question or blocking it.
- An irreversible decision or a login: ask a person by
  [sleeping on a Human question](../../docs/integrations.md#continuing-a-run).
  A scope change is reported. A used-up budget with green checks delivers.
- "This task cannot be done": use a
  [declared failed ending](../../docs/authoring.md#declared-endings).
