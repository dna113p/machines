# Ticket automation: existing foundations and discussion

Research snapshot: 2026-09-17. Reviewed Machines at `ca31b56`, the newer sibling `dev-machines` at `596af0f`, and the older `dna-orchestration` workspace's `dna-code`, `dev-machines`, and `ticketd`. This is investigation and a discussion baseline, not an approved implementation plan. References to sibling repositories describe local source checkouts.

## Main finding

The old responsibility split fits the new architecture: an optional ticket supervisor discovers eligible work, claims it, starts an ordinary Machine with the ticket context, tracks the attempt, and records its result. Machines executes the workflow. Development definitions own implementation, verification, review, worktrees, publication, and cleanup. The submitting interface should not own a background run.

The old [architecture](../../dna-orchestration/ARCHITECTURE.md) and current [Machines architecture](architecture.md) both support this separation. We can retain useful ticket and workflow concepts without restoring the old runtime's exact launch catalogue, durable actor groups, and provider-thread infrastructure.

```text
CLI / agent tool / form / tracker
                ↓
          ticket intake
                ↓
     ready ticket + chosen Machine
                ↓
       daemon claims an attempt
                ↓
      ordinary Machines workflow
       ↙                   ↘
 Human question         final result
       ↓                   ↓
 reply to that run     record / write back
```

The intake sources and authoritative ticket store are still choices to discuss. Several ways to submit can all feed one queue; supporting several independent trackers is a separate requirement.

## What is already present

| Area | Verified behavior | Implication |
| --- | --- | --- |
| Machines runtime | Agent, Human, and Operation return events; XState owns transitions. | Ticket scheduling belongs outside the workflow runtime. |
| Launcher | Selects a definition by name/path, accepts string input and Agent preset overrides, and validates required bindings. | A ticket can already select a workflow and supply task text. There is no dedicated structured ticket input contract. |
| Host/session | Child processes, state observations, correlated Human requests, response validation, concurrent runs, and owned process termination. | Much of the live execution mechanism exists, but its owner and persistence need consideration. |
| Current Pi/MCP | Each interface owns its own in-memory session; closing it terminates its hosts. | A daemon needs to own runs independently, and interfaces must address that owner. |
| Newer Dev Machines | `implement-review` and `worktree-task` are small Machines definitions; the latter owns worktree creation, advisory review, Human feedback, merge, and cleanup. | Start with these kinds of definitions, adding the development workflows actually needed. |

Sources: [runtime](../src/index.ts), [launcher](../src/launcher.ts), [host](../src/host.ts), [session](../src/session.ts), [MCP lifecycle](../mcp/server.ts), [newer worktree workflow](../../dev-machines/worktree-task.ts), [host tests](../tests/host.test.ts), [session tests](../tests/session.test.ts).

The host/session modules are currently internal rather than package exports; the public launcher starts a direct run and returns its final snapshot. An independently packaged supervisor would need a small supported execution interface. The current hosted result contains the final state, not a declared business outcome such as “PR opened” or “merged.” Those are real integration questions, not reasons to introduce tickets into the runtime. [Package exports](../package.json), [Host result](../src/host.ts)

## Lessons from the old ticketd

The old production ticket store was Beads through `br`. CLI and Pi offered different ways to access that queue; the implementation was not a general collection of GitHub, Linear, and webhook connectors. It selected ready/unassigned tickets, claimed atomically, reread ownership and launch data, and recorded a stable attempt before opening the runtime. [Application wiring](../../dna-orchestration/ticketd/src/application.ts), [Beads store](../../dna-orchestration/ticketd/src/br-ticket-store.ts), [Ticket service](../../dna-orchestration/ticketd/src/service.ts)

Keep these properties:

- **A ticket can have multiple attempts.** Record what each attempt actually received, which Machine/configuration ran, and its result. Editing a ticket should not silently change an active attempt's task.
- **Claim before starting effects.** Duplicate discovery or an uncertain launch response must not create a competing run.
- **Waiting for a person is observable.** Questions and responses identify their exact attempt/run/request; closing a UI does not settle them.
- **Completion and writeback are separate.** If work succeeds but updating the tracker fails, retry the update without repeating the work.

Old source and tests explicitly implement these contracts, including claim/input conflicts, orphan attempts, nonmatching completion outcomes, and retrying a lost closure without reopening the runtime. [Service tests](../../dna-orchestration/ticketd/tests/service.test.ts), [Durable Human input](../../dna-orchestration/ticketd/src/durable-human-input.ts)

