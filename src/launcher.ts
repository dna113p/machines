import { basename, dirname, isAbsolute, resolve } from "node:path";

import type { AnyStateMachine, SnapshotFrom } from "xstate";

import type { AgentPreset } from "./agent-bindings.ts";
import { configuredAgentPresets, type LauncherLocation, type MachineSummary, type AgentPresetSummary } from "./catalog.ts";
import { queryCatalog } from "./discovery-worker.ts";
import { loadMachineModule, readAgentRoles, requireMachineDescription } from "./machine-module.ts";
export type { LauncherLocation, MachineSummary, AgentPresetSummary } from "./catalog.ts";
import { discoverMachines, machinesUserHome } from "./discovery.ts";
import {
  agent,
  final,
  human,
  machine,
  operation,
  requiredAgentNames,
  run,
  type AgentRunner,
  type RunOptions,
} from "./index.ts";

export interface PrepareMachineRunOptions extends LauncherLocation {
  readonly machine: string;
  readonly input?: string;
  readonly agents?: Readonly<Record<string, string>>;
}

export interface PreparedMachineRun {
  readonly name: string;
  readonly description: string;
  readonly path: string;
  readonly agentRoles: Readonly<Record<string, string>>;
  start(options?: Omit<RunOptions, "agents">): Promise<SnapshotFrom<AnyStateMachine>>;
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
  const cwd = options.cwd ?? process.cwd();
  const home = options.home ?? machinesUserHome();
  const path = await resolveMachine(options.machine, cwd, home);
  const loaded = await loadMachineModule(path);
  const description = requireMachineDescription(loaded, path);
  const agentRoles = readAgentRoles(loaded, path);

  if (typeof loaded.default !== "function") {
    throw new Error(`Machine "${path}" must default-export a factory`);
  }

  const definition = await loaded.default(
    { agent, final, human, machine, operation },
    options.input ?? "",
  ) as AnyStateMachine;
  const configured = await configuredAgentPresets(cwd, home);
  const usedAgentRoles = requiredAgentNames(definition);
  const agents = applyAgentOverrides(
    path,
    configured.agents,
    configured.presets,
    new Set([...usedAgentRoles, ...Object.keys(agentRoles)]),
    options.agents ?? {},
  );
  preflightAgentRoles(path, usedAgentRoles, agentRoles, agents);

  let started = false;
  return {
    name: machineName(path),
    description,
    path,
    agentRoles,
    start(runOptions = {}) {
      if (started) throw new Error(`Prepared Machine "${path}" has already started`);
      started = true;
      return run(definition, { ...runOptions, agents });
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
