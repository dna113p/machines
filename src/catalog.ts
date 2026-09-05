import { loadAgentBindings, type AgentPreset } from "./agent-bindings.ts";
import { acpAgent } from "./acp.ts";
import { discoverMachines, machinesUserHome } from "./discovery.ts";
import type { AgentRunner } from "./index.ts";
import { loadMachineModule, readAgentRoles, requireMachineDescription } from "./machine-module.ts";

export interface MachineSummary {
  readonly name: string;
  readonly description: string;
  readonly path: string;
  readonly agentRoles: Readonly<Record<string, string>>;
  readonly missingAgents: readonly string[];
  readonly error?: string;
}

export interface AgentPresetSummary {
  readonly name: string;
  readonly description: string;
  readonly harness?: string;
  readonly model?: string;
  readonly thinking?: string;
  readonly source: string;
}

export interface LauncherLocation {
  readonly cwd?: string;
  readonly home?: string;
}

interface ResolvedAgentPresets {
  readonly agents: Readonly<Record<string, AgentRunner>>;
  readonly presets: Readonly<Record<string, AgentPreset>>;
  readonly sources: Readonly<Record<string, string>>;
}

export async function inspectMachines(
  location: LauncherLocation = {},
): Promise<readonly MachineSummary[]> {
  const cwd = location.cwd ?? process.cwd();
  const home = location.home ?? machinesUserHome();
  const discovered = await discoverMachines(cwd, home);
  const bindings = await configuredAgentPresets(cwd, home)
    .then((value) => ({ value, error: undefined }),
      (cause: unknown) => ({ value: undefined, error: errorMessage(cause) }));
  return Promise.all(discovered.map(async (found) => {
    try {
      const loaded = await loadMachineModule(found.path);
      const description = requireMachineDescription(loaded, found.path);
      const agentRoles = readAgentRoles(loaded, found.path);
      if (typeof loaded.default !== "function") {
        throw new Error(`Machine "${found.path}" must default-export a factory`);
      }
      return {
        ...found,
        description,
        agentRoles,
        missingAgents: Object.keys(agentRoles).filter((name) =>
          bindings.value !== undefined && !Object.hasOwn(bindings.value.agents, name)),
        ...(bindings.error === undefined ? {} : { error: bindings.error }),
      };
    } catch (cause) {
      return { ...found, description: "", agentRoles: {}, missingAgents: [], error: errorMessage(cause) };
    }
  }));
}

export async function inspectAgentPresets(
  location: LauncherLocation = {},
): Promise<readonly AgentPresetSummary[]> {
  const cwd = location.cwd ?? process.cwd();
  const home = location.home ?? machinesUserHome();
  const configured = await configuredAgentPresets(cwd, home);

  return Object.entries(configured.presets)
    .map(([name, preset]) => ({
      name,
      description: preset.description,
      ...(preset.harness === undefined ? {} : { harness: preset.harness }),
      ...(preset.model === undefined ? {} : { model: preset.model }),
      ...(preset.thinking === undefined ? {} : { thinking: preset.thinking }),
      source: configured.sources[name] ?? "unknown",
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export async function configuredAgentPresets(
  cwd: string,
  home: string,
): Promise<ResolvedAgentPresets> {
  const configured = await loadAgentBindings(cwd, home, { acpAgent });
  const defaultRunner = acpAgent("npx", ["-y", "pi-acp"], {
    harness: "pi-acp",
    output: "capture",
  });
  return {
    agents: { default: defaultRunner, ...configured.agents },
    presets: {
      default: {
        description: "Runs the current Pi Agent through ACP",
        harness: "pi-acp",
        runner: defaultRunner,
      },
      ...configured.presets,
    },
    sources: { default: "built in", ...configured.sources },
  };
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
