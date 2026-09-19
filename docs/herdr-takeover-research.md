# Herdr review and agent takeover research

Research snapshot: 2026-09-06. This records a proposed direction; it does not add handoff support or change runner behavior.

## Recommendation

Keep **Pi on its existing ACP adapter, Codex on native exec, and AGY on native print mode**. Add optional Herdr review at an existing Human state, after the preceding Agent turn has finished. Preserve the agent's native conversation reference so the reviewer can open that conversation when useful.

The first useful flow is:

```text
Agent finishes → Human review waits in Machines
                      ↓
             Open native agent in Herdr
             Review, discuss, or edit
                      ↓
             Exit the interactive agent
             Reply in the original Machines UI
                      ↓
             Machines continues and verifies
```

This recommendation follows from the interfaces inspected below. ACP provides useful structured communication, but a transport change does not supply the human/automation coordination this flow needs. A completed-turn checkpoint avoids interrupting active tools and requires no shared agent server or terminal-output parser.

Reviewing a diff or artifact needs no conversation continuation at all. Offer native resume for cases where discussing the original agent's context helps. Keep conversation reuse explicit rather than making every Agent state share one session.

## Scope and versions

Research used local CLI help, Machines source, public upstream source, package metadata, and official documentation. Two parallel investigations covered Codex/ACP and Pi/AGY; the main investigation covered Herdr and Machines.

| Component | Inspected version or source |
| --- | --- |
| Machines | `e5ebfab`, plus the uncommitted Codex runner |
| Herdr | Installed 0.7.4, protocol 16; upstream source `9d111db` reports 0.8.2 |
| Codex | Installed CLI 0.153.2; published `@agentclientprotocol/codex-acp` 1.10.0 |
| Pi | Installed 0.85.1; published/cached `pi-acp` 0.0.33 (`svkozak/pi-acp`) |
| AGY | Installed 1.1.24; published community `agy-acp` 0.5.2 |
| ACP | Current v1 documentation; Machines SDK dependency 1.4.0 |

No live model calls or end-to-end handoff tests were performed. Private conversation stores were not inspected. Native resume support is verified at the interface/source level; a complete automated → interactive → automated round trip remains to be tested.

## What Herdr supplies

