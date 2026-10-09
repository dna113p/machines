# Project workflow map

Use this shape for `.machines/README.md`, adapting it to the project's actual
responsibilities. This is a routing guide, not a required set of Machines or a
runtime registry. See [machine-project-setup](../SKILL.md) and
[Authoring Machines](../../../docs/authoring.md).

## Routing information

Name the project scope and orchestrator owner. Describe the actual launcher
route and launch directories, including child catalogs that shadow their parent.
Use portable project-relative paths in committed documentation.

For each major task type, record:

- Exact Machine name/source, its trigger, input, launch directory, and role bindings.
- Expected final state, checks, result retrieval, and verification command.
- Allowed effects, Human decisions, retry limits, and untested prerequisites.

Mark deliberately direct, deferred, or blocked work with its reason. An existing
setup may need no new Machine. Do not generate placeholders to fill categories.
Include copyable invocations only for routes that exist. CLI positional input is
text; `--input-file <file|->` accepts JSON, as do MCP/Pi inputs. Resolve presets
from `machine agents`; discovery does not establish harness authentication.
A completed run ending in `blocked` is not a successful assignment.

Distinguish discovery, deterministic fixture proof, and live-agent execution.
Keep private receipts and transcripts out of Git. Record stable validation
commands and unresolved decisions without inventing approvals or successful runs.

## Orchestrator entry point

Add a short role-specific instruction to the existing orchestrator guidance:
read the map before delegation; use `machine-project-setup` for first setup or
meaningful gaps; use `machine-delegation` for normal assignments. Already-assigned
workers execute their bounded state instead of repeating project setup. Preserve
existing task scope, permissions, budgets, and Human decisions.

Use the project's existing skill-discovery route and verify that its source
resolves. Copied skills need their referenced sibling skills and documentation.
See [Integrations](../../../docs/integrations.md) for package/plugin routes.

## Maintenance

When a check, contract, or recurring task changes, update only the affected
Machine, tests, and route. Reuse good existing coverage instead of rebuilding a
suite each session. Check callers before retiring a route and preserve concurrent
work. Report implemented/reused workflows, validation evidence, and concrete gaps.
