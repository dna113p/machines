import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { AgentQuota } from "./agent-limit.ts";
import type { AgentRunner } from "./index.ts";
import { machinesUserHome, nearestMachinesDirectory } from "./discovery.ts";

export interface AgentPreset {
  readonly description: string;
  readonly runner: AgentRunner;
  readonly harness?: string;
  readonly model?: string;
  readonly thinking?: string;
  /** Current headroom of the provider behind this preset, when it can be read. */
  readonly quota?: () => Promise<AgentQuota | undefined>;
  /** Percent remaining at or below which the preset counts as limited. */
  readonly reserve?: number;
  /** Presets that take over at a usage limit, in order, instead of the shared list. `[]` never swaps. */
  readonly fallback?: readonly string[];
}

export interface LoadedAgentBindings {
  readonly agents: Readonly<Record<string, AgentRunner>>;
  readonly presets: Readonly<Record<string, AgentPreset>>;
  readonly sources: Readonly<Record<string, string>>;
  /** The shared fallback list from the nearest file that exports one. */
  readonly fallback?: readonly string[];
}

export type AgentAdapters = Readonly<Record<string, unknown>>;

const presetFields = new Set(["description", "runner", "harness", "model", "thinking", "fallback", "quota", "reserve"]);

export async function loadAgentBindings(
  cwd = process.cwd(),
  home = machinesUserHome(),
  adapters: AgentAdapters = {},
): Promise<LoadedAgentBindings> {
  const globalPath = join(home, ".machines", "agents.ts");
  const projectDirectory = await nearestMachinesDirectory(cwd);
  const projectPath = projectDirectory === undefined
    ? undefined
    : join(projectDirectory, "agents.ts");
  const paths = projectPath === undefined || resolve(projectPath) === resolve(globalPath)
    ? [globalPath]
    : [globalPath, projectPath];
  const agents: Record<string, AgentRunner> = {};
  const presets: Record<string, AgentPreset> = {};
  const sources: Record<string, string> = {};
  let fallback: readonly string[] | undefined;

  for (const path of paths) {
    if (!await isFile(path)) continue;
    const loaded = await loadBindingFile(path, adapters);
    for (const [name, preset] of Object.entries(loaded.presets)) {
      agents[name] = preset.runner;
      presets[name] = preset;
      sources[name] = path;
    }
    // The nearer file's list replaces the other; the lists are never merged.
    fallback = loaded.fallback ?? fallback;
  }

  return { agents, presets, sources, ...(fallback === undefined ? {} : { fallback }) };
}

/** The presets that take over from one preset at a usage limit: its own chain, else the shared list without itself. */
export function fallbackPresets(
  name: string,
  preset: Pick<AgentPreset, "fallback">,
  shared: readonly string[] | undefined,
): readonly string[] | undefined {
  return preset.fallback ?? shared?.filter((other) => other !== name);
}

async function loadBindingFile(
  path: string,
  adapters: AgentAdapters,
): Promise<{ readonly presets: Readonly<Record<string, AgentPreset>>; readonly fallback?: readonly string[] }> {
  let loaded: unknown;
  try {
    loaded = await import(pathToFileURL(path).href);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`Could not load Agent bindings from "${path}": ${message}`, { cause });
  }

  const configure = (loaded as { readonly default?: unknown }).default;
  if (typeof configure !== "function") {
    throw new Error(`Agent bindings "${path}" must default-export a function`);
  }

  let value: unknown;
  try {
    value = await configure(adapters);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`Could not configure Agent bindings from "${path}": ${message}`, { cause });
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Agent bindings "${path}" must return an object`);
  }

  const bindings: Record<string, AgentPreset> = {};
  for (const [name, preset] of Object.entries(value)) {
    if (name.trim() === "" || name !== name.trim()) {
      throw new Error(`Agent bindings "${path}" contain a non-trimmed or empty name`);
    }
    if (preset === null || typeof preset !== "object" || Array.isArray(preset)) {
      throw new Error(`Agent preset "${name}" in "${path}" must be an object`);
    }
    const unknownFields = Object.keys(preset).filter((field) => !presetFields.has(field));
    if (unknownFields.length > 0) {
      throw new Error(
        `Agent preset "${name}" in "${path}" has unknown fields: ${unknownFields.join(", ")}`,
      );
    }
    const candidate = preset as Partial<AgentPreset>;
    const description = oneLine(candidate.description, "description", name, path);
    if (typeof candidate.runner !== "function") {
      throw new Error(`Agent preset "${name}" in "${path}" must include a runner function`);
    }
    if (candidate.quota !== undefined && typeof candidate.quota !== "function") {
      throw new Error(`Agent preset "${name}" in "${path}" quota must be a function`);
    }
    if (candidate.reserve !== undefined && (!Number.isFinite(candidate.reserve)
      || candidate.reserve < 0 || candidate.reserve > 100 || candidate.quota === undefined)) {
      throw new Error(`Agent preset "${name}" in "${path}" reserve must be a number from 0 to 100 and requires quota`);
    }
    bindings[name] = {
      ...(candidate.quota === undefined ? {} : { quota: candidate.quota }),
      ...(candidate.reserve === undefined ? {} : { reserve: candidate.reserve }),
      description,
      runner: candidate.runner,
      ...optionalField(candidate.harness, "harness", name, path),
      ...optionalField(candidate.model, "model", name, path),
      ...optionalField(candidate.thinking, "thinking", name, path),
      ...(candidate.fallback === undefined
        ? {}
        : { fallback: fallbackNames(candidate.fallback, `Agent preset "${name}" fallback in "${path}"`, name) }),
    };
  }
  const shared = (loaded as { readonly fallback?: unknown }).fallback;
  return {
    presets: bindings,
    ...(shared === undefined ? {} : { fallback: fallbackNames(shared, `Agent bindings "${path}" fallback export`) }),
  };
}

function fallbackNames(value: unknown, subject: string, self?: string): readonly string[] {
  if (!Array.isArray(value)) throw new Error(`${subject} must be an array of preset names`);
  const names: string[] = [];
  for (const name of value as readonly unknown[]) {
    if (typeof name !== "string" || name.trim() === "" || name !== name.trim() || /\r|\n|\t/u.test(name)) {
      throw new Error(`${subject} must contain only non-empty, trimmed, one-line preset names`);
    }
    if (names.includes(name)) throw new Error(`${subject} names "${name}" more than once`);
    if (name === self) throw new Error(`${subject} must not name the preset itself`);
    names.push(name);
  }
  return names;
}

function optionalField(
  value: unknown,
  field: "harness" | "model" | "thinking",
  name: string,
  path: string,
): Partial<AgentPreset> {
  return value === undefined
    ? {}
    : { [field]: oneLine(value, field, name, path) };
}

function oneLine(
  value: unknown,
  field: string,
  name: string,
  path: string,
): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Agent preset "${name}" in "${path}" must have a non-empty ${field}`);
  }
  const normalized = value.trim();
  if (/\r|\n|\t/u.test(normalized)) {
    throw new Error(`Agent preset "${name}" ${field} in "${path}" must fit in one line`);
  }
  return normalized;
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return false;
    throw cause;
  }
}
