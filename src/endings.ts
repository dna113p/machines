import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import type { AnyStateMachine, AnyStateNode, SnapshotFrom } from "xstate";

// Shared by source, installed, and emitted copies of the package.
const endingBrand = Symbol.for("machines.ending");

export type EndingKind = "succeeded" | "failed" | "cancelled";

/** The declared ending a run reached. */
export interface RunEnding {
  readonly name: string;
  readonly kind: EndingKind;
}

export interface MachineEnding {
  readonly name: string;
  readonly kind: EndingKind;
  readonly output?: TSchema;
  readonly [endingBrand]: true;
}

export type MachineEndings = Readonly<Record<string, MachineEnding>>;

type EndingSpec = { readonly kind: EndingKind; readonly output?: TSchema };

/** Declare the named endings that a Machine's top-level final states use. */
export function defineEndings<const T extends Record<string, EndingSpec>>(
  spec: T,
): { readonly [K in keyof T]: MachineEnding & T[K] & { readonly name: K } } {
  if (!isObject(spec)) throw new Error("Machine endings must be an object");
  const entries = Object.entries(spec).map(([name, ending]) => {
    if (!isName(name)) throw new Error(`Invalid ending name ${JSON.stringify(name)}: expected a trimmed, non-empty identifier`);
    if (!isObject(ending) || !isKind(ending.kind)) {
      throw new Error(`Ending "${name}" must have kind succeeded, failed or cancelled`);
    }
    if (ending.output !== undefined && !isObject(ending.output)) {
      throw new Error(`Ending "${name}" output must be a schema object`);
    }
    return [name, Object.freeze({
      name,
      kind: ending.kind,
      ...(ending.output === undefined ? {} : { output: ending.output }),
      [endingBrand]: true as const,
    })];
  });
  return Object.freeze(Object.fromEntries(entries));
}

export function isMachineEnding(value: unknown): value is MachineEnding {
  return isObject(value) && endingBrand in value && value[endingBrand] === true
    && typeof value.name === "string" && isName(value.name) && isKind(value.kind)
    && (value.output === undefined || isObject(value.output));
}

export function readEndings(loaded: Record<string, unknown>, path: string): MachineEndings | undefined {
  if (!Object.hasOwn(loaded, "endings")) return undefined;
  const { endings } = loaded;
  if (!isObject(endings)) throw new Error(`Machine "${path}" endings must be an object from defineEndings`);
  for (const [name, ending] of Object.entries(endings)) {
    if (!isMachineEnding(ending) || ending.name !== name) {
      throw new Error(`Machine "${path}" ending "${name}" must be declared with that name by defineEndings`);
    }
  }
  return endings as MachineEndings;
}

export function assertEndingStates(definition: AnyStateMachine, endings: MachineEndings | undefined, path: string): void {
  const used = new Set<string>();
  const visit = (node: AnyStateNode, statePath: string, topLevel: boolean) => {
    if (node.type === "final") {
      const ending = node.meta?.["machines.ending"];
      if (!topLevel && ending !== undefined) {
        throw new Error(`Machine "${path}" nested final state "${statePath}" cannot take an ending`);
      }
      if (topLevel && endings !== undefined) {
        if (!Object.hasOwn(endings, node.key)) {
          throw new Error(`Machine "${path}" final state "${statePath}" has no declared ending`);
        }
        if (ending !== node.key) {
          throw new Error(`Machine "${path}" final state "${statePath}" must take its own ending "${node.key}"`);
        }
        used.add(node.key);
      } else if (ending !== undefined) {
        throw new Error(`Machine "${path}" final state "${statePath}" takes an ending but the module exports no endings`);
      }
    }
    for (const child of Object.values(node.states)) visit(child, `${statePath}.${child.key}`, false);
  };
  for (const node of Object.values(definition.root.states)) visit(node, node.key, true);
  for (const name of Object.keys(endings ?? {})) {
    if (!used.has(name)) throw new Error(`Machine "${path}" ending "${name}" has no top-level final state`);
  }
}

export function assertEndingOutput(snapshot: SnapshotFrom<AnyStateMachine>, endings: MachineEndings | undefined): void {
  if (snapshot.status !== "done" || typeof snapshot.value !== "string" || !endings
    || !Object.hasOwn(endings, snapshot.value)) return;
  const ending = endings[snapshot.value];
  if (ending?.output === undefined) return;
  const problem = Value.Errors(ending.output, snapshot.output)[0];
  if (problem) {
    throw new Error(`Machine output does not match ending "${ending.name}": ${problem.instancePath || "/"} ${problem.message}`);
  }
}

export function runEnding(endings: MachineEndings | undefined, value: unknown): RunEnding | undefined {
  if (typeof value !== "string" || !endings || !Object.hasOwn(endings, value)) return undefined;
  const ending = endings[value];
  return ending === undefined ? undefined : { name: ending.name, kind: ending.kind };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isName(name: string): boolean {
  return /^[A-Za-z_$][\w$]*$/u.test(name);
}

function isKind(kind: unknown): kind is EndingKind {
  return kind === "succeeded" || kind === "failed" || kind === "cancelled";
}
