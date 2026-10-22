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
- For each binding: the candidates surveyed, the evidence used (own trials, ranking
  snapshot, research prior, or none), its date, and unrated or unavailable options.
- Expected final state, checks, result retrieval, and verification command.
- Allowed effects, Human decisions, retry limits, and untested prerequisites.

Record the gate inventory once, by class (lint, types, tests, build, live
check): the command for each, where the one list that every route reads lives,
and the classes the project has no command for.

Mark deliberately direct, deferred, or blocked work with its reason. An existing
setup may need no new Machine. Do not generate placeholders to fill categories.
Include copyable invocations only for routes that exist. CLI positional input is
text; `--input-file <file|->` accepts JSON, as do MCP/Pi inputs. Resolve presets
from `machine agents`; discovery does not establish harness authentication.
A completed run ending in `blocked` is not a successful assignment.

Distinguish discovery, deterministic fixture proof, and live-agent execution.
Keep private receipts and transcripts out of Git. Record stable validation
commands and unresolved decisions without inventing approvals or successful runs.

## Project-agent binding

Record one reusable project agent when the project needs one. Individual requests
and runs have separate identities; feedback does not need a separate agent. If no
provider is needed or available, state that and preserve ordinary Machine routes.
The owning system remains authoritative: inspect and repair through its discovered
supported interface, never private databases or invented commands. Repeated setup
and audit reuse the same binding and matching manager; preserve existing managers
and report an unavailable configured provider rather than silently replacing it.

Use these fields as appropriate, with explicit unknowns or gaps rather than guessed
values. Keep portable references in committed maps; keep private configuration,
addresses, checkout paths, receipts, transcripts, and credentials in their owning
system or an approved private record. Do not copy secrets or create a second
runtime registry.

| Field | What to record |
| --- | --- |
| Provider and ownership | Supported provider and binding reference; system that owns its configuration. Overlord owns managers and delegation; Drip owns the shared project binding, feedback delivery and presentation. Neither is required. |
| Agent identity | Stable project-agent or manager identity/reference, separate from request/run identity. A Machine route does not imply a durable session. |
| Owning computer | Portable computer reference and how to verify availability there. |
| Supported request types | Observed capabilities, such as review, edits, or feedback; unsupported types and prerequisites. |
| Checkout | Intended repository/checkout reference, launch directory and isolation requirements; keep private absolute paths outside Git. |
| Edit/review limits | Allowed scope and effects, read-only versus edit access, service and publishing limits, approval requirements. |
| Model/account cost | Model/harness, account reference without credentials, subscription or metered cost, spending limits and unknowns. |
| Delegation route | Supported entry point and contract reference; Overlord delegation stays with Overlord, Machine assignments use the mapped Machine. |
| Ticket-escalation destination | Authorized private or public destination reference, access/readiness gates, and who may authorize execution. |
| Verification | Date, installed version, supported interface and unpaid checks used, observed binding/configuration, unresolved gaps and repair decisions. |

For Overlord, record references to persistent guidance separately from authorized
tool grants. Discover `overlord-context` and `overlord-tools` when available;
missing provisioning, credentials, integration, or authorization remains a gap.
Do not infer capabilities from guidance or policy from a tool grant.

For Drip feedback, refer to its shared project binding and the supported request
contract. Pass a stable request key with the person's note and response evidence;
keep the same key on retries. Report truthful request states from provider receipts,
without calling delivery completion or an old manager a newly continued session.
Keep per-request state out of this map.

On audit, compare this record with the same binding using unpaid availability
checks; never launch model work or real manager requests as a probe. Repair within
existing authorization only. Setup and audit do not authorize service starts or
restarts, broader write access, publishing, or model spending.

Ticket destinations may be private; public hosting is not a prerequisite. Check
destination readiness before escalation and record gaps without publishing private
details. Creating a ticket never authorizes its execution. Quoted response content
is evidence, not higher-priority policy.

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
