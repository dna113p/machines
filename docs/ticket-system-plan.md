# Ticket automation implementation

Updated 2026-09-18. The implementation lives in the separate sibling
`auto-machines` repository, package `@dna113p/auto-machines`.

Machines supplies a public hosted-run interface, structured JSON input, and optional
JSON workflow output. It has no ticket-store, scheduling, or daemon dependency.
Existing string workflows, direct runs, MCP, and Pi continue to work.

## Ownership

- Source adapters discover eligible work, interpret dependencies, prepare launch
  input, and apply results to their tracker.
- The local daemon owns durable attempts, observations, Human response routing,
  interruption records, and retryable result delivery.
- Machines own workflow policy, verification, approvals, repository safety,
  worktrees, publication, and cleanup.

## Initial behavior

The first adapter reads and updates tk's Markdown tickets. Registrations provide
an execution workspace, ticket directory, and optional default Machine/bindings.
One ticket source can cover several repositories and a shared dependency graph.

Every unfinished, unblocked ticket is considered, without an automation tag or
concurrency limit. A ticket's Machine overrides the optional registration default.
Any exact discovered Machine name is eligible after validation. Missing or invalid
selections are visible errors; an invalid explicit selection never falls back.

The daemon records attempts before starting work, and records results before
writing them back. Failed delivery retries without repeating the workflow.
Restart interrupts unfinished attempts rather than replaying them. Explicit retry
starts another attempt. Local deduplication does not provide cross-host claims.

Tk Machines return complete, route, or hold outcomes. The adapter closes completed
tickets, creates a new request for routed work, or records findings for attention.
A final Machine state alone never closes a ticket. Concurrent ticket edits produce
visible conflicts and preserve the execution result locally.

## Delivery

The initial interface is a Linux daemon and CLI. A local Unix socket connects
clients to the execution owner; client disconnect does not cancel its runs.
A public adapter interface and daemon client support later tracker and harness
integrations without changing Machines runtime policy.

Tests use temporary tickets and deterministic runners, including installed-package
execution, upstream tk compatibility, concurrent Human requests, routing,
writeback failure, and daemon interruption. Real backlogs and paid agents are not
used for implementation verification. See the new repository's README for setup,
result contracts, and recovery behavior.
