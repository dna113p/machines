import { readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { AgentPreset } from "./agent-bindings.ts";
import { configureAgentTuning, freezeJson, validModel, type AgentTuning } from "./agent-tuning.ts";
import { machinesStateDirectory, machinesUserHome, nearestMachinesDirectory } from "./discovery.ts";
import { jsonProblem } from "./json.ts";
import { effectiveProviderOrder, providerOrderUntil } from "./provider-order.ts";
import { writeStateJson } from "./state-json.ts";

export interface ProfileOverride extends AgentTuning {
  /** Exact preset harness/provider identity; no implicit provider aliases. */
  readonly provider?: string;
  readonly preset?: string;
  /** Require the adapter's effective model to equal this model before allowing these options. */
  readonly forModel?: string;
}

export interface AgentProfile {
  readonly order?: readonly string[];
  /** Independent strict filter. An empty list permits no provider. */
  readonly allowedProviders?: readonly string[];
  /** At most one matching override per preset, to avoid ambiguous merges. */
  readonly overrides?: readonly ProfileOverride[];
}

export interface ActiveAgentProfile {
  readonly name: string;
  readonly until: string;
  /** Snapshot: editing a reusable definition does not change an activation. */
  readonly profile: AgentProfile;
}

function object(value: unknown, fields?: readonly string[]): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new Error("Expected a profile JSON object");
  }
  if (fields && Object.keys(value).some((key) => !fields.includes(key))) throw new Error(`Unknown profile field; expected: ${fields.join(", ")}`);
}

function name(value: unknown): asserts value is string {
  if (!validModel(value)) throw new Error("Profile names, providers, presets and models must be nonempty, trimmed, one-line strings");
}

function names(value: unknown): asserts value is string[] {
  if (!Array.isArray(value)) throw new Error("Profile order and allowedProviders must be arrays of names");
  for (const item of value) name(item);
  if (new Set(value).size !== value.length) throw new Error("Profile names must not be repeated within a list");
}

export function validateAgentProfile(value: unknown): AgentProfile {
  const problem = jsonProblem(value, "Profile");
  if (problem) throw new Error(problem);
  object(value, ["order", "allowedProviders", "overrides"]);
  if (value.order !== undefined) names(value.order);
  if (value.allowedProviders !== undefined) names(value.allowedProviders);
  if (value.overrides !== undefined) {
    if (!Array.isArray(value.overrides)) throw new Error("Profile overrides must be an array");
    for (const entry of value.overrides) {
      object(entry, ["provider", "preset", "model", "forModel", "options"]);
      if (entry.provider === undefined && entry.preset === undefined) throw new Error("Each profile override requires a provider or preset scope");
      for (const key of ["provider", "preset", "model", "forModel"]) if (entry[key] !== undefined) name(entry[key]);
      if (entry.options !== undefined) object(entry.options);
      if (entry.model === undefined && entry.options === undefined) throw new Error("A profile override requires model or options");
    }
  }
  return freezeJson(structuredClone(value)) as AgentProfile;
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    // A non-directory ancestor cannot contain an activation. Other read failures
    // must fail closed rather than silently dropping a potentially active filter.
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    // Do not echo malformed input, which may contain credentials.
    throw new Error(`Could not read profile JSON at ${path}`);
  }
}

/** Same global/nearest-project precedence as agents.ts, with whole-profile replacement by name. */
export async function readAgentProfiles(cwd = process.cwd(), home = machinesUserHome()): Promise<Readonly<Record<string, AgentProfile>>> {
  const globalPath = join(home, ".machines", "profiles.json");
  const directory = await nearestMachinesDirectory(cwd);
  const projectPath = directory === undefined ? globalPath : join(directory, "profiles.json");
  const profiles: Record<string, AgentProfile> = Object.create(null);
  for (const path of new Set([resolve(globalPath), resolve(projectPath)])) {
    const value = await readJson(path);
    if (value === undefined) continue;
    object(value);
    for (const [key, definition] of Object.entries(value)) {
      name(key);
      try { profiles[key] = validateAgentProfile(definition); }
      catch (cause) { throw new Error(`Invalid profile ${JSON.stringify(key)} in ${path}: ${(cause as Error).message}`); }
    }
  }
  return freezeJson(profiles);
}

export function activeAgentProfilePath(home = machinesUserHome()): string {
  return join(machinesStateDirectory(home), "agent-profile.json");
}

