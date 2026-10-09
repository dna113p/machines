---
name: machine-builder
description: Use proactively for multi-step implementation, debugging, review, or verification that benefits from explicit stages and decisions. Discover and use a suitable Machine, or design and verify a task-specific TypeScript workflow. The user need not explicitly request Machines; keep trivial work direct.
---

# Machine builder

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
workflow policy. The [bundled examples](../../dist/examples/) show runtime usage
after the package is built; authoring examples in the guide also work before a build.

Keep module initialization side-effect free: discovery imports definitions and
their helpers. Put external work inside Operations or Agent requests so preflight
can finish before effects occur. Let XState choose the next state from the event
returned by a primitive. Use Human `suggestions` when free-form feedback is useful
and `choices` when only the declared responses are valid.

Verify discovery and bindings, then exercise the intended branches with fake
Agent runners or injected Human input where possible. A successful run reaches
the intended final state and produces the requested artifact or effect. Run real
external work only within the user's authorized scope. Report what was verified
and any branch that still requires a configured harness or human interaction.
