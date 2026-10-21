import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StateValue } from "xstate";

import type { StateEntry } from "./index.ts";
import { jsonProblem, type JsonValue } from "./json.ts";
import { statePaths } from "./run-graph.ts";
import { isFileSafeId, isProcessAlive, readRunStatuses, runStatusDirectory, cleanDeadClaim, type RunStatusHuman, type RunStatusRecord } from "./run-status.ts";

export interface ChildCheckpoint {
  readonly machine: { readonly name: string; readonly path: string; readonly sourceHash: string };
  readonly input: JsonValue;
  readonly state: Omit<StateEntry, "context" | "history"> & { readonly path: string };
  readonly data: Record<string, JsonValue>;
  readonly context: JsonValue;
  readonly children?: readonly [ChildCheckpoint];
  readonly history?: StateEntry["history"];
}

export interface RunCheckpoint extends ChildCheckpoint {
  readonly now?: string;
  readonly schemaVersion: 1 | 2;
  readonly id: string;
  readonly agents: Readonly<Record<string, string>>;
  readonly home: string;
  readonly cwd: string;
  readonly writtenAt: string;
  readonly sleep?: true;
}

/** An early continuation is read-only, including for callers other than the CLI. */
export class RunNotDueError extends Error {
  readonly due: string;
  constructor(due: string) {
    super(`Run is not due until ${due}.`);
    this.due = due;
  }
}

/** An unanswered continuation leaves the run's files unchanged. */
export class RunNotAnsweredError extends Error {
  readonly human: RunStatusHuman;
  constructor(human: RunStatusHuman) {
    super(`Run is waiting for an answer to: ${human.prompt}`);
    this.human = human;
  }
}

export interface Continuation {
  readonly directory: string;
  readonly checkpoint: RunCheckpoint;
  readonly record: RunStatusRecord;
  readonly machineChanged: boolean;
  readonly answer?: string;
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
export function claimContinuation(id: string, directory = runStatusDirectory(), now = Date.now()): Continuation {
  if (directory === undefined) throw new Error("Cannot continue: run status publication is off");
  if (!isFileSafeId(id)) throw new Error(`Invalid run id "${id}"`);
  const record = readRunStatuses(directory).find((candidate) => candidate.id === id);
  if (!record) throw new Error(`Cannot continue run "${id}": no status record`);
  const file = checkpointPath(directory, id);
  if (!existsSync(file)) throw new Error(`Cannot continue run "${id}": no checkpoint (the run may have reached a final state)`);
  if (record.status === "completed") throw new Error(`Cannot continue run "${id}": it completed`);
  if (record.status === "sleeping" && record.human && record.human.answer === undefined) {
    throw new RunNotAnsweredError(record.human);
  }
  if (record.status === "sleeping" && record.due && Date.parse(record.due) > now) {
    throw new RunNotDueError(record.due);
  }
  if (record.status !== "failed" && record.status !== "sleeping" && isProcessAlive(record.pid)) {
    throw new Error(`Cannot continue run "${id}": its process ${record.pid} is still alive`);
  }
  const release = claimRun(directory, id);
  try {
    const checkpoint = readCheckpoint(file, id);
    // A concurrent continuation may have published its pid before we acquired the claim.
    const current = readRunStatuses(directory).find((candidate) => candidate.id === id);
    if (!current || (current.status !== "failed" && current.status !== "sleeping" && isProcessAlive(current.pid))) {
      throw new Error(`Cannot continue run "${id}": its process is still alive`);
    }
    // A preceding continuation may have slept again before we took the claim.
    if (current.status === "sleeping" && current.human && current.human.answer === undefined) {
      throw new RunNotAnsweredError(current.human);
    }
    if (current.status === "sleeping" && current.due && Date.parse(current.due) > now) {
      throw new RunNotDueError(current.due);
    }
    return { directory, checkpoint, record: current,
      ...(current.status === "sleeping" && current.human?.answer !== undefined ? { answer: current.human.answer } : {}),
      machineChanged: sourceChanged(checkpoint), release };
  } catch (cause) {
    release();
    throw cause;
  }
}

/** Exclusive claim shared by continuation and answers recorded while sleeping. */
export function claimRun(directory: string, id: string): () => void {
  if (!isFileSafeId(id)) throw new Error(`Invalid run id "${id}"`);
  const claim = join(directory, `.${id}.claim`);
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
    throw new Error(`Cannot claim run "${id}": another process has claimed it`);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    rmSync(join(claim, token), { force: true });
    try { rmdirSync(claim); } catch { /* Another owner already replaced the empty claim. */ }
  };
}

