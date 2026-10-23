import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Type } from "typebox";
import { assertJsonValue } from "../src/json.ts";
import type { StateValue } from "xstate";

import type { HostedHumanRequest } from "../src/host.ts";
import type { HumanRequest } from "../src/index.ts";
import type { MachineSession, RunSnapshot } from "../src/session.ts";
import { machineCoordinatorGuidelines, machineDiscoveryDescription } from "../src/coordinator-guidance.ts";
import { readRunStatuses, runStatusDirectory, runsForViewer, type ViewerRun } from "../src/run-viewer.ts";
import { readRunWatches, runWatch, sameRunWatch, writeRunWatches } from "../src/run-watch.ts";
import type { RunStatusRecord } from "../src/run-status.ts";
import { PiWake, type WakeApi, type WakeContext } from "./wake.ts";

const sourceFile = realpathSync(fileURLToPath(import.meta.url));
const sourceRoot = resolve(dirname(sourceFile), "..");
const moduleExtension = sourceFile.endsWith(".ts") ? "ts" : "js";

let launcherModule: Promise<typeof import("../src/launcher.ts")> | undefined;
let sessionModule: Promise<typeof import("../src/session.ts")> | undefined;

function loadLauncher(): Promise<typeof import("../src/launcher.ts")> {
  launcherModule ??= import(pathToFileURL(resolve(sourceRoot, `src/launcher.${moduleExtension}`)).href);
  return launcherModule;
}

async function loadSession(): Promise<typeof import("../src/session.ts")> {
  await loadLauncher();
  sessionModule ??= import(pathToFileURL(resolve(sourceRoot, `src/session.${moduleExtension}`)).href);
  return sessionModule;
}

interface ToolResult<T = unknown> {
  readonly content: readonly [{ readonly type: "text"; readonly text: string }];
  readonly details: T;
}

interface UiLike {
  select(
    title: string,
    options: string[],
    settings?: { readonly signal?: AbortSignal },
  ): Promise<string | undefined>;
  input(
    title: string,
    placeholder?: string,
    settings?: { readonly signal?: AbortSignal },
  ): Promise<string | undefined>;
  notify(message: string, type?: "info" | "warning" | "error"): void;
  setWidget(
    key: string,
    content: string[] | ((tui: unknown, theme: ThemeLike) => ComponentLike) | undefined,
    options?: { readonly placement?: "aboveEditor" | "belowEditor" },
  ): void;
}

interface ToolContextLike extends WakeContext {
  readonly cwd: string;
  readonly ui: UiLike;
}

interface ThemeLike {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

interface ComponentLike {
  render(width: number): string[];
  invalidate(): void;
}

interface RenderOptionsLike {
  readonly expanded: boolean;
}

interface ToolDefinitionLike {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly promptSnippet?: string;
  readonly promptGuidelines?: readonly string[];
  readonly parameters: unknown;
  readonly executionMode?: "sequential" | "parallel";
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    context: ToolContextLike,
  ): Promise<ToolResult>;
  renderCall?(
    params: Record<string, unknown>,
    theme: ThemeLike,
  ): ComponentLike;
  renderResult?(
    result: ToolResult,
    options: RenderOptionsLike,
    theme: ThemeLike,
  ): ComponentLike;
}

interface PiLike extends WakeApi {
  registerTool(tool: ToolDefinitionLike): void;
  registerCommand(name: string, command: {
    readonly description: string;
    handler(args: string, context: ToolContextLike): Promise<void>;
  }): void;
  on(
    event: "session_start" | "session_shutdown" | "agent_settled" | "before_agent_start" | "agent_start"
      | "session_compact" | "session_compact_failed" | "session_before_tree",
    handler: (event: unknown, context: ToolContextLike) => void | Promise<void>,
  ): void;
}

const widgetKey = "machines";
const terminalWidgetDurationMs = 6_000;

