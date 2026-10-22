import { formatNote, runNoteProblem } from "./run-note.ts";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { existsSync } from "node:fs";

import { fromPromise, type AnyStateMachine, type SnapshotFrom, type StateValue } from "xstate";

import { assertJsonValue, jsonProblem, type JsonValue } from "./json.ts";
import { fallbackPresets, type AgentPreset } from "./agent-bindings.ts";
import { effectiveProviderOrder, sortProviderCandidates } from "./provider-order.ts";
import { launcherLimitMemory, defaultProbeMs, limitAwareRunner, type LimitPolicy } from "./agent-limits.ts";
import { configuredAgentPresets, type LauncherLocation, type MachineSummary, type AgentPresetSummary } from "./catalog.ts";
import { queryCatalog } from "./discovery-worker.ts";
import { loadMachineModule, readAgentRoles, readOptionalAgentRoles, readUses, requireMachineDescription } from "./machine-module.ts";
import { assertUseStates, loadUseTree, usedModules, useStates, type UseModule } from "./composition.ts";
import { assertEndingOutput, assertEndingStates, readEndings, type MachineEndings } from "./endings.ts";
export type { LauncherLocation, MachineSummary, AgentPresetSummary } from "./catalog.ts";
import { discoverMachines, machinesUserHome } from "./discovery.ts";
import {
  agent,
  data as initializeData,
  final,
  human,
  machine,
  operation,
  requiredAgentNames,
  optionalAgentNames,
  run,
  status as validateStatus,
  type WorkflowStatus,
  wait,
  use,
  type Event,
  type AgentRunner,
  type RunOptions,
} from "./index.ts";
import { assertSavedState, checkpointPath, machineSourceHash, removeCheckpoint, writeCheckpoint, type ChildCheckpoint, type RunCheckpoint } from "./run-checkpoint.ts";
import { machineGraph, nestGraph, statePaths, type RunGraph } from "./run-graph.ts";

export interface PrepareMachineRunOptions extends LauncherLocation {
  readonly machine: string;
  readonly continueRun?: RunCheckpoint;
  readonly input?: JsonValue;
  readonly agents?: Readonly<Record<string, string>>;
  /**
   * How this process waits at an Agent usage limit. `waitMinutes` overrides
   * MACHINES_AGENT_LIMIT_WAIT_MINUTES; a hosted run reads the variable instead.
   */
  readonly agentLimits?: {
    readonly waitMinutes?: number;
    readonly now?: () => number;
    readonly sleep?: (milliseconds: number) => Promise<void>;
  };
}

export interface PreparedMachineRun {
  readonly name: string;
  readonly description: string;
  readonly path: string;
  readonly agentRoles: Readonly<Record<string, string>>;
  readonly endings?: MachineEndings;
  /** The definition's states and transitions, for run status; undefined when it is too large to draw. */
  readonly graph?: RunGraph;
  start(options?: Omit<RunOptions, "agents"> & {
    /** Reports the full graph when a started child adds states or edges. */
    readonly onGraph?: (graph: RunGraph) => void;
    /** Current presentation, restored from a checkpoint; null now or an empty note clears that field. */
    readonly onStatus?: (change: WorkflowStatus) => void;
    readonly checkpoint?: { readonly directory: string; readonly id: string; readonly sleep?: boolean };
  }): Promise<SnapshotFrom<AnyStateMachine>>;
}

export async function listMachines(location: LauncherLocation = {}): Promise<readonly MachineSummary[]> {
  return queryCatalog("machines", location);
}

export async function listAgentPresets(location: LauncherLocation = {}): Promise<readonly AgentPresetSummary[]> {
  return queryCatalog("agents", location);
}

