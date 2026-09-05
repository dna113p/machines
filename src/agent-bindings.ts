import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { AgentRunner } from "./index.ts";
import { machinesUserHome, nearestMachinesDirectory } from "./discovery.ts";

export interface AgentPreset {
  readonly description: string;
  readonly runner: AgentRunner;
  readonly harness?: string;
  readonly model?: string;
  readonly thinking?: string;
}

export interface LoadedAgentBindings {
  readonly agents: Readonly<Record<string, AgentRunner>>;
  readonly presets: Readonly<Record<string, AgentPreset>>;
  readonly sources: Readonly<Record<string, string>>;
}

export type AgentAdapters = Readonly<Record<string, unknown>>;

const presetFields = new Set(["description", "runner", "harness", "model", "thinking"]);

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

  for (const path of paths) {
    if (!await isFile(path)) continue;
    const bindings = await loadBindingFile(path, adapters);
    for (const [name, preset] of Object.entries(bindings)) {
      agents[name] = preset.runner;
      presets[name] = preset;
      sources[name] = path;
    }
  }

  return { agents, presets, sources };
}

async function loadBindingFile(
  path: string,
  adapters: AgentAdapters,
): Promise<Readonly<Record<string, AgentPreset>>> {
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
    bindings[name] = {
      description,
      runner: candidate.runner,
      ...optionalField(candidate.harness, "harness", name, path),
      ...optionalField(candidate.model, "model", name, path),
      ...optionalField(candidate.thinking, "thinking", name, path),
    };
  }
  return bindings;
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
