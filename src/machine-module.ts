import { pathToFileURL } from "node:url";

/** Static dependencies let prepare inspect composition without running factories. */
export function readUses(loaded: Record<string, unknown>, machinePath: string): readonly string[] {
  const { uses } = loaded;
  if (uses === undefined) return [];
  if (!Array.isArray(uses) || uses.some((selector) =>
    typeof selector !== "string" || selector.trim() === "" || selector !== selector.trim())) {
    throw new Error(`Machine "${machinePath}" uses must be an array of non-empty trimmed selectors`);
  }
  if (new Set(uses).size !== uses.length) {
    throw new Error(`Machine "${machinePath}" uses must contain unique selectors`);
  }
  return uses;
}

export async function loadMachineModule(machinePath: string): Promise<Record<string, unknown>> {
  try {
    return await import(pathToFileURL(machinePath).href) as Record<string, unknown>;
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`Could not load Machine "${machinePath}": ${message}`, { cause });
  }
}

export function requireMachineDescription(loaded: Record<string, unknown>, machinePath: string): string {
  const { description } = loaded;
  if (description === undefined) {
    throw new Error(`Machine "${machinePath}" must export a description`);
  }
  if (typeof description !== "string" || description.trim() === "") {
    throw new Error(`Machine "${machinePath}" description must be a non-empty string`);
  }

  const value = description.trim();
  if (/\r|\n|\t/u.test(value)) {
    throw new Error(`Machine "${machinePath}" description must fit in one tab-safe line`);
  }
  return value;
}

export function readAgentRoles(
  loaded: Record<string, unknown>,
  machinePath: string,
): Readonly<Record<string, string>> {
  const { agentRoles } = loaded;
  if (agentRoles === undefined) return {};
  if (agentRoles === null || typeof agentRoles !== "object" || Array.isArray(agentRoles)) {
    throw new Error(`Machine "${machinePath}" agentRoles must be an object`);
  }

  const roles: Record<string, string> = {};
  for (const [name, declaration] of Object.entries(agentRoles)) {
    let description: unknown = declaration;
    if (typeof declaration !== "string") {
      if (!declaration || typeof declaration !== "object" || Array.isArray(declaration)
        || declaration.optional !== true) {
        throw new Error(`Agent role "${name}" in "${machinePath}" must have a description and optional: true`);
      }
      description = declaration.description;
    }
    if (name.trim() === "" || name !== name.trim()) {
      throw new Error(`Machine "${machinePath}" contains a non-trimmed or empty Agent role name`);
    }
    if (typeof description !== "string" || description.trim() === "") {
      throw new Error(`Agent role "${name}" in "${machinePath}" must have a description`);
    }
    const value = description.trim();
    if (/\r|\n|\t/u.test(value)) {
      throw new Error(`Agent role "${name}" in "${machinePath}" must fit in one line`);
    }
    roles[name] = value;
  }
  return roles;
}

/** Metadata-only readers use the same validated optional declaration as launch. */
export function readOptionalAgentRoles(loaded: Record<string, unknown>, machinePath: string): readonly string[] {
  readAgentRoles(loaded, machinePath);
  return Object.entries(loaded.agentRoles ?? {}).filter(([, value]) => typeof value !== "string")
    .map(([name]) => name).sort();
}