export async function prepareMachineRun(
  options: PrepareMachineRunOptions,
): Promise<PreparedMachineRun> {
  if (options.input !== undefined) assertJsonValue(options.input, "Machine input");
  const cwd = resolve(options.cwd ?? process.cwd());
  const home = options.home ?? machinesUserHome();
  const path = await resolveMachine(options.machine, cwd, home);
  const loaded = await loadMachineModule(path);
  const description = requireMachineDescription(loaded, path);
  const agentRoles = readAgentRoles(loaded, path);
  const optional = readOptionalAgentRoles(loaded, path);
  const endings = readEndings(loaded, path);

  const noteProblem = runNoteProblem(options.continueRun ?? {});
  if (noteProblem) throw new Error(`Cannot continue: ${noteProblem}`);
  let note = options.continueRun?.note;
  let page = options.continueRun?.page;
  let now = options.continueRun?.now;
  let statusChanged: (() => void) | undefined;
  const status = (change: WorkflowStatus) => {
    validateStatus(change);
    if (change.now === undefined && change.note === undefined) return;
    if (change.now !== undefined) now = change.now ?? undefined;
    if (change.note !== undefined) {
      note = formatNote(change.note);
      page = change.page;
    }
    statusChanged?.();
  };
  const { definition, savedData } = await buildDefinition(loaded, path,
    options.input === undefined ? "" : options.input, options.continueRun?.data, status);
  const children = await loadUseTree(path, readUses(loaded, path), { cwd, home }, definition);
  assertUseStates(definition, path, children);
  assertEndingStates(definition, endings, path);
  if (options.continueRun) assertSavedState(definition.root, options.continueRun.state.value);
  const sourceHash = machineSourceHash(path);
  const configured = await configuredAgentPresets(cwd, home);
  const usedAgentRoles = requiredAgentNames(definition);
  const childModules = usedModules(children);
  const requiredRoles = new Set([
    ...usedAgentRoles, ...Object.keys(agentRoles).filter((name) => !optional.includes(name)),
    ...childModules.flatMap((child) => ["default", ...Object.keys(child.agentRoles).filter((name) => !child.optionalAgentRoles.includes(name))]),
  ]);
  const optionalRoles = new Set([...optional, ...optionalAgentNames(definition),
    ...childModules.flatMap((child) => child.optionalAgentRoles)]);
  const allRoles = new Set([...requiredRoles, ...optionalRoles]);
  const overrides = options.agents ?? {};
  const agents = applyAgentOverrides(path, configured.agents, configured.presets, allRoles, overrides);
  preflightAgentRoles(path, usedAgentRoles, agentRoles, optional, agents, optionalAgentNames(definition));
  for (const child of childModules) preflightAgentRoles(child.path, ["default"], child.agentRoles, child.optionalAgentRoles, agents);
  const restored = await restoreChildren(definition, children, options.continueRun, agents, status);
  const limitAware = limitAwareAgents(new Set([...allRoles].filter((role) => requiredRoles.has(role) || Object.hasOwn(agents, role))), overrides, configured, limitPolicy(options.agentLimits), await effectiveProviderOrder(home));

  let started = false;
  const graph = machineGraph(definition, endings);
  return {
    name: machineName(path),
    description,
    path,
    agentRoles,
    ...(endings === undefined ? {} : { endings }),
    ...(graph === undefined ? {} : { graph }),
    start(runOptions = {}) {
      if (started) throw new Error(`Prepared Machine "${path}" has already started`);
      started = true;
      const { checkpoint, onGraph, onStatus, ...runtimeOptions } = runOptions;
      if ((runtimeOptions.onSleep || runtimeOptions.onHumanSleep) && !checkpoint) throw new Error("Sleeping requires a checkpoint");
      const frames: (ChildCheckpoint | null)[] = [];
      if (options.continueRun) {
        let level: ChildCheckpoint | undefined = options.continueRun;
        while (level) {
          const { children: nested, ...frame }: ChildCheckpoint = level;
          // Keep run metadata out of the reusable state frames.
          frames.push({
            machine: frame.machine, input: frame.input, state: frame.state,
            data: frame.data, context: frame.context,
            ...(frame.history === undefined ? {} : { history: frame.history }),
          });
          level = nested?.[0];
        }
      }
      const hooks = checkpointHooks(checkpoint, frames, {
        input: options.input === undefined ? "" : options.input,
        agents: options.agents ?? {}, home, cwd,
      }, () => ({
        ...(now === undefined ? {} : { now }),
        ...(note === undefined ? {} : { note }),
        ...(page === undefined ? {} : { page }),
      }));
      statusChanged = () => {
        // Rewrite captured frames, never recapture live data in the middle of a step.
        hooks.write();
        onStatus?.({ now: now ?? null, note: note ?? "",
          ...(page === undefined ? {} : { page }),
        });
      };
      statusChanged();
      const shared: RunOptions = {
        agents: { ...agents, ...limitAware },
        human: runtimeOptions.human,
        onAgentUpdate: runtimeOptions.onAgentUpdate,
        onHumanInput: runtimeOptions.onHumanInput,
      };
      return runWithChildren(definition, children, shared, {
        ...runtimeOptions,
        description,
        ...(restored ? { answer: undefined } : {}),
        ...(runtimeOptions.onSleep ? { onSleep(due: string) {
          if (!checkpoint || !existsSync(checkpointPath(checkpoint.directory, checkpoint.id))) {
            throw new Error("Cannot sleep without a saved checkpoint");
          }
          runtimeOptions.onSleep?.(due);
        } } : {}),
        ...(runtimeOptions.onHumanSleep ? { onHumanSleep(request) {
          if (!checkpoint || !existsSync(checkpointPath(checkpoint.directory, checkpoint.id))) {
            throw new Error("Cannot sleep without a saved checkpoint");
          }
          runtimeOptions.onHumanSleep?.(request);
        } } : {}),
        agents: { ...agents, ...limitAware },
        ...(options.continueRun ? { continueAt: { value: options.continueRun.state.value, context: options.continueRun.context, history: options.continueRun.history,
          ...(options.continueRun.state.retry === undefined ? {} : { retry: options.continueRun.state.retry }),
          ...(options.continueRun.state.due === undefined ? {} : { due: options.continueRun.state.due }) } } : {}),
        ...hooks(0, { name: machineName(path), path, sourceHash }, options.input === undefined ? "" : options.input,
          savedData, runtimeOptions.onEnter),
      }, graph, onGraph, hooks, status, 1, restored, runtimeOptions.answer).then((snapshot) => {
        assertEndingOutput(snapshot, endings);
        return snapshot;
      }).finally(() => { statusChanged = undefined; });
    },
  };
}