export default function machinesExtension(pi: PiLike): void {
  let session: MachineSession | undefined;
  let pendingSession: Promise<MachineSession> | undefined;
  let ui: UiLike | undefined;
  let viewerId: string | undefined;
  let elapsedTimer: NodeJS.Timeout | undefined;
  let shuttingDown = false;
  let boundSessionId: string | undefined;
  let boundContext: ToolContextLike | undefined;
  let wake: PiWake | undefined;
  const spawned = new Set<string>();
  const dialogAbort = new AbortController();
  let dialogQueue = Promise.resolve();

  const useContext = (context: ToolContextLike, render = true) => {
    if (shuttingDown) throw new Error("Machine session is closed");
    const identity = context.sessionManager?.getSessionId();
    if (boundSessionId !== undefined && identity !== undefined && identity !== boundSessionId) {
      close();
      throw new Error("Machine session context is stale after a session switch");
    }
    boundSessionId ??= identity;
    if (identity !== undefined) boundContext ??= context;
    ui = context.ui;
    viewerId = context.sessionManager?.getSessionId();
    if (render) renderWidget();
  };

  const registerContext = (context: ToolContextLike): PiWake => {
    if (!context.sessionManager?.getSessionId()) throw new Error("Pi did not provide a session id for wake registration");
    wake ??= new PiWake(pi, context);
    return wake;
  };

  const refreshWake = (settled = false, observed?: RunSnapshot) => {
    const snapshots = session?.status() ?? [];
    wake?.refresh(observed === undefined ? snapshots : [observed, ...snapshots.filter(run => run.id !== observed.id)], settled);
  };

  const watchedRuns = (): ViewerRun[] => {
    const directory = runStatusDirectory();
    if (directory === undefined || viewerId === undefined) return [];
    return runsForViewer(readRunStatuses(directory), {
      sessionId: viewerId,
      watches: readRunWatches(directory, viewerId),
    });
  };

  const renderWidget = () => {
    if (ui === undefined || shuttingDown) return;
    if (boundContext !== undefined && boundContext.sessionManager?.getSessionId() !== boundSessionId) {
      close();
      return;
    }
    refreshWake();
    const now = Date.now();
    const owned = session?.status() ?? [];
    const visible: WidgetRun[] = owned.filter(
      (run) => isActive(run.status) || now - Date.parse(run.updatedAt) < terminalWidgetDurationMs,
    );
    const ownedIds = new Set(owned.map((run) => run.id));
    const published = new Map(watchedRuns().map(run => [run.id, run]));
    if (viewerId !== undefined && wake !== undefined) {
      for (const run of runsForViewer(wake.records(), {
        sessionId: viewerId, watches: wake.registrations().map(entry => entry.watch),
      })) published.set(run.id, run);
    }
    visible.push(...[...published.values()].filter((run) => !ownedIds.has(run.id)));
    // Keep polling even before a watched ticket starts, or a CLI watch is added.
    const watching = viewerId !== undefined && runStatusDirectory() !== undefined;
    if (visible.length === 0) {
      ui.setWidget(widgetKey, undefined);
      if (watching || wake?.hasPending) startTimer();
      else stopTimer();
      return;
    }

    ui.setWidget(widgetKey, (_tui, theme) => ({
      render: (width) => widgetLines(visible, theme, width),
      invalidate: () => {},
    }), { placement: "aboveEditor" });
    startTimer();
  };

  const startTimer = () => {
    if (elapsedTimer !== undefined) return;
    elapsedTimer = setInterval(renderWidget, 1_000);
    elapsedTimer.unref();
  };

  const stopTimer = () => {
    if (elapsedTimer === undefined) return;
    clearInterval(elapsedTimer);
    elapsedTimer = undefined;
  };

  const getSession = (): Promise<MachineSession> => {
    pendingSession ??= loadSession().then(({ MachineSession }) => {
      session = new MachineSession();
      if (shuttingDown) session.close();
      session.subscribe(({ type, run }) => {
        if (shuttingDown) return;
        // MachineSession emits its initial snapshot synchronously before any
        // child Human/terminal callbacks. Bind it to the initiating runtime now.
        if (!spawned.has(run.id)) {
          spawned.add(run.id);
          wake?.registerSpawned(run.id);
        }
        // Retain the event itself even if the session has already evicted it.
        refreshWake(false, run);
        renderWidget();
        if (shuttingDown) return;
        if (type === "human" && run.human !== undefined) {
          ui?.notify(`${run.machine} needs input (${shortId(run.id)})`, "warning");
          enqueueHumanDialog(run.id, run.human);
        } else if (type === "finished") {
          ui?.notify(
            `${run.machine} ${run.status} (${shortId(run.id)})${run.error === undefined ? "" : `: ${run.error}`}`,
            run.status === "completed" ? "info" : "error",
          );
        }
      });
      return session;
    });
    return pendingSession;
  };

  const enqueueHumanDialog = (id: string, request: HostedHumanRequest) => {
    dialogQueue = dialogQueue.then(async () => {
      const activeUi = ui;
      const waiting = () => !shuttingDown
        && session?.status().some((run) => run.id === id && run.human?.requestId === request.requestId);
      if (activeUi === undefined || !waiting()) return;
      const response = await requestHumanResponse(activeUi, request, dialogAbort.signal);
      if (response === undefined || !waiting()) return;
      await session?.respond({ runId: id, requestId: request.requestId, response });
    }).catch((cause: unknown) => {
      if (!shuttingDown) ui?.notify(`Could not open Machine input: ${errorMessage(cause)}`, "error");
    });
  };

  pi.registerTool({
    name: "machine_list",
    label: "List Machines",
    description: machineDiscoveryDescription,
    promptSnippet: "Discover and use Machines before delegated or multi-step work.",
    promptGuidelines: machineCoordinatorGuidelines,
    parameters: Type.Object({}, { additionalProperties: false }),
    executionMode: "parallel",
    async execute(_id, _params, _signal, _onUpdate, context) {
      useContext(context);
      const { listMachines } = await loadLauncher();
      const machines = await listMachines({ cwd: context.cwd });
      const text = machines.length === 0
        ? "No Machines found."
        : machines.map((machine) => {
          const roles = Object.keys(machine.agentRoles);
          const roleText = roles.length === 0 ? "no Agent roles" : `roles: ${roles.join(", ")}`;
          const missing = machine.error !== undefined
            ? `; invalid: ${machine.error}`
            : machine.missingAgents.length === 0
            ? ""
            : `; missing: ${machine.missingAgents.join(", ")}`;
          return `${machine.name} — ${machine.description} (${roleText}${missing})\n  ${machine.path}`;
        }).join("\n");
      return result(text, {
        summary: `${machines.length} Machine${machines.length === 1 ? "" : "s"}`,
        machines,
      });
    },
    renderCall: (_params, theme) => line(theme.fg("toolTitle", theme.bold("machine_list"))),
    renderResult: compactResult,
  });

  pi.registerTool({
    name: "machine_agents",
    label: "List Machine Agents",
    description: "List configured Agent presets available to Machine role bindings.",
    promptGuidelines: [
      "Use machine_agents before overriding a Machine Agent role; do not invent preset names or inline harness configuration.",
    ],
    parameters: Type.Object({}, { additionalProperties: false }),
    executionMode: "parallel",
    async execute(_id, _params, _signal, _onUpdate, context) {
      useContext(context);
      const { listAgentPresets } = await loadLauncher();
      const agents = await listAgentPresets({ cwd: context.cwd });
      const text = agents.length === 0
        ? "No Agent presets configured."
        : agents.map((agent) => {
          const identity = [agent.harness, agent.model, agent.thinking]
            .filter((part) => part !== undefined)
            .join(" · ");
          const fallback = agent.fallback === undefined ? "" : ` · fallback: ${agent.fallback.join(", ") || "none"}`;
          return `${agent.name} — ${agent.description}${identity === "" ? "" : ` (${identity})`}\n  ${agent.source}${fallback}`;
        }).join("\n");
      return result(text, {
        summary: `${agents.length} Agent preset${agents.length === 1 ? "" : "s"}`,
        agents,
      });
    },
    renderCall: (_params, theme) => line(theme.fg("toolTitle", theme.bold("machine_agents"))),
    renderResult: compactResult,
  });

  pi.registerTool({
    name: "machine_start",
    label: "Start Machine",
    description: "Start one Machine asynchronously. Returns a run id immediately after preflight.",
    promptGuidelines: [
      "machine_start is asynchronous: after it returns, continue the conversation and use machine_status only when status is relevant.",
      "Spawned runs wake this Pi session on completion, failure, or a new Human request. Yield when no independent work remains; do not poll for completion.",
      "Turn the Human's goal into clear Machine input without adding requirements or changing its intended scope.",
      "Pass Agent overrides only as Machine role-to-preset names previously discovered with machine_agents.",
    ],
    parameters: Type.Object({
      machine: Type.String({ description: "Exact Machine name from machine_list" }),
      input: Type.Optional(Type.Unknown({ description: "JSON-serializable task or structured input for the Machine" })),
      agents: Type.Optional(Type.Record(
        Type.String(),
        Type.String(),
        { description: "Optional Machine role to configured Agent preset name" },
      )),
    }, { additionalProperties: false }),
    async execute(_id, rawParams, _signal, _onUpdate, context) {
      useContext(context);
      // Older embedding clients may only implement presentation. Actual Pi's
      // wake APIs are required for explicit attachments and automatic in Pi 1.4+.
      if (pi.sendMessage !== undefined) registerContext(context);
      const owner = context.sessionManager?.getSessionId();
      const machine = requiredString(rawParams.machine, "machine");
      const input = rawParams.input;
      if (input !== undefined) assertJsonValue(input, "Machine input");
      const agents = optionalStringRecord(rawParams.agents, "agents");
      const runs = await getSession();
      if (shuttingDown || context.sessionManager?.getSessionId() !== owner) throw new Error("Machine session is closed or stale");
      const run = await runs.start({
        machine,
        cwd: context.cwd,
        ...(owner === undefined ? {} : { owner }),
        ...(input === undefined ? {} : { input }),
        ...(agents === undefined ? {} : { agents }),
      });
      return result(
        `Started ${run.machine}.\nRun id: ${run.id}\nStatus: ${run.status}`,
        { summary: `started ${run.machine} · ${shortId(run.id)}`, run },
      );
    },
    renderCall: (params, theme) => line(
      `${theme.fg("toolTitle", theme.bold("machine_start"))} ${theme.fg("muted", String(params.machine ?? ""))}`,
    ),
    renderResult: compactResult,
  });

  pi.registerTool({
    name: "machine_status",
    label: "Machine Status",
    description: "Inspect an owned or explicitly attached Machine run by exact id, or list their snapshots.",
    parameters: Type.Object({
      runId: Type.Optional(Type.String({ description: "Exact run id from machine_start, a wake message, or an attached published run" })),
    }, { additionalProperties: false }),
    executionMode: "parallel",
    async execute(_id, rawParams, _signal, _onUpdate, context) {
      useContext(context);
      const runId = optionalString(rawParams.runId, "runId");
      const runs = await getSession();
      const all: Array<RunSnapshot | RunStatusRecord> = runs.status();
      const recentIds = new Set(all.map(run => run.id));
      all.push(...(wake?.retained() ?? []).filter(run => !recentIds.has(run.id)));
      const ownedIds = new Set(all.map(run => run.id));
      all.push(...(wake?.records() ?? []).filter(run => !ownedIds.has(run.id)));
      const snapshots = runId === undefined ? all : all.filter(run => run.id === runId);
      if (runId !== undefined && snapshots.length === 0) throw new Error(`Machine run "${runId}" not found in this session or its attachments`);
      const text = snapshots.length === 0
        ? "No Machine runs in this Pi session."
        : snapshots.map(formatSnapshot).join("\n\n");
      return result(text, {
        summary: snapshots.length === 0
          ? "no runs"
          : `${snapshots.length} run${snapshots.length === 1 ? "" : "s"}`,
        runs: snapshots,
      });
    },
    renderCall: (params, theme) => line(
      `${theme.fg("toolTitle", theme.bold("machine_status"))}${params.runId === undefined ? "" : ` ${theme.fg("muted", String(params.runId))}`}`,
    ),
    renderResult: compactResult,
  });

  pi.registerTool({
    name: "machine_respond",
    label: "Respond to Machine",
    description: "Send a clear Human response to one waiting Machine run.",
    promptGuidelines: [
      "Call machine_respond only when the Human's answer is clear, using the exact run id, current human.requestId, and an allowed choice when choices exist.",
    ],
    parameters: Type.Object({
      runId: Type.String({ description: "Exact run id returned by machine_start" }),
      requestId: Type.String({ description: "Exact human.requestId from the current waiting run snapshot" }),
      response: Type.String({ description: "Human response or exact allowed choice" }),
    }, { additionalProperties: false }),
    async execute(_id, rawParams, _signal, _onUpdate, context) {
      useContext(context);
      const runId = requiredString(rawParams.runId, "runId");
      const response = requiredString(rawParams.response, "response");
      const requestId = requiredString(rawParams.requestId, "requestId");
      const run = await (await getSession()).respond({ runId, requestId, response });
      return result(
        `Sent response to ${run.machine}.\nRun id: ${run.id}\nStatus: ${run.status}`,
        { summary: `responded to ${run.machine} · ${shortId(run.id)}`, run },
      );
    },
    renderCall: (params, theme) => line(
      `${theme.fg("toolTitle", theme.bold("machine_respond"))} ${theme.fg("muted", String(params.runId ?? ""))}`,
    ),
    renderResult: compactResult,
  });

  const changeWatch = (target: string | undefined, remove: boolean, context: ToolContextLike) => {
    if (shuttingDown) throw new Error("Machine session is closed");
    useContext(context);
    const directory = runStatusDirectory();
    if (directory === undefined) throw new Error("Run status publication is off; Pi and Dispatch must use the same run-status directory");
    if (viewerId === undefined) throw new Error("Pi did not provide a session id for this subscription");
    let watches = readRunWatches(directory, viewerId);
    if (target !== undefined) {
      const watch = runWatch({ text: target });
      watches = remove
        ? watches.filter((entry) => !sameRunWatch(entry, watch))
        : watches.some((entry) => sameRunWatch(entry, watch)) ? watches : [...watches, watch];
      writeRunWatches(directory, viewerId, watches);
    }
    renderWidget();
    const runs = watchedRuns();
    const summary = `${watches.length} subscription${watches.length === 1 ? "" : "s"} · ${runs.length} visible run${runs.length === 1 ? "" : "s"}`;
    const list = watches.map((watch) => "text" in watch ? watch.text : `directory: ${watch.dir}`).join("\n");
    return result(`${summary}\n${list || "No subscriptions."}\nWatching is read-only; respond through the run's owner.\nStatus directory: ${directory}`, {
      summary, sessionId: viewerId, directory, watches, runs,
    });
  };

  const changeAttachment = (target: string, remove: boolean, context: ToolContextLike) => {
    // Apply unregistration before an idle refresh can hand off queued events.
    useContext(context, false);
    const registration = registerContext(context);
    if (remove) registration.detach(target);
    else {
      const directory = runStatusDirectory();
      if (directory === undefined) throw new Error("Run status publication is off; use the same run-status directory for external attachment");
      registration.attach(target, directory);
    }
    renderWidget();
    const summary = `${remove ? "Detached" : "Attached"} ${target}`;
    return result(`${summary}. ${remove ? "Pending wake delivery cancelled where no registration remains." : "This Pi session will wake for completion, failure, and new Human requests."} External ownership and Human decisions stay with their owner.`, {
      summary, sessionId: context.sessionManager?.getSessionId(), attachments: registration.registrations(),
    });
  };

  for (const remove of [false, true]) {
    const name = remove ? "machine_detach" : "machine_attach";
    const command = remove ? "machine-detach" : "machine-attach";
    const description = remove
      ? "Unregister wake notifications for a target in this Pi session, cancelling pending delivery without stopping any run."
      : "Explicitly register this Pi session to wake for a published ticket or run, including future attempts. Observation only; does not grant ownership or Human decision authority.";
    pi.registerTool({
      name, label: remove ? "Detach Machine" : "Attach Machine", description,
      promptGuidelines: ["Use machine_watch for a passive widget. Use machine_attach for external model continuation; yield when no independent work remains. Retrieve machine_status after a wake and obtain the Human's answer before responding."],
      parameters: Type.Object({ target: Type.String({ description: "Ticket label prefix or run id prefix; detach the same target to unregister" }) }, { additionalProperties: false }),
      async execute(_id, params, _signal, _onUpdate, context) {
        return changeAttachment(requiredString(params.target, "target"), remove, context);
      },
      renderCall: (params, theme) => line(`${theme.fg("toolTitle", theme.bold(name))} ${String(params.target ?? "")}`),
      renderResult: compactResult,
    });
    pi.registerCommand(command, {
      description,
      async handler(args, context) {
        try {
          if (args.trim() === "") throw new Error(`Usage: /${command} <ticket-or-run-id>`);
          context.ui.notify(changeAttachment(args, remove, context).content[0].text, "info");
        } catch (cause) {
          context.ui.notify(errorMessage(cause), "error");
        }
      },
    });
  }

  for (const remove of [false, true]) {
    const name = remove ? "machine_unwatch" : "machine_watch";
    const description = remove
      ? "Unsubscribe this Pi session from a ticket or run without stopping it."
      : "Subscribe this Pi session to a published ticket or run in the Machines widget; omit target to list subscriptions. Read-only, including future ticket attempts.";
    const target = Type.String({ description: "Ticket id (label prefix) or run id prefix" });
    pi.registerTool({
      name,
      label: remove ? "Unwatch Machine" : "Watch Machine",
      description,
      parameters: Type.Object({ target: remove ? target : Type.Optional(target) }, { additionalProperties: false }),
      async execute(_id, params, _signal, _onUpdate, context) {
        return changeWatch(remove ? requiredString(params.target, "target") : optionalString(params.target, "target"), remove, context);
      },
      renderCall: (params, theme) => line(`${theme.fg("toolTitle", theme.bold(name))} ${String(params.target ?? "")}`),
      renderResult: compactResult,
    });
    pi.registerCommand(remove ? "machine-unwatch" : "machine-watch", {
      description,
      async handler(args, context) {
        try {
          const target = args.trim() === "" ? undefined : args;
          if (remove && target === undefined) throw new Error("Usage: /machine-unwatch <ticket-or-run-id>");
          context.ui.notify(changeWatch(target, remove, context).content[0].text, "info");
        } catch (cause) {
          context.ui.notify(errorMessage(cause), "error");
        }
      },
    });
  }

  pi.on("session_start", (_event, context) => useContext(context));

  for (const event of ["before_agent_start", "agent_start"] as const) {
    pi.on(event, () => wake?.agentStarting());
  }

  pi.on("session_before_tree", (_event, context) => {
    if (shuttingDown || pi.sendMessage === undefined) return;
    useContext(context, false);
    // Capture navigation even before the first run registration. Creating the
    // policy alone registers no runs and starts no observer or model turn.
    registerContext(context).treeNavigationStarting();
  });

  for (const event of ["session_compact", "session_compact_failed"] as const) {
    pi.on(event, (value) => {
      const compact = value as { reason?: string; willRetry?: boolean };
      if (compact.reason !== "manual" || compact.willRetry !== false) return;
      wake?.manualCompactionFinished();
      renderWidget();
    });
  }

  pi.on("agent_settled", (_event, context) => {
    if (shuttingDown) return;
    if (context.sessionManager?.getSessionId() !== boundSessionId) {
      close();
      return;
    }
    refreshWake(true);
  });

  const close = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    wake?.close();
    dialogAbort.abort();
    stopTimer();
    session?.close();
    spawned.clear();
    ui?.setWidget(widgetKey, undefined);
    ui = undefined;
  };

  pi.on("session_shutdown", (_event, context) => {
    close();
    context.ui.setWidget(widgetKey, undefined);
  });
}

