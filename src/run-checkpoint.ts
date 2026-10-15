import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StateValue } from "xstate";

import type { StateEntry } from "./index.ts";
import { jsonProblem, type JsonValue } from "./json.ts";
import { statePaths } from "./run-graph.ts";
import { isFileSafeId, isProcessAlive, readRunStatuses, runStatusDirectory, cleanDeadClaim, type RunStatusRecord } from "./run-status.ts";

export interface RunCheckpoint {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly machine: { readonly name: string; readonly path: string; readonly sourceHash: string };
  readonly input: JsonValue;
  readonly agents: Readonly<Record<string, string>>;
  readonly home: string;
  readonly cwd: string;
  readonly state: Omit<StateEntry, "context"> & { readonly path: string };
  readonly data: Record<string, JsonValue>;
  readonly context: JsonValue;
  readonly writtenAt: string;
}

export interface Continuation {
  readonly directory: string;
  readonly checkpoint: RunCheckpoint;
  readonly record: RunStatusRecord;
  readonly machineChanged: boolean;
  release(): void;
}

export function checkpointPath(directory: string, id: string): string {
  return join(directory, `${id}.checkpoint.json`);
}

export function machineSourceHash(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

let temporaryFiles = 0;

/** A failed write invalidates the stale checkpoint, rather than offering the wrong state. */
export function writeCheckpoint(directory: string, checkpoint: RunCheckpoint): void {
  const file = checkpointPath(directory, checkpoint.id);
  const temporary = join(directory, `.${checkpoint.id}.${process.pid}.${temporaryFiles += 1}.tmp`);
  try {
    const problem = jsonProblem(checkpoint, "checkpoint");
    if (problem) throw new Error(`Cannot save checkpoint: ${problem}`);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(temporary, `${JSON.stringify(checkpoint)}\n`, { mode: 0o600 });
    renameSync(temporary, file);
  } catch (cause) {
    rmSync(temporary, { force: true });
    rmSync(file, { force: true });
    throw cause;
  }
}

export function removeCheckpoint(directory: string, id: string): void {
  rmSync(checkpointPath(directory, id), { force: true });
}

/** Claim before importing the Machine or doing any of its work. Dead claim owners can be replaced. */
export function claimContinuation(id: string, directory = runStatusDirectory()): Continuation {
  if (directory === undefined) throw new Error("Cannot continue: run status publication is off");
  if (!isFileSafeId(id)) throw new Error(`Invalid run id "${id}"`);
  const claim = join(directory, `.${id}.claim`);
  const record = readRunStatuses(directory).find((candidate) => candidate.id === id);
  if (!record) throw new Error(`Cannot continue run "${id}": no status record`);
  const file = checkpointPath(directory, id);
  if (!existsSync(file)) throw new Error(`Cannot continue run "${id}": no checkpoint (the run may have reached a final state)`);
  if (record.status === "completed") throw new Error(`Cannot continue run "${id}": it completed`);
  if (record.status !== "failed" && isProcessAlive(record.pid)) {
    throw new Error(`Cannot continue run "${id}": its process ${record.pid} is still alive`);
  }
  const token = `${process.pid}.${randomUUID()}`;
  const temporary = join(directory, `.${id}.${token}.claim`);
  // Rename a populated directory into place: an existing nonempty claim cannot
  // be replaced. A stale cleaner removes only the dead owner's unique token,
  // then rmdir, which cannot remove a new owner's populated directory.
  cleanDeadClaim(claim);
  mkdirSync(temporary, { mode: 0o700 });
  try {
    writeFileSync(join(temporary, token), "", { mode: 0o600 });
    renameSync(temporary, claim);
  } catch {
    throw new Error(`Cannot continue run "${id}": another process has claimed it`);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    rmSync(join(claim, token), { force: true });
    try { rmdirSync(claim); } catch { /* Another owner already replaced the empty claim. */ }
  };
  try {
    const checkpoint = readCheckpoint(file, id);
    // A concurrent continuation may have published its pid before we acquired the claim.
    const current = readRunStatuses(directory).find((candidate) => candidate.id === id);
    if (!current || (current.status !== "failed" && isProcessAlive(current.pid))) {
      throw new Error(`Cannot continue run "${id}": its process is still alive`);
    }
    return { directory, checkpoint, record: current, machineChanged: machineSourceHash(checkpoint.machine.path) !== checkpoint.machine.sourceHash, release };
  } catch (cause) {
    release();
    throw cause;
  }
}

function readCheckpoint(file: string, id: string): RunCheckpoint {
  const saved: unknown = JSON.parse(readFileSync(file, "utf8"));
  const c = saved as Partial<RunCheckpoint> | null;
  if (!c || typeof c !== "object" || jsonProblem(c) !== undefined || c.schemaVersion !== 1 || c.id !== id || !c.machine || typeof c.machine !== "object"
    || typeof c.machine.name !== "string" || typeof c.machine.path !== "string" || typeof c.machine.sourceHash !== "string"
    || typeof c.cwd !== "string" || typeof c.home !== "string" || !c.state || typeof c.state !== "object" || !("value" in c.state)
    || typeof c.state.path !== "string" || typeof c.state.enteredAt !== "string" || !Number.isFinite(Date.parse(c.state.enteredAt))
    || !["agent", "operation", "human", "final", "state"].includes(c.state.kind)
    || typeof c.writtenAt !== "string" || !Number.isFinite(Date.parse(c.writtenAt))
    || !c.data || Array.isArray(c.data) || typeof c.data !== "object" || !("context" in c) || !("input" in c)
    || !c.agents || typeof c.agents !== "object" || Array.isArray(c.agents) || Object.values(c.agents).some((value) => typeof value !== "string")) {
    throw new Error(`Cannot continue run "${id}": invalid checkpoint`);
  }
  const paths = statePaths(c.state.value);
  if (paths.length !== 1) throw new Error(`Cannot continue run "${id}": parallel states (more than one active state path) are not supported`);
  return saved as RunCheckpoint;
}

/** Validate against the definition itself, including Machines too large for a status graph. */
export function assertSavedState(root: { readonly states: Record<string, unknown> }, value: StateValue): void {
  const paths = statePaths(value);
  if (paths.length !== 1) throw new Error("Cannot continue parallel states: more than one active state path");
  const visit = (node: typeof root, state: StateValue, path: string[]) => {
    for (const [key, child] of typeof state === "string" ? [[state, undefined]] : Object.entries(state)) {
      const next = node.states[key as string] as typeof root | undefined;
      if (!next) throw new Error(`Cannot continue: saved state "${[...path, key].join(".")}" is missing from the Machine`);
      if (child !== undefined) visit(next, child as StateValue, [...path, key as string]);
    }
  };
  visit(root, value, []);
}