/** Every invocation owns its working data, including repeated uses of one module. */
async function buildDefinition(
  loaded: Record<string, unknown>,
  path: string,
  input: JsonValue,
  restoredData?: object,
  status: typeof validateStatus = validateStatus,
): Promise<{ definition: AnyStateMachine; savedData: object }> {
  if (typeof loaded.default !== "function") throw new Error(`Machine "${path}" must default-export a factory`);
  let savedData: object = {};
  let dataCalled = false;
  const data = <T extends object>(initial: T): T => {
    if (dataCalled) throw new Error("p.data() may only be called once per Machine factory");
    dataCalled = true;
    initializeData(initial);
    savedData = restoredData === undefined ? initial : Object.assign(initial, structuredClone(restoredData));
    return savedData as T;
  };
  const definition = await loaded.default(
    { agent, final, human, machine, operation, wait, use, data, status }, input,
  ) as AnyStateMachine;
  return { definition, savedData };
}

type BuiltDefinition = Awaited<ReturnType<typeof buildDefinition>>;
interface RestoredChild extends BuiltDefinition {
  readonly saved: ChildCheckpoint;
  readonly child?: RestoredChild;
}

/** Validate the entire saved chain before any state can perform work. */
async function restoreChildren(
  definition: AnyStateMachine,
  children: ReadonlyMap<string, UseModule>,
  saved: ChildCheckpoint | undefined,
  agents: Readonly<Record<string, AgentRunner>>,
  status: typeof validateStatus,
): Promise<RestoredChild | undefined> {
  const next = saved?.children?.[0];
  if (!next || !saved) return undefined;
  const entry = useStates(definition).find((entry) => entry.path === statePaths(saved.state.value)[0]);
  const child = entry && children.get(entry.selector);
  if (!child || child.path !== next.machine.path) {
    throw new Error(`Cannot continue: saved child "${next.machine.path}" no longer matches the parent's use state`);
  }
  const built = await buildDefinition(child.loaded, child.path, next.input, next.data, status);
  assertSavedState(built.definition.root, next.state.value);
  assertEndingStates(built.definition, child.endings, child.path);
  assertUseStates(built.definition, child.path, child.children);
  preflightAgentRoles(child.path, requiredAgentNames(built.definition), child.agentRoles, child.optionalAgentRoles, agents, optionalAgentNames(built.definition));
  return { ...built, saved: next, child: await restoreChildren(built.definition, child.children, next, agents, status) };
}