function formatSnapshot(run: RunSnapshot | RunStatusRecord): string {
  const lines = [
    `${run.machine} (${run.status})`,
    `Run id: ${run.id}`,
    `State: ${formatState(run.state) ?? "starting"}`,
    `Elapsed: ${"elapsedSeconds" in run ? run.elapsedSeconds : Math.max(0, Math.floor((Date.parse(run.updatedAt) - Date.parse(run.startedAt)) / 1_000))}s`,
  ];
  if (run.agent !== undefined) lines.push(`Agent: ${formatAgent(run.agent)}`);
  if (run.limit !== undefined) lines.push(`Limit: ${run.limit.text}`);
  if ("schemaVersion" in run) {
    lines.push(`External owner: ${run.owner ?? "not named"}`);
    if (run.answeredBy === "host") lines.push("Human responses go through the program hosting this run.");
    if (run.humanEventId !== undefined) lines.push(`Human event id: ${run.humanEventId}`);
  }
  if (run.human !== undefined) {
    lines.push(`Human: ${run.human.prompt}`);
    if (run.human.requestId !== undefined) lines.push(`Request id: ${run.human.requestId}`);
    if ("answer" in run.human && run.human.answer !== undefined) lines.push("Human answer recorded; awaiting continuation by its owner.");
    if (run.human.choices !== undefined) lines.push(`Choices: ${run.human.choices.join(", ")}`);
    if (run.human.suggestions !== undefined) {
      lines.push(`Suggestions: ${run.human.suggestions.join(", ")}`);
    }
  }
  if (run.error !== undefined) lines.push(`Error: ${run.error}`);
  return lines.join("\n");
}

