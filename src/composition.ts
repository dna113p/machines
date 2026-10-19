import { realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import type { AnyStateMachine, AnyStateNode } from "xstate";

import { discoverMachines } from "./discovery.ts";
import { readEndings, type MachineEndings } from "./endings.ts";
import { loadMachineModule, readAgentRoles, readUses, requireMachineDescription } from "./machine-module.ts";

export interface UseModule {
  readonly path: string;
  readonly loaded: Record<string, unknown>;
  readonly endings: MachineEndings;
  readonly agentRoles: Readonly<Record<string, string>>;
  readonly children: ReadonlyMap<string, UseModule>;
}

const maxUseDepth = 3;

async function resolveUse(selector: string, fromPath: string, cwd: string, home: string): Promise<string> {
  if (isAbsolute(selector) || selector.includes("/") || selector.endsWith(".ts") || selector.endsWith(".js")) {
    return resolve(dirname(fromPath), selector);
  }
  const found = (await discoverMachines(cwd, home)).find((candidate) => candidate.name === selector);
  if (!found) throw new Error(`Machine "${selector}" not found. Run "machine list" to see available Machines.`);
  return found.path;
}

/** Only import metadata here: child factories require input from state entry. */
export async function loadUseTree(
  path: string,
  uses: readonly string[],
  location: { readonly cwd: string; readonly home: string },
  definition?: AnyStateMachine,
  chain: readonly string[] = [realpathSync(path)],
): Promise<ReadonlyMap<string, UseModule>> {
  const states = definition ? useStates(definition) : [];
  const children = new Map<string, UseModule>();
  for (const selector of uses) {
    const state = states.filter((entry) => entry.selector === selector).map((entry) => entry.path).join(", ");
    try {
      const childPath = await resolveUse(selector, path, location.cwd, location.home);
      const canonical = realpathSync(childPath);
      if (chain.includes(canonical)) {
        throw new Error(`Machine use cycle: ${[...chain, canonical].join(" → ")}`);
      }
      if (chain.length > maxUseDepth) {
        throw new Error(`Machine use nesting exceeds ${maxUseDepth} child levels: ${[...chain, canonical].join(" → ")}`);
      }
      const loaded = await loadMachineModule(childPath);
      requireMachineDescription(loaded, childPath);
      if (typeof loaded.default !== "function") throw new Error(`Machine "${childPath}" must default-export a factory`);
      const endings = readEndings(loaded, childPath);
      if (!endings) throw new Error(`Child Machine "${childPath}" must declare endings`);
      const agentRoles = readAgentRoles(loaded, childPath);
      const nested = await loadUseTree(childPath, readUses(loaded, childPath), location, undefined, [...chain, canonical]);
      children.set(selector, { path: childPath, loaded, endings, agentRoles, children: nested });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      throw new Error(`Machine "${path}"${state ? ` state "${state}"` : " uses"} child "${selector}": ${message}`, { cause });
    }
  }
  return children;
}

export function assertUseStates(definition: AnyStateMachine, path: string, children: ReadonlyMap<string, UseModule>): void {
  for (const entry of useStates(definition)) {
    const label = `Machine "${path}" state "${entry.path}" child "${entry.selector}"`;
    const child = children.get(entry.selector);
    if (!child) throw new Error(`${label} must be listed in the module's uses export`);
    const on = entry.node.config.on ?? {};
    const missing = Object.keys(child.endings).filter((name) => !Object.hasOwn(on, name) || on[name] === undefined);
    const extra = Object.keys(on).filter((name) => !Object.hasOwn(child.endings, name));
    if (missing.length || extra.length) {
      throw new Error(`${label} on must name exactly the child's endings (missing: ${missing.join(", ") || "none"}; extra: ${extra.join(", ") || "none"})`);
    }
  }
}

export function useStates(definition: AnyStateMachine): { path: string; selector: string; node: AnyStateNode; actorId: string }[] {
  const found: { path: string; selector: string; node: AnyStateNode; actorId: string }[] = [];
  const visit = (node: AnyStateNode, path: string) => {
    const metadata = node.meta?.["machines.use"] as { selector: string } | undefined;
    if (metadata) found.push({ path, selector: metadata.selector, node, actorId: node.invoke[0]!.id });
    for (const child of Object.values(node.states)) visit(child, path ? `${path}.${child.key}` : child.key);
  };
  visit(definition.root, "");
  return found;
}

export function usedModules(children: ReadonlyMap<string, UseModule>): UseModule[] {
  return [...children.values()].flatMap((child) => [child, ...usedModules(child.children)]);
}