/** Each level captures before input evaluation; one writer joins the active frames. */
function checkpointHooks(
  checkpoint: { readonly directory: string; readonly id: string; readonly sleep?: boolean } | undefined,
  frames: (ChildCheckpoint | null)[],
  root: Pick<RunCheckpoint, "input" | "agents" | "home" | "cwd">,
  presentation: () => Pick<RunCheckpoint, "now" | "note" | "page">,
) {
  const write = () => {
    if (!checkpoint || frames.length === 0) return;
    if (frames.some((frame) => frame === null)) {
      removeCheckpoint(checkpoint.directory, checkpoint.id);
      return;
    }
    const nest = (depth: number): ChildCheckpoint => ({
      ...frames[depth]!,
      ...(depth + 1 < frames.length ? { children: [nest(depth + 1)] as const } : {}),
    });
    writeCheckpoint(checkpoint.directory, {
      ...root, ...nest(0), ...presentation(), schemaVersion: 2, id: checkpoint.id,
      ...(checkpoint.sleep ? { sleep: true } : {}), writtenAt: new Date().toISOString(),
    });
  };
  const hooks = (depth: number, machine: ChildCheckpoint["machine"], input: JsonValue, savedData: object,
    onEnter?: RunOptions["onEnter"]): Pick<RunOptions, "onBeforeStep" | "onEnter"> => {
    if (!checkpoint) return {};
    let firstEntry = true;
    // null means this level's context could not be serialized.
    let captured: Pick<ChildCheckpoint, "data" | "context"> | null | undefined;
    const capture = (context: unknown) => {
      try {
        const problem = jsonProblem(savedData, "data");
        if (problem) throw new Error(`Cannot save checkpoint: ${problem}`);
        const data = JSON.parse(JSON.stringify(savedData)) as Record<string, JsonValue>;
        try {
          // Preserve JSON's normal context conversions without changing live objects.
          const saved = JSON.parse(JSON.stringify({ context })) as { context?: JsonValue };
          captured = saved.context === undefined ? null : { data, context: saved.context };
        } catch { captured = null; }
      } catch (cause) {
        removeCheckpoint(checkpoint.directory, checkpoint.id);
        throw cause;
      }
    };
    return { onBeforeStep: capture, onEnter(entry) {
      try {
        if (captured === undefined) capture(entry.context);
        if (entry.kind === "final") {
          frames.length = depth;
          if (depth === 0) removeCheckpoint(checkpoint.directory, checkpoint.id);
        } else {
          if (!firstEntry) frames.length = depth + 1;
          frames[depth] = captured === null ? null : {
            machine, input, ...captured!,
            ...(entry.history === undefined ? {} : { history: entry.history }),
            state: { value: entry.value, kind: entry.kind, enteredAt: entry.enteredAt, path: statePaths(entry.value).join(", "),
              ...(entry.retry === undefined ? {} : { retry: entry.retry }),
              ...(entry.due === undefined ? {} : { due: entry.due }) },
          };
          write();
        }
      } catch (cause) {
        removeCheckpoint(checkpoint.directory, checkpoint.id);
        throw cause;
      }
      firstEntry = false;
      captured = undefined;
      onEnter?.(entry);
    } };
  };
  return Object.assign(hooks, { write });
}