function compactResult(
  toolResult: ToolResult,
  options: RenderOptionsLike,
  theme: ThemeLike,
): ComponentLike {
  if (options.expanded) return line(toolResult.content[0].text);
  const details = toolResult.details as { readonly summary?: unknown } | undefined;
  const summary = typeof details?.summary === "string" ? details.summary : "done";
  return line(`${theme.fg("success", "✓")} ${summary} ${theme.fg("dim", "(Ctrl+O for details)")}`);
}

type WidgetRun = RunSnapshot | ViewerRun;

function widgetLines(
  runs: readonly WidgetRun[],
  theme: ThemeLike,
  width: number,
): string[] {
  const edge = (text: string) => theme.fg("borderMuted", text);
  const title = " Machines ";
  const topRule = "─".repeat(Math.max(1, width - title.length - 3));
  const bottomRule = "─".repeat(Math.max(1, width - 2));
  const lines = [
    `${theme.fg("borderAccent", "┌─")}${theme.fg("accent", theme.bold(title))}${theme.fg("borderAccent", `${topRule}┐`)}`,
  ];
  for (const run of runs) {
    const external = "shown" in run;
    const sleeping = external && run.status === "sleeping";
    const waiting = run.status === "waiting" || (sleeping && run.sleep?.for === "answer" && !run.sleep.answered);
    const completed = run.status === "completed";
    const failed = run.status === "failed" || run.status === "lost";
    const color = waiting
      ? "warning"
      : completed
        ? "success"
        : failed
          ? "error"
          : "accent";
    const symbol = waiting ? "◆" : completed ? "✓" : failed ? "✕" : "●";
    const state = waiting
      ? "input needed"
      : failed
        ? run.status
        : sleeping
          ? run.sleep?.for === "time" ? `sleeping until ${run.sleep.due}` : "awaiting continuation"
          : formatState(run.state) ?? "starting";
    const end = completed || failed ? Date.parse(run.updatedAt) : undefined;
    lines.push(
      `${edge("│")} ${theme.fg(color, symbol)} ${theme.fg("muted", shortId(run.id))}  ${theme.bold(external ? run.label ?? run.machine : run.machine)} › ${theme.fg(color, state)} · ${theme.fg("dim", elapsed(Date.parse(run.startedAt), end))}`,
    );
    if (run.human !== undefined) {
      for (const promptLine of run.human.prompt.split("\n")) {
        lines.push(`${edge("│")}   ${theme.fg("warning", promptLine)}`);
      }
      if (external && waiting) {
        lines.push(`${edge("│")}   ${theme.fg("dim", "Watching only · answer through the run's owner (Dispatch for tickets)")}`);
      }
    } else if (run.limit !== undefined) {
      lines.push(`${edge("│")}   ${theme.fg("warning", run.limit.text)}`);
    } else if (run.agent !== undefined) {
      lines.push(`${edge("│")}   ${theme.fg("muted", formatAgent(run.agent))}`);
    }
  }
  lines.push(edge(`└${bottomRule}┘`));
  return lines;
}

