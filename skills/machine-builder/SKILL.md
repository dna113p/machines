---
name: machine-builder
description: Create or edit TypeScript workflow definitions for the Machines runtime, including discovery metadata, Agent roles, Operations, Human decisions, and transitions. Use for reusable Machines workflows, not unrelated XState applications or runtime internals.
---

# Machine builder

Use [Authoring Machines](../../docs/authoring.md) for the definition contract and
examples. Before choosing a workflow, inspect available Machines and Agent presets
with `machine list` and `machine agents`, or the connected `machine_list` and
`machine_agents` tools. Adapt a matching workflow when it fits the user's scope.

For a new definition, capture the intended states, returned events, and completion
condition. Put the definition in the requested location; project `.machines/` is
the default for project-specific work. Global installation is a separate choice.

Export a non-empty one-line `description` explaining when to use the Machine and
a default factory accepting the supplied primitives and input string. Declare
semantic `agentRoles` for named Agents, then use those exact roles in states.
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
