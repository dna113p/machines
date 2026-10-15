import { basename, dirname, isAbsolute, resolve } from "node:path";
import { existsSync } from "node:fs";

import type { AnyStateMachine, SnapshotFrom } from "xstate";

import { assertJsonValue, jsonProblem, type JsonValue } from "./json.ts";
import { fallbackPresets, type AgentPreset } from "./agent-bindings.ts";
import { createLimitMemory, defaultProbeMs, limitAwareRunner, type LimitPolicy } from "./agent-limits.ts";
import { configuredAgentPresets, type LauncherLocation, type MachineSummary, type AgentPresetSummary } from "./catalog.ts";
import { queryCatalog } from "./discovery-worker.ts";
import { loadMachineModule, readAgentRoles, requireMachineDescription } from "./machine-module.ts";
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
  run,
  wait,
  type AgentRunner,
  type RunOptions,
} from "./index.ts";
import { assertSavedState, checkpointPath, machineSourceHash, removeCheckpoint, writeCheckpoint, type RunCheckpoint } from "./run-checkpoint.ts";
import { machineGraph, statePaths, type RunGraph } from "./run-graph.ts";

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
  /** The definition's states and transitions, for run status; undefined when it is too large to draw. */
  readonly graph?: RunGraph;
  start(options?: Omit<RunOptions, "agents"> & { readonly checkpoint?: { readonly directory: string; readonly id: string; readonly sleep?: boolean } }): Promise<SnapshotFrom<AnyStateMachine>>;
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

  if (typeof loaded.default !== "function") {
    throw new Error(`Machine "${path}" must default-export a factory`);
  }

  let savedData: object = {};
  let dataCalled = false;
  const data = <T extends object>(initial: T): T => {
    if (dataCalled) throw new Error("p.data() may only be called once per Machine factory");
    dataCalled = true;
    initializeData(initial);
    savedData = options.continueRun ? structuredClone(options.continueRun.data) : initial;
    return savedData as T;
  };
  const definition = await loaded.default(
    { agent, final, human, machine, operation, wait, data },
    options.input === undefined ? "" : options.input,
  ) as AnyStateMachine;
  if (options.continueRun) assertSavedState(definition.root, options.continueRun.state.value);
  const sourceHash = machineSourceHash(path);
  const configured = await configuredAgentPresets(cwd, home);
  const usedAgentRoles = requiredAgentNames(definition);
  const requiredRoles = new Set([...usedAgentRoles, ...Object.keys(agentRoles)]);
  const overrides = options.agents ?? {};
  const agents = applyAgentOverrides(path, configured.agents, configured.presets, requiredRoles, overrides);
  preflightAgentRoles(path, usedAgentRoles, agentRoles, agents);
  const limitAware = limitAwareAgents(requiredRoles, overrides, configured, limitPolicy(options.agentLimits));

  let started = false;
  const graph = machineGraph(definition);
  return {
    name: machineName(path),
    description,
    path,
    agentRoles,
    ...(graph === undefined ? {} : { graph }),
    start(runOptions = {}) {
      if (started) throw new Error(`Prepared Machine "${path}" has already started`);
      started = true;
      const { checkpoint, ...runtimeOptions } = runOptions;
      if (runtimeOptions.onSleep && !checkpoint) throw new Error("Sleeping requires a checkpoint");
      // null means context could not be serialized; skip this checkpoint only.
      let captured: { data: Record<string, JsonValue>; context: JsonValue } | null | undefined;
      const capture = (context: unknown) => {
        try {
          const problem = jsonProblem(savedData, "data");
          if (problem) throw new Error(`Cannot save checkpoint: ${problem}`);
          const data = JSON.parse(JSON.stringify(savedData)) as Record<string, JsonValue>;
          try {
            // Context predates checkpoints and may contain runtime objects. Keep
            // JSON's normal conversions without modifying the running context.
            const saved = JSON.parse(JSON.stringify({ context })) as { context?: JsonValue };
            captured = saved.context === undefined ? null : { data, context: saved.context };
          } catch {
            captured = null;
          }
        } catch (cause) {
          if (checkpoint) removeCheckpoint(checkpoint.directory, checkpoint.id);
          throw cause;
        }
      };
      return run(definition, {
        ...runtimeOptions,
        ...(runtimeOptions.onSleep ? { onSleep(due: string) {
          if (!checkpoint || !existsSync(checkpointPath(checkpoint.directory, checkpoint.id))) {
            throw new Error("Cannot sleep without a saved checkpoint");
          }
          runtimeOptions.onSleep?.(due);
        } } : {}),
        agents: { ...agents, ...limitAware },
        ...(options.continueRun ? { continueAt: { value: options.continueRun.state.value, context: options.continueRun.context,
          ...(options.continueRun.state.due === undefined ? {} : { due: options.continueRun.state.due }) } } : {}),
        ...(checkpoint ? { onBeforeStep: capture, onEnter(entry) {
          try {
            if (captured === undefined) capture(entry.context);
            if (entry.kind === "final" || captured === null) removeCheckpoint(checkpoint.directory, checkpoint.id);
            else writeCheckpoint(checkpoint.directory, {
              schemaVersion: 1,
              id: checkpoint.id,
              machine: { name: machineName(path), path, sourceHash },
              input: options.input === undefined ? "" : options.input,
              agents: options.agents ?? {}, home, cwd,
              ...(checkpoint.sleep ? { sleep: true } : {}),
              state: { value: entry.value, kind: entry.kind, enteredAt: entry.enteredAt, path: statePaths(entry.value).join(", "),
                ...(entry.due === undefined ? {} : { due: entry.due }) },
              data: captured!.data,
              context: captured!.context,
              writtenAt: new Date().toISOString(),
            });
          } catch (cause) {
            removeCheckpoint(checkpoint.directory, checkpoint.id);
            throw cause;
          }
          captured = undefined;
          runtimeOptions.onEnter?.(entry);
        } } : {}),
      });
    },
  };
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
 * of limited presets, kept only for this prepared run.
 */
function limitAwareAgents(
  roles: ReadonlySet<string>,
  overrides: Readonly<Record<string, string>>,
  configured: Awaited<ReturnType<typeof configuredAgentPresets>>,
  policy: LimitPolicy,
): Readonly<Record<string, AgentRunner>> {
  const swapping = fallbackEnabled();
  const memory = createLimitMemory();
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
      return { name, runner: preset.runner, ...(preset.harness === undefined ? {} : { harness: preset.harness }) };
    });
    wrapped[role] = limitAwareRunner(role, candidates, memory, policy);
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
  agents: Readonly<Record<string, AgentRunner>>,
): void {
  const undeclared = usedNames.filter(
    (name) => name !== "default" && !Object.hasOwn(declaredRoles, name),
  );
  if (undeclared.length > 0) {
    throw new Error(
      `Machine "${machinePath}" uses undeclared Agent roles: ${undeclared.join(", ")}`,
    );
  }

  const required = new Set([...usedNames, ...Object.keys(declaredRoles)]);
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