/** Compose child execution, observations and checkpoint hooks at each level. */
function runWithChildren(
  definition: AnyStateMachine,
  children: ReadonlyMap<string, UseModule>,
  shared: RunOptions,
  options: RunOptions,
  graph: RunGraph | undefined,
  onGraph: ((graph: RunGraph) => void) | undefined,
  hooks: ReturnType<typeof checkpointHooks>,
  status: typeof validateStatus,
  depth: number,
  restore?: RestoredChild,
  answer?: string,
): Promise<SnapshotFrom<AnyStateMachine>> {
  const uses = useStates(definition);
  if (uses.length === 0) return run(definition, options);
  const paths = new Map(uses.map((entry) => [entry.actorId, entry.path]));
  const active = new Map<string, { value?: StateValue; signal: AbortSignal }>();
  let parentState: StateValue | undefined;
  const report = () => {
    if (parentState === undefined) return;
    let state = parentState;
    for (const [path, child] of active) {
      if (!child.signal.aborted && child.value !== undefined) state = nestState(state, path.split("."), child.value);
    }
    options.onState?.(state);
  };
  const grow = (path: string, child: RunGraph) => {
    if (graph === undefined) return;
    const next = nestGraph(graph, path, child);
    if (next === graph) return;
    graph = next;
    onGraph?.(graph);
  };
  const actor = fromPromise<Event, {
    readonly selector: string; readonly input: unknown;
    readonly sleep?: Pick<RunOptions, "onSleep" | "onHumanSleep">;
  }>(async ({ input, self, signal }) => {
    const path = paths.get(self.id)!;
    const child = children.get(input.selector);
    if (!child) throw new Error(`Child Machine "${input.selector}" was not loaded by prepareMachineRun`);
    const restored = restore;
    restore = undefined;
    const childInput = restored ? restored.saved.input : input.input;
    assertJsonValue(childInput, `Child Machine "${child.path}" input`);
    const { definition, savedData } = restored ?? await buildDefinition(child.loaded, child.path, childInput, undefined, status);
    assertEndingStates(definition, child.endings, child.path);
    assertUseStates(definition, child.path, child.children);
    preflightAgentRoles(child.path, requiredAgentNames(definition), child.agentRoles, child.optionalAgentRoles, shared.agents ?? {}, optionalAgentNames(definition));
    const observation: { value?: StateValue; signal: AbortSignal } = { signal };
    const childGraph = machineGraph(definition, child.endings);
    const reportGraph = (next: RunGraph) => { if (!signal.aborted) grow(path, next); };
    if (!signal.aborted) active.set(path, observation);
    try {
      if (childGraph) reportGraph(childGraph);
      let slept = false;
      const snapshot = await runWithChildren(definition, child.children, shared, {
        ...shared,
        description: requireMachineDescription(child.loaded, child.path),
        ...hooks(depth, { name: machineName(child.path), path: child.path, sourceHash: child.sourceHash }, childInput, savedData),
        ...(restored ? { continueAt: { value: restored.saved.state.value, context: restored.saved.context, history: restored.saved.history,
          ...(restored.saved.state.retry === undefined ? {} : { retry: restored.saved.state.retry }),
          ...(restored.saved.state.due === undefined ? {} : { due: restored.saved.state.due }) },
          ...(!restored.child ? { answer } : {}) } : {}),
        ...(input.sleep?.onSleep ? { onSleep(due) { input.sleep!.onSleep!(due); slept = true; } } : {}),
        ...(input.sleep?.onHumanSleep ? { onHumanSleep(request) { input.sleep!.onHumanSleep!(request); slept = true; } } : {}),
        onState(state) {
          if (signal.aborted) return;
          observation.value = state;
          report();
        },
      }, childGraph, reportGraph, hooks, status, depth + 1, restored?.child, restored ? answer : undefined);
      if (slept) {
        // Sleeping is not a child ending. Let the parent's stop abort this invoke.
        if (!signal.aborted) await new Promise<void>((done) => signal.addEventListener("abort", () => done(), { once: true }));
        signal.throwIfAborted();
      }
      assertEndingOutput(snapshot, child.endings);
      if (snapshot.status !== "done" || typeof snapshot.value !== "string" || !Object.hasOwn(child.endings, snapshot.value)) {
        throw new Error(`Child Machine "${child.path}" did not reach a declared ending`);
      }
      return { type: snapshot.value, output: snapshot.output };
    } finally {
      if (active.get(path) === observation) active.delete(path);
    }
  });
  return run(definition.provide({ actors: { use: actor } }), {
    ...options,
    onState(state) { parentState = state; report(); },
  });
}

