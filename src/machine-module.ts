import { pathToFileURL } from "node:url";

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
  for (const [name, description] of Object.entries(agentRoles)) {
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