One scheduling behavior should change: the old scheduler awaits every worker in a readiness snapshot before polling again. An unfinished Human-waiting run can delay discovery of newly submitted tickets even when other workers have finished. This is inferred from source, not reproduced in a live daemon. Keep discovery independent of whole-run completion; separately decide whether a waiting run occupies a concurrency slot. [Scheduler](../../dna-orchestration/ticketd/src/scheduler.ts), [Attempt supervisor](../../dna-orchestration/ticketd/src/interactive-attempt-supervisor.ts)

## Development concepts worth retaining

The old workflows normalized issues, conversations, PRs, and QA reports into source snapshots, then built a short work brief with instructions, acceptance criteria, and context. This lets implementation and review share a concrete target without teaching every Machine how each tracker works. Start with the useful fields rather than requiring every legacy field at submission. [Source snapshots](../../dna-orchestration/dev-machines/src/contracts/work-triage.ts), [Work brief](../../dna-orchestration/dev-machines/src/contracts/work.ts)

Other useful ideas are explicit triage, diagnosis before a bug fix when necessary, independent verification, review tied to the revision actually reviewed, and retained worktrees when a run needs attention. Planning can produce smaller dependency-linked tickets later; it need not be part of the first autorun path. Old `qa.to-tickets` returned a proposed bundle, with publication handled elsewhere. [Planning contract](../../dna-orchestration/dev-machines/src/contracts/ticket-planning.ts), [QA workflow](../../dna-orchestration/dev-machines/src/machines/qa-to-tickets.ts)

Keep the distinction between finishing a workflow and fulfilling a ticket. Old isolated implementation could return `candidate_retained`; publication was a separate workflow. “Implemented,” “PR opened,” and “merged” are different useful results. The new supervisor needs a clear completion contract without interpreting internal development steps. [Retained candidate](../../dna-orchestration/dev-machines/src/machines/change-implement-tdd-isolated.ts), [Publication workflow](../../dna-orchestration/dev-machines/src/machines/change-publish.ts)

The newer `worktree-task` is a useful starting point, not yet a complete unattended execution policy. Its checks are requested in Agent prompts, review is advisory, revisions return to Human review, and merging uses fast-forward-only Git against the original checkout. The first ticket workflow should deliberately choose verification, publication, and concurrent-repository behavior. [Current definition](../../dev-machines/worktree-task.ts)

## The main scope decision: durability

Persisting tickets and attempts is much smaller than safely resuming a workflow after a crash. Current Machines has neither a persistent run store nor a restore interface. Definitions can keep essential data in JavaScript closures: the newer worktree workflow stores paths, branch names, base commit, and feedback this way. Persisting only its XState state name cannot reconstruct that execution. [Current session](../src/session.ts), [Worktree definition](../../dev-machines/worktree-task.ts)

A small initial daemon can retain durable ticket/attempt evidence and mark interrupted work as needing attention. Automatic retries of uncertain work should not be the default. Even the old runtime's recovery tests deliberately mark an interrupted process uncertain rather than executing it again. Transparent mid-workflow recovery would be a separate runtime feature with implications for state, Operations, and external effects. [Old recovery tests](../../dna-orchestration/dna-code/tests/recovery.test.ts)

A daemon owning live hosts solves survival of an interface disconnect. It does not itself solve survival of the daemon's own restart. Human questions can remain live while the daemon runs; recording a question durably does not by itself restore the workflow waiting behind it.

## Proposed starting point, subject to discussion

Use one authoritative queue and one host initially, with bounded concurrent attempts. Preserve input and ownership, launch configured Machines, expose waiting questions and results through a small daemon interface, and persist enough evidence to diagnose interrupted work. Keep the workflow usable through the existing CLI as well. Herdr can present a review workspace or agent conversation without becoming the ticket authority.

Machine selection should be explicit or come from trusted project routing: for example, a chosen workflow name or a configured default for a ticket kind. Automatic triage can itself be a Machine if needed. The task's prose remains task input rather than an instruction to load arbitrary executable definitions.

Questions to settle together:

1. Do submission tools feed our own queue, or must existing trackers remain the source of truth?
2. Does submission make work runnable, or does it first need a ready signal from a person or triage Machine?
3. What does the first useful workflow deliver: a tested worktree, a PR, or merged code?
4. Where should unattended Human questions appear, and how should waiting affect capacity?
5. Is visible interrupted work with deliberate recovery acceptable initially, or is automatic continuation after restart required?

No new runtime, daemon, tracker integration, or workflow was implemented during this review. Representative tests were read rather than executed; old service health and live ticket behavior were not tested.
