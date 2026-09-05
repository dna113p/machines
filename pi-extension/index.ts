import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Type } from "typebox";
import type { StateValue } from "xstate";

import type { HostedHumanRequest } from "../src/host.ts";
import type { HumanRequest } from "../src/index.ts";
import type { MachineSession, RunSnapshot } from "../src/session.ts";

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

interface ToolContextLike {
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

interface PiLike {
  registerTool(tool: ToolDefinitionLike): void;
  on(
    event: "session_shutdown",
    handler: (event: unknown, context: ToolContextLike) => void | Promise<void>,
  ): void;
}

const widgetKey = "machines";
const terminalWidgetDurationMs = 6_000;

export default function machinesExtension(pi: PiLike): void {
  let session: MachineSession | undefined;
  let pendingSession: Promise<MachineSession> | undefined;
  let ui: UiLike | undefined;
  let elapsedTimer: NodeJS.Timeout | undefined;
  let shuttingDown = false;
  const dialogAbort = new AbortController();
  let dialogQueue = Promise.resolve();

  const useContext = (context: ToolContextLike) => {
    ui = context.ui;
  };

  const renderWidget = () => {
    if (ui === undefined) return;
    const now = Date.now();
    const visible = (session?.status() ?? []).filter(
      (run) => isActive(run.status) || now - Date.parse(run.updatedAt) < terminalWidgetDurationMs,
    );
    if (visible.length === 0) {
      ui.setWidget(widgetKey, undefined);
      stopTimer();
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
    description: "List available Machines, their purpose, Agent roles, and missing bindings.",
    promptSnippet: "Discover reusable asynchronous Machines with machine_list before starting one.",
    promptGuidelines: [
      "Use machine_list when the user asks to run a Machine or a reusable multi-step workflow may fit; choose an existing Machine by its description rather than guessing its name.",
      "If no Machine fits, handle a one-off task normally. For a reusable workflow, propose a short state sequence and ask before creating persistent Machine policy.",
    ],
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
          return `${agent.name} — ${agent.description}${identity === "" ? "" : ` (${identity})`}\n  ${agent.source}`;
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
      "Turn the Human's goal into clear Machine input without adding requirements or changing its intended scope.",
      "Pass Agent overrides only as Machine role-to-preset names previously discovered with machine_agents.",
    ],
    parameters: Type.Object({
      machine: Type.String({ description: "Exact Machine name from machine_list" }),
      input: Type.Optional(Type.String({ description: "The task or input for the Machine" })),
      agents: Type.Optional(Type.Record(
        Type.String(),
        Type.String(),
        { description: "Optional Machine role to configured Agent preset name" },
      )),
    }, { additionalProperties: false }),
    async execute(_id, rawParams, _signal, _onUpdate, context) {
      useContext(context);
      const machine = requiredString(rawParams.machine, "machine");
      const input = optionalString(rawParams.input, "input");
      const agents = optionalStringRecord(rawParams.agents, "agents");
      const runs = await getSession();
      const run = await runs.start({
        machine,
        cwd: context.cwd,
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
    description: "Inspect one exact Machine run id, or all active and recently finished runs.",
    parameters: Type.Object({
      runId: Type.Optional(Type.String({ description: "Exact run id returned by machine_start" })),
    }, { additionalProperties: false }),
    executionMode: "parallel",
    async execute(_id, rawParams, _signal, _onUpdate, context) {
      useContext(context);
      const runId = optionalString(rawParams.runId, "runId");
      const snapshots = (await getSession()).status(runId);
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

  pi.on("session_shutdown", (_event, context) => {
    shuttingDown = true;
    dialogAbort.abort();
    stopTimer();
    session?.close();
    context.ui.setWidget(widgetKey, undefined);
    ui = undefined;
  });
}

function formatSnapshot(run: RunSnapshot): string {
  const lines = [
    `${run.machine} (${run.status})`,
    `Run id: ${run.id}`,
    `State: ${formatState(run.state) ?? "starting"}`,
    `Elapsed: ${run.elapsedSeconds}s`,
  ];
  if (run.agent !== undefined) lines.push(`Agent: ${formatAgent(run.agent)}`);
  if (run.human !== undefined) {
    lines.push(`Human: ${run.human.prompt}`, `Request id: ${run.human.requestId}`);
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

function widgetLines(
  runs: readonly RunSnapshot[],
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
    const waiting = run.status === "waiting";
    const completed = run.status === "completed";
    const failed = run.status === "failed";
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
        ? "failed"
        : formatState(run.state) ?? "starting";
    const end = completed || failed ? Date.parse(run.updatedAt) : undefined;
    lines.push(
      `${edge("│")} ${theme.fg(color, symbol)} ${theme.fg("muted", shortId(run.id))}  ${theme.bold(run.machine)} › ${theme.fg(color, state)} · ${theme.fg("dim", elapsed(Date.parse(run.startedAt), end))}`,
    );
    if (run.human !== undefined) {
      for (const promptLine of run.human.prompt.split("\n")) {
        lines.push(`${edge("│")}   ${theme.fg("warning", promptLine)}`);
      }
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
