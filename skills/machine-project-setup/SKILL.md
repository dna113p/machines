---
name: machine-project-setup
description: Use proactively when acting as the project orchestrator to set up or refresh project-specific Machines for its major work. Inspect the project, build and verify useful workflows, and establish delegation routes before distributing work. Use for project onboarding or meaningful coverage gaps, not every task or an already-assigned worker state.
---

# Machine project setup

The project orchestrator owns this setup: the agent coordinating the project's
work and delegating assignments, not a particular model or a new runtime service.
Prepare the workflows that make delegation useful instead of asking each worker
to rediscover the process. Use this skill on project onboarding, when asked to set
up its workflows, or when a changed project or repeated task exposes a meaningful
gap. Read existing setup first; do not repeat a full setup on every task or session.
If already executing a Machine Agent state, complete that assignment directly,
unless the owner explicitly assigned this bounded setup itself.

This is an implementation skill, not a proposal-only checklist. Within the
requested project scope, choose, create, or adapt the Machines that support the
major work as you judge useful; the user need not enumerate them or approve each
local definition. Do not stop after listing opportunities when safe implementation
is possible. A good result is a small working set and a clear route into it, not
the largest catalog. Keep simple tasks direct.

## Understand the project before choosing workflows

Read its instruction files, architecture and entry points, package/build scripts,
tests, CI, and relevant current work. Identify its main responsibilities and task
types, quality gates, recurring failure modes, and decisions needing a Human.
Include domain-specific work, not just generic coding stages. Use only relevant,
available project context; distinguish observed needs from speculative ones.

Inspect the existing orchestrator instructions and any `.machines/README.md`.
Run `machine list` and `machine agents` in the actual work directories, or use
`machine_list` / `machine_agents` with the correct workspace. Read candidate
sources and their input, effects, results, and tests. Discovery imports trusted
code and `ready` means metadata/bindings, not a tested or authenticated harness.
Use [Integrations](../../docs/integrations.md) for a missing launcher; do not
invent preset names, installed tools, or model access.

Respect independent repository boundaries. The nearest `.machines/` directory
shadows ancestor project catalogs, so check each launch directory. A new child
catalog can hide inherited Machines; preserve needed routes with explicit paths
or existing project conventions. Put project policy with its owning project,
not automatically in the runtime, the umbrella, or a global installation.

## Build the smallest useful set

When the Dev Machines starter library is available, inspect its `docs/catalog.md`
and candidate `defaults/` sources before rebuilding a common software process.
Select or adapt relevant entries with the project-local installer; do not install
the entire catalog by default. Its check commands, Agent bindings, and task inputs
remain project-specific. Do not assume that library is globally installed.

Map the major work to existing or missing workflows. Favor frequent delegation,
important quality gates, and costly recurring mistakes. Reuse good definitions;
parameterize variants rather than creating one Machine per ticket or directory.
Possible sequences include implement -> check -> review, reproduce -> diagnose ->
repair -> regression check, domain artifact generation -> validation, or preparing
a release candidate -> checks -> Human decision. These are examples, not a fixed menu.
Do not install a generic suite unrelated to what this project actually does.

Use [machine-builder](../machine-builder/SKILL.md) and
[Authoring Machines](../../docs/authoring.md) to create or adapt project-local
`.machines/*.ts` definitions and focused tests. Choose the states and roles from
the work, including explicit failure/blocked outcomes and bounded repair loops.
Prefer Operations for mechanical checks and Agents for judgment. Required checks
must gate success; an Agent's completion claim is not verification. Preserve Human
approval boundaries and let the Machine own its transitions.

Give each workflow an input contract, launch directory, allowed effects, expected
final states, and useful JSON output or unique result artifacts. Workers need a
complete assignment, not this conversation. Use semantic roles and discovered
presets; keep harness/model selection separate from workflow policy. Do not mask
missing real bindings by installing fake presets into the project's live catalog.
Tests may inject fake runners in isolated fixtures. Prevent overlapping writes
when future delegation will run concurrently.

Creating definitions does not authorize executing the project's backlog, paid
model calls, commits, merges, publishing, production changes, service startup,
global installation, or expanded permissions. Preserve the user's actual scope
and budget. Add a Human decision where execution needs one; never manufacture its
answer. No usable harness or unsafe execution is a concrete blocker, not a reason
to pretend readiness. Implement and test the safe parts, then identify the gap.

## Give the orchestrator a delegation map

Maintain a compact `.machines/README.md` (or the project's existing equivalent)
using the [workflow map reference](references/project-workflows.md). Record which
major work uses which Machine, the exact launch directory and input, role bindings,
verification/results, and effects requiring approval. Mark deliberately direct,
deferred, or blocked work with reasons rather than inventing placeholder Machines.
Keep durable routing facts here; keep private per-run evidence out of source control.
The map is documentation, not a runtime registry or a second workflow engine.

Add a short route to that map and this skill in the existing project orchestrator's
instructions. When there is no separate orchestrator prompt, add a role-specific
section to the project's `AGENTS.md` and reuse the existing host instruction entry
points. Preserve unrelated guidance and host configuration. Make the skill actually
reachable through the project's established skill-installation route; resolve
symlinked source directories before following relative documentation links. Do not
edit global agent settings or install duplicate extensions as incidental setup.

For normal assignments, the orchestrator consults the map, validates the selected
Machine's current contract, and uses
[machine-delegation](../machine-delegation/SKILL.md) to launch and supervise it.
Workers execute their bounded state; they do not bootstrap the project again.
If no route fits, the orchestrator may build a task-specific Machine and promote
it into the map once useful. Update only affected workflows when requirements or
checks change, instead of rescaffolding everything.

## Verify and hand off

Verify discovery from intended launch directories and resolve all packaged/linked
skill entry points. Run focused tests through the real runtime using fake runners,
injected Human responses, and temporary workspaces. Exercise success, failing
checks, blocked results, invalid input, and bounded retry/escalation where present;
prove a failed required check cannot become success. Confirm result retrieval.
Run a relevant no-model workflow for real when safe, and inspect its final state
and evidence. Never launch a paid agent solely to demonstrate setup.

Report created/reused workflows, the routing-map location, verification commands
and results, and concrete unconfigured or untested paths. Distinguish authored,
discoverable/bound, fixture-tested, and live-verified; fixture tests are not live-agent proof.
Do not label a workflow ready for unattended execution just because it is listed.
On a second setup, preserve existing decisions and edits, update only demonstrated
gaps, and reuse passing checks; do not create duplicate definitions or instructions.