/** Replace an active leaf only, preserving any parallel branches. */
function nestState(state: StateValue, [key, ...rest]: readonly string[], child: StateValue): StateValue {
  if (key === undefined) return child;
  if (typeof state === "string") return state === key && rest.length === 0 ? { [key]: child } : state;
  if (!Object.hasOwn(state, key)) return state;
  return { ...state, [key]: nestState(state[key]!, rest, child) };
}

async function resolveMachine(selector: string, cwd: string, home: string): Promise<string> {
  if (isAbsolute(selector) || selector.includes("/") || selector.endsWith(".ts")) {
    return resolve(cwd, selector);
  }

  const machines = await discoverMachines(cwd, home);
  const found = machines.find((candidate) => candidate.name === selector);
  if (found === undefined) {
    throw new Error(`Machine "${selector}" not found. Run "machine list" to see available Machines.`);
  }
  return found.path;
}

function applyAgentOverrides(
  machinePath: string,
  agents: Readonly<Record<string, AgentRunner>>,
  presets: Readonly<Record<string, AgentPreset>>,
  requiredRoles: ReadonlySet<string>,
  overrides: Readonly<Record<string, string>>,
): Readonly<Record<string, AgentRunner>> {
  const resolved = { ...agents };
  for (const [role, presetName] of Object.entries(overrides)) {
    if (role.trim() === "" || role !== role.trim()) {
      throw new Error("Agent override roles must be non-empty trimmed strings");
    }
    if (presetName.trim() === "" || presetName !== presetName.trim()) {
      throw new Error(`Agent override for role "${role}" must name a preset`);
    }
    if (!requiredRoles.has(role)) {
      throw new Error(
        `Machine "${machinePath}" does not declare or use Agent role "${role}"`,
      );
    }
    const selected = Object.hasOwn(presets, presetName) ? presets[presetName] : undefined;
    if (selected === undefined) {
      const available = Object.keys(presets).sort().join(", ");
      throw new Error(
        `Agent preset "${presetName}" was not found for role "${role}". Available presets: ${available}`,
      );
    }
    resolved[role] = selected.runner;
  }
  return resolved;
}

/**
 * Wraps each role the Machine uses or declares so that a usage limit swaps to
 * the bound preset's fallbacks or waits for a reset. The roles share one memory
 * of limited presets across runs, unless persistence is disabled.
 */
function limitAwareAgents(
  roles: ReadonlySet<string>,
  overrides: Readonly<Record<string, string>>,
  configured: Awaited<ReturnType<typeof configuredAgentPresets>>,
  policy: LimitPolicy,
  providerOrder: readonly string[],
): Readonly<Record<string, AgentRunner>> {
  const swapping = fallbackEnabled();
  const memory = launcherLimitMemory();
  const wrapped: Record<string, AgentRunner> = {};
  for (const role of roles) {
    const bound = Object.hasOwn(overrides, role) ? overrides[role] ?? role : role;
    // With swapping off a role still waits for its own preset's reset, and names no other preset.
    const fallback = swapping
      ? fallbackPresets(bound, presetNamed(configured.presets, bound) ?? {}, configured.fallback) ?? []
      : [];
    const candidates = [bound, ...fallback].map((name) => {
      const preset = presetNamed(configured.presets, name);
      if (preset === undefined) {
        const available = Object.keys(configured.presets).sort().join(", ");
        throw new Error(
          `Agent preset "${bound}" for role "${role}" falls back to "${name}", which is not a configured preset. Available presets: ${available}`,
        );
      }
      return {
        name, runner: preset.runner,
        ...(preset.harness === undefined ? {} : { harness: preset.harness }),
        ...(preset.model === undefined ? {} : { model: preset.model }),
      };
    });
    wrapped[role] = limitAwareRunner(role, sortProviderCandidates(candidates, providerOrder), memory, policy, candidates[0]);
  }
  return wrapped;
}