Herdr hosts real terminal processes and can open, focus, read, and attach to their terminals. Its current restore documentation lists native conversation commands for all three agents: `codex resume <id>`, `pi --session <path-or-id>`, and `agy --conversation <id>`. Automatic restart restoration relies on official integration-reported references. Detaching leaves processes running; restarting the server normally does not. [Herdr session state](https://herdr.dev/docs/session-state/)

`herdr agent attach ... --takeover` transfers control from another directly attached terminal client. Its implementation attaches to a terminal already owned by the Herdr server. It does not turn our piped exec/ACP child into an interactive terminal or notify Machines that a Human request is complete. Raw pane input has a separate path, so direct-attachment ownership should not be treated as a lock against automation. [Attachment implementation](https://github.com/herdrdev/herdr/blob/9d111db9c83823eb4ce8623d9707e28153b01334/src/server/headless.rs#L1776-L1898), [Pane input](https://github.com/herdrdev/herdr/blob/9d111db9c83823eb4ce8623d9707e28153b01334/src/app/api/panes.rs#L1801-L1845)

Herdr's lifecycle is useful for presentation, but insufficient for workflow outcomes. Its current agent API does not correlate individual prompt turns: an already active turn can satisfy a later prompt's wait. `done` describes an idle agent whose background completion has not been seen; it does not mean an implementation passed review. Terminal reads can omit history, and output waits can match existing text. Consequently, routing every Machines runner through a Herdr TUI would require additional result correlation. [Herdr agent automation](https://herdr.dev/docs/agent-automation/)

**Account for the installed version.** Herdr 0.7.4 supports `agent start <name> ... -- <argv>`, whereas current documentation uses `agent start ... --kind <agent> --pane <id>` with separate layout creation. Local integrations report Pi v5 and Codex v6; installed integration help does not include AGY. Current documentation includes AGY integration v1. Launching AGY as a terminal command is separate from having automatic native restore integration. Do not copy newer CLI syntax into an implementation without checking compatibility. [0.7.4 CLI](https://github.com/herdrdev/herdr/blob/v0.7.4/src/cli/agent.rs), [Current automation CLI](https://herdr.dev/docs/agent-automation/)

## Runner comparison

| Runner | Native conversation reference | Interactive continuation | Smallest Machines change |
| --- | --- | --- | --- |
| Codex direct | `thread_id` from `thread.started` | `codex resume <id>` | Opt into persistence, retain ID, add explicit resume support |
| Pi through ACP | Normally Pi's native UUID; adapter also tracks session file | `pi --session <path-or-id>` | Retain session reference; use fresh ACP load when continuing |
| AGY direct | `conversation_id` in native stream records | `agy --conversation <id>` | Retain ID and expose explicit conversation continuation |

### Codex: keep native exec for now

Native exec already emits a thread ID and supports `codex exec resume <id>`. Omitting `--ephemeral` permits persisted history. The interactive CLI can resume an exact ID, so a new protocol is unnecessary for a completed-turn handoff. Our current runner defaults to ephemeral execution and ignores `thread.started`; those are the relevant gaps. [OpenAI non-interactive documentation](https://developers.openai.com/codex/noninteractive), [Local Codex runner](../src/codex.ts)

The maintained Codex ACP adapter also exposes native IDs: its `newSession` returns Codex `thread.id`, and load/resume feeds the same ID to `threadResume`. A separate mapping database is unnecessary for this adapter. Generic ACP makes no such native-ID guarantee. Also distinguish Codex `thread.id` from its newer live-tree `thread.sessionId`; continuation uses the former. [Published adapter ID mapping](https://github.com/agentclientprotocol/codex-acp/blob/061f9a4a2e463a220d7a3ab2ae5e9732837085ef/src/CodexAcpClient.ts#L530-L628), [OpenAI thread lifecycle](https://developers.openai.com/codex/app-server#start-or-resume-a-thread)

**The material migration obstacle is permission behavior.** Codex ACP 1.10.0 has these presets:

| ACP mode ID | Actual sandbox | Approval behavior |
| --- | --- | --- |
| `read-only` | `workspaceWrite` | User approvals, `on-request` |
| `agent` (default) | `workspaceWrite` | Automatic review, `on-request` |
| `agent-full-access` | `dangerFullAccess` | `never` |

The `read-only` identifier currently displays as “Ask for approval”; it does not select a read-only filesystem sandbox. Our direct runner defaults to true read-only with `approval_policy="never"`. The adapter supplies its mode's policies on each turn, and ordinary session configuration has no independent sandbox selector. A session-level config override therefore does not preserve our contract. Machines also currently fails ACP permission requests. Migrating would require deliberate policy work, beyond replacing a parser. [Published modes](https://github.com/agentclientprotocol/codex-acp/blob/061f9a4a2e463a220d7a3ab2ae5e9732837085ef/src/AgentMode.ts#L38-L81), [Per-turn policy](https://github.com/agentclientprotocol/codex-acp/blob/061f9a4a2e463a220d7a3ab2ae5e9732837085ef/src/CodexAcpClient.ts#L948-L958), [Config dispatcher](https://github.com/agentclientprotocol/codex-acp/blob/061f9a4a2e463a220d7a3ab2ae5e9732837085ef/src/CodexAcpServer.ts#L1337-L1356), [Machines ACP runner](../src/acp.ts)

Native App Server offers steering, interruption, approvals, review operations, and a TUI connected with `codex --remote`. It is a possible richer live integration, with experimental transport features and additional connection/lifecycle responsibilities. Current Codex ACP launches its own private stdio App Server, so that alone does not expose a shared TUI endpoint. Revisit App Server if live interaction during an active turn becomes a concrete requirement. [OpenAI App Server](https://developers.openai.com/codex/app-server), [Adapter launcher](https://github.com/agentclientprotocol/codex-acp/blob/061f9a4a2e463a220d7a3ab2ae5e9732837085ef/src/CodexJsonRpcConnection.ts)

### Pi: existing ACP is sufficient

`pi-acp` runs native Pi RPC with ordinary Pi session storage. Its documented features include resuming sessions across Pi and ACP clients. Session creation normally returns RPC `get_state().sessionId`, falling back to a generated UUID only if Pi supplies none, and records the session file. Prefer the native file reference when available; do not assume all arbitrary ACP adapters use native IDs. [pi-acp README](https://github.com/svkozak/pi-acp#features), [Published 0.0.33 session creation](https://github.com/svkozak/pi-acp/blob/1bfcb394088ed879db8fd936b570bb626017f878/src/acp/session.ts#L210)

After human interaction, start a fresh ACP process and load the session. Native Pi keeps loaded history in memory; simultaneous processes should not be treated as a shared conversation controller. Pi also defers creating a new session file until there is content to persist, so an allocated ID alone does not prove durable history. Native RPC offers steering, follow-ups, model/thinking controls, and abort; aborting with queued prompts requires clearing the queue as well. These capabilities do not require replacing the existing adapter with Pi's SDK. [Pi session storage](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/session-manager.ts), [Pi RPC](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md)

### AGY: native resume avoids an unnecessary bridge

AGY's headless stream exposes `record.conversation_id` on `init` and `record.result.conversation_id` on `result`. Capture these originating conversation IDs, avoiding unrelated nested subagent IDs. Its bidirectional `--input-format stream-json` accepts successive user prompts and returns a result for each turn. The protocol explicitly rejects `control_request` and `control_response`; this is not an arbitrary approval/control channel. Wait for each result before submitting the next prompt. [Official headless protocol](https://www.antigravity.google/docs/cli/headless/)

Use `agy --conversation <id>` for native continuation. The most-recent `--continue` selection is workspace-based and can select a different run; a reviewer using `/fork` also creates a distinct conversation that must be adopted deliberately. [Resume command](https://antigravity.google/docs/cli/commands/resume), [Conversation branching](https://antigravity.google/docs/cli-conversations)

Community ACP adapters exist. Published `shindgew/agy-acp` 0.5.2 uses PTY management, SQLite/protobuf polling, and session mappings. `letrquan/agy-acp` defaults to print mode and transcript replay, with native conversation reuse requiring configuration. These add interfaces we do not need for native resume. Installed AGY does not advertise ACP, and the upstream native ACP request remains open at this snapshot. [Published adapter architecture](https://github.com/shindgew/agy-acp#architecture), [Alternative adapter](https://github.com/letrquan/agy-acp#configuration), [Upstream ACP request](https://github.com/google-antigravity/antigravity-cli/issues/31)

## Model and thinking settings

Codex and AGY already have typed model/effort options in Machines. Pi's ACP adapter supports configuration IDs `model` and `thought_level`, but our generic runner currently only observes reported configuration. Adding a setter is a small separate improvement. Adapter 0.0.33 advertises levels through `xhigh`, whereas installed native Pi additionally has `max`; use the adapter's advertised values. Codex ACP similarly supports model and model-dependent reasoning options. [Codex options](../src/codex.ts), [AGY options](../src/agy.ts), [Published Pi configuration](https://github.com/svkozak/pi-acp/blob/1bfcb394088ed879db8fd936b570bb626017f878/src/acp/agent.ts#L1167), [Codex configuration](https://github.com/agentclientprotocol/codex-acp/blob/061f9a4a2e463a220d7a3ab2ae5e9732837085ef/src/ModelConfigOption.ts)

ACP categories help identify these controls, but clients must use each advertised option's actual ID and allowed values. Uniform transport does not imply identical configuration or permissions. [ACP configuration](https://agentclientprotocol.com/protocol/v1/session-config-options)

## Keep the coordination in Machines small

The existing [AgentRunner](../src/index.ts) represents one bounded invocation. Add optional conversation metadata through runner observations, retaining the harness, exact native reference, cwd, and relevant launch settings. Keep Herdr presentation outside the machine's outcome events. [MachineSession](../src/session.ts) currently clears agent identity on state transitions, so a reference needed by the following Human state must be retained separately.

Use the existing Human request and its run/request IDs as the review gate. Each [MCP server instance](../mcp/server.ts) creates its own `MachineSession`; a newly opened reviewer process cannot automatically address the original server's runs. The smallest first UI returns the user to the original Machines card, Pi prompt, or CLI for approval/feedback. A later one-click response from Herdr would need a callback to that same owning session. There is no need to introduce that IPC service for the first version.

Before opening the native reviewer, finish and release the automated runner. Before automated continuation, exit the reviewer and reload persisted history. Machines must stop sending prompts while the human owns the conversation. Detach, pane closure, and an idle badge are not approval signals. Fresh agents receiving explicit review feedback remain a valid, simpler default when continuing the exact conversation is unnecessary.

If adding ACP continuation, separate load-time replay from new turn output: otherwise an old `MACHINES_EVENT` could be parsed as the new result. Check advertised load/resume capabilities. For future mid-turn cancellation, await the original prompt's cancellation response; sending a cancellation notification alone does not prove tools have stopped. [ACP session lifecycle](https://agentclientprotocol.com/protocol/v1/session-setup), [ACP cancellation](https://agentclientprotocol.com/protocol/v1/prompt-turn#cancellation)

One version-specific routing concern deserves a targeted check: Machines inherits the parent environment, and installed Herdr's Codex v6 hook reports sessions using inherited pane identity. A nested headless child could consequently report against its parent's pane. This is a source-based inference, not a reproduced bug. New terminals should receive their own Herdr routing environment. Current v8 adds transcript/session guards, so test the supported installed version rather than assuming identical hook behavior. [Herdr v6 hook](https://github.com/herdrdev/herdr/blob/v0.7.4/src/integration/assets/codex/herdr-agent-state.sh), [Current v8 hook](https://github.com/herdrdev/herdr/blob/9d111db9c83823eb4ce8623d9707e28153b01334/src/integration/assets/codex/herdr-agent-state.sh)

## Next validation

Prove one disposable Codex round trip before generalizing, then repeat for Pi and AGY:

1. Run a persisted automated turn with a recognizable marker; open its exact conversation in a Herdr native UI and verify the history.
2. Add feedback or an edit interactively, exit, then resume automation and verify it sees the new history in the same cwd with deliberate model/effort and permissions.
3. Confirm the original Human request remains pending until explicitly answered, stale responses are rejected, and replayed output cannot supply a new workflow outcome.
4. Verify that cancellation, failed resume, or early exit leaves no competing automated/interactive writer; run the workflow's normal verification after human edits.

These checks determine whether a small optional native-session handoff is dependable. A universal ACP migration, custom AGY bridge, persistent shared server, or terminal-driven replacement runner should wait for a requirement this approach cannot meet.