async function requestHumanResponse(
  ui: UiLike,
  request: HumanRequest,
  signal: AbortSignal,
): Promise<string | undefined> {
  if (request.choices !== undefined) {
    return ui.select(request.prompt, [...request.choices], { signal });
  }
  if (request.suggestions !== undefined) {
    const selected = await ui.select(
      request.prompt,
      [...request.suggestions, "Other…"],
      { signal },
    );
    if (selected !== "Other…") return selected;
  }
  return ui.input(request.prompt, "Type your response", { signal });
}

function result<T>(text: string, details: T): ToolResult<T> {
  return { content: [{ type: "text", text }], details };
}

function line(text: string): ComponentLike {
  return {
    render: () => text.split("\n"),
    invalidate: () => {},
  };
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value === "") throw new Error(`${name} must be a non-empty string`);
  return value;
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, name);
}

function optionalStringRecord(
  value: unknown,
  name: string,
): Readonly<Record<string, string>> | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must map Machine roles to Agent preset names`);
  }
  const entries = Object.entries(value);
  if (entries.some(([key, item]) => key === "" || typeof item !== "string" || item === "")) {
    throw new Error(`${name} must map non-empty Machine roles to non-empty Agent preset names`);
  }
  return Object.fromEntries(entries) as Readonly<Record<string, string>>;
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

function isActive(status: RunSnapshot["status"]): boolean {
  return status === "running" || status === "waiting";
}

function elapsed(startedAt: number, endedAt = Date.now()): string {
  const seconds = Math.floor((endedAt - startedAt) / 1_000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function formatState(state: StateValue | undefined): string | undefined {
  if (state === undefined) return undefined;
  return typeof state === "string" ? state : JSON.stringify(state);
}

function formatAgent(agent: {
  readonly harness: string;
  readonly model?: string;
  readonly thinking?: string;
}): string {
  return [agent.harness, agent.model, agent.thinking === undefined ? undefined : `thinking ${agent.thinking}`]
    .filter((part) => part !== undefined)
    .join(" · ");
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