function presetNamed(presets: Readonly<Record<string, AgentPreset>>, name: string): AgentPreset | undefined {
  return Object.hasOwn(presets, name) ? presets[name] : undefined;
}

function fallbackEnabled(): boolean {
  const configured = process.env.MACHINES_AGENT_FALLBACK;
  if (configured === undefined || configured === "" || configured === "on") return true;
  if (configured === "off") return false;
  throw new Error(`MACHINES_AGENT_FALLBACK must be "off" or "on", not "${configured}"`);
}

const defaultLimitWaitMinutes = 360;

function limitPolicy(options: PrepareMachineRunOptions["agentLimits"] = {}): LimitPolicy {
  const configured = process.env.MACHINES_AGENT_LIMIT_WAIT_MINUTES;
  let minutes = defaultLimitWaitMinutes;
  if (options.waitMinutes !== undefined) {
    if (!Number.isFinite(options.waitMinutes) || options.waitMinutes < 0) {
      throw new Error("agentLimits.waitMinutes must be a non-negative number of minutes");
    }
    minutes = options.waitMinutes;
  } else if (configured !== undefined && configured !== "") {
    if (!/^\d+(?:\.\d+)?$/u.test(configured)) {
      throw new Error(
        `MACHINES_AGENT_LIMIT_WAIT_MINUTES must be a non-negative number of minutes, not "${configured}"`,
      );
    }
    minutes = Number(configured);
  }
  return {
    maxWaitMs: minutes * 60_000,
    probeMs: defaultProbeMs,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
  };
}

function preflightAgentRoles(
  machinePath: string,
  usedNames: readonly string[],
  declaredRoles: Readonly<Record<string, string>>,
  optional: readonly string[],
  agents: Readonly<Record<string, AgentRunner>>,
  presenters: readonly string[] = [],
): void {
  for (const role of presenters) {
    if (!optional.includes(role)) throw new Error(`Machine "${machinePath}" presenter role "${role}" must be declared optional: true`);
  }
  for (const role of usedNames) {
    if (optional.includes(role)) throw new Error(`Machine "${machinePath}" optional role "${role}" cannot be used by an Agent state`);
  }
  const undeclared = usedNames.filter(
    (name) => name !== "default" && !Object.hasOwn(declaredRoles, name),
  );
  if (undeclared.length > 0) {
    throw new Error(
      `Machine "${machinePath}" uses undeclared Agent roles: ${undeclared.join(", ")}`,
    );
  }

  const required = new Set([...usedNames, ...Object.keys(declaredRoles).filter((name) => !optional.includes(name))]);
  const missing = [...required].filter((name) => !Object.hasOwn(agents, name));
  if (missing.length === 0) return;

  const lines = missing.map((name) => {
    const description = declaredRoles[name];
    return description === undefined ? `- ${name}` : `- ${name}: ${description}`;
  });
  throw new Error([
    `Machine "${machinePath}" is missing required Agent runners:`,
    ...lines,
    "Configure them in ~/.machines/agents.ts or the nearest project .machines/agents.ts.",
  ].join("\n"));
}

function machineName(path: string): string {
  const fileName = basename(path);
  return fileName === "index.ts"
    ? basename(dirname(path))
    : fileName.replace(/\.ts$/u, "");
}