export async function readActiveAgentProfile(home = machinesUserHome()): Promise<ActiveAgentProfile | undefined> {
  const path = activeAgentProfilePath(home);
  const value = await readJson(path);
  if (value === undefined) return undefined;
  try {
    object(value, ["name", "until", "profile"]);
    name(value.name);
    if (typeof value.until !== "string" || !/^\d{4}-\d\d-\d\dT/u.test(value.until)
      || !Number.isFinite(Date.parse(value.until)) || new Date(value.until).toISOString() !== value.until) {
      throw new Error("Profile activation requires an ISO deadline");
    }
    return freezeJson({ name: value.name, until: value.until, profile: validateAgentProfile(value.profile) });
  } catch (cause) { throw new Error(`Invalid profile activation at ${path}: ${(cause as Error).message}`); }
}

export function agentProfileExpired(active: ActiveAgentProfile, now = Date.now()): boolean {
  return Date.parse(active.until) <= now;
}

/** Stores a reusable definition's snapshot, never executes or changes a provider's configuration. */
export async function activateAgentProfile(profileName: string, profile: AgentProfile, deadline: string, home = machinesUserHome()): Promise<void> {
  name(profileName);
  const until = providerOrderUntil(deadline);
  if (/^\d{4}-\d\d-\d\dT/u.test(deadline)) {
    const date = deadline.slice(0, 10);
    if (new Date(`${date}T00:00:00.000Z`).toISOString().slice(0, 10) !== date) {
      throw new Error("Profile deadline must contain a valid calendar date");
    }
  }
  if (Date.parse(until) <= Date.now()) throw new Error("Profile deadline must be in the future");
  await writeStateJson(activeAgentProfilePath(home), { name: profileName, until, profile: validateAgentProfile(profile) });
}

export async function clearAgentProfile(home = machinesUserHome()): Promise<void> {
  await rm(activeAgentProfilePath(home), { force: true });
}

export function profilePermits(profile: AgentProfile | undefined, preset: Pick<AgentPreset, "harness">): boolean {
  return profile?.allowedProviders === undefined || (preset.harness !== undefined && profile.allowedProviders.includes(preset.harness));
}

/** Adapter configuration is performed once per preset, never on a fallback request. */
export function applyAgentProfile(profile: AgentProfile, presets: Readonly<Record<string, AgentPreset>>): Readonly<Record<string, AgentPreset>> {
  const result = { ...presets };
  const matched = new Set<ProfileOverride>();
  for (const [presetName, preset] of Object.entries(presets)) {
    const overrides = profile.overrides?.filter((entry) =>
      (entry.provider === undefined || entry.provider === preset.harness)
      && (entry.preset === undefined || entry.preset === presetName)) ?? [];
    if (overrides.length > 1) throw new Error(`Profile has overlapping overrides for preset ${JSON.stringify(presetName)}; use one scope`);
    const override = overrides[0];
    if (override === undefined) continue;
    matched.add(override);
    try {
      const configured = configureAgentTuning(preset.runner, {
        ...(override.model === undefined ? {} : { model: override.model }),
        ...(override.options === undefined ? {} : { options: override.options }),
      });
      if (override.forModel !== undefined && configured.model !== override.forModel) {
        throw new Error("Profile forModel restriction does not match the adapter's effective model; specify a matching model");
      }
      const { model: _model, thinking: _thinking, ...base } = preset;
      result[presetName] = { ...base, ...configured };
    } catch (cause) {
      throw new Error(`Profile cannot configure preset ${JSON.stringify(presetName)}: ${(cause as Error).message}`);
    }
  }
  if (profile.overrides?.some((entry) => !matched.has(entry))) throw new Error("Profile override scope matches no configured preset; inspect machine agents");
  return result;
}

export async function resolveAgentProfile(home: string, presets: Readonly<Record<string, AgentPreset>>, readOrder = true) {
  const saved = await readActiveAgentProfile(home);
  const active = saved === undefined || agentProfileExpired(saved) ? undefined : saved;
  const configured = active === undefined ? presets : applyAgentProfile(active.profile, presets);
  // Environment overrides only order. Even an empty value never releases the strict filter or tuning.
  // Disabled fallback also disables legacy --above quota hooks during preparation.
  const order = !readOrder || process.env.MACHINES_AGENT_FALLBACK === "off" ? []
    : process.env.MACHINES_AGENT_PREFER !== undefined || active?.profile.order === undefined
      ? await effectiveProviderOrder(home, presets) : active.profile.order;
  return { active, presets: configured, order };
}