function sourceChanged(level: ChildCheckpoint): boolean {
  return machineSourceHash(level.machine.path) !== level.machine.sourceHash
    || (level.children?.some(sourceChanged) ?? false);
}

function readCheckpoint(file: string, id: string): RunCheckpoint {
  const saved: unknown = JSON.parse(readFileSync(file, "utf8"));
  const c = saved as Partial<RunCheckpoint> | null;
  if (!c || typeof c !== "object" || jsonProblem(c) !== undefined || (c.schemaVersion !== 1 && c.schemaVersion !== 2) || c.id !== id
    || (c.now !== undefined && (typeof c.now !== "string" || /[\r\n\u0085\u2028\u2029]/u.test(c.now) || [...c.now].length > 200))
    || typeof c.cwd !== "string" || typeof c.home !== "string"
    || (c.sleep !== undefined && c.sleep !== true)
    || typeof c.writtenAt !== "string" || !Number.isFinite(Date.parse(c.writtenAt))
    || !c.agents || typeof c.agents !== "object" || Array.isArray(c.agents) || Object.values(c.agents).some((value) => typeof value !== "string")) {
    throw new Error(`Cannot continue run "${id}": invalid checkpoint`);
  }
  assertCheckpointLevel(c, id, c.schemaVersion === 2);
  return saved as RunCheckpoint;
}

function assertCheckpointLevel(c: Partial<ChildCheckpoint> | null, id: string, childrenAllowed: boolean, child = false): void {
  if (!c || typeof c !== "object" || !c.machine || typeof c.machine !== "object"
    || typeof c.machine.name !== "string" || typeof c.machine.path !== "string" || typeof c.machine.sourceHash !== "string"
    || !c.state || typeof c.state !== "object" || !("value" in c.state)
    || typeof c.state.path !== "string" || typeof c.state.enteredAt !== "string" || !Number.isFinite(Date.parse(c.state.enteredAt))
    || !["agent", "operation", "human", "wait", "final", "state"].includes(c.state.kind)
    || (c.state.due !== undefined && (typeof c.state.due !== "string" || !Number.isFinite(Date.parse(c.state.due))))
    || (c.state.retry !== undefined && (c.state.kind !== "operation" || c.state.due === undefined
      || c.state.retry === null || typeof c.state.retry !== "object" || Array.isArray(c.state.retry)
      || !Number.isInteger(c.state.retry.attempt) || !Number.isInteger(c.state.retry.of)
      || c.state.retry.attempt < 2 || c.state.retry.attempt > c.state.retry.of || c.state.retry.of > 11))
    || (c.state.kind === "wait" && c.state.due === undefined)
    || !c.data || Array.isArray(c.data) || typeof c.data !== "object" || !("context" in c) || !("input" in c)
    || (c.history !== undefined && (!c.history || typeof c.history !== "object"
      || !Array.isArray(c.history.trail) || c.history.trail.some((state) => typeof state !== "string")
      || !Array.isArray(c.history.summaries) || c.history.summaries.some((summary) =>
        !summary || typeof summary !== "object" || typeof summary.state !== "string"
        || typeof summary.role !== "string" || typeof summary.summary !== "string")))
    || (child && c.state.kind === "final")
    || (c.children !== undefined && (!childrenAllowed || !Array.isArray(c.children) || c.children.length !== 1 || c.state.kind !== "operation"))) {
    throw new Error(`Cannot continue run "${id}": invalid checkpoint`);
  }
  const paths = statePaths(c.state.value);
  if (paths.length !== 1) throw new Error(`Cannot continue run "${id}": parallel states (more than one active state path) are not supported`);
  for (const nested of c.children ?? []) assertCheckpointLevel(nested, id, childrenAllowed, true);
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
