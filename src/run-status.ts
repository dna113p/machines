import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { StateValue } from "xstate";

/** One published run, stored as `<MACHINES_RUN_STATUS_DIR>/<id>.json`. */
export interface RunStatusRecord {
  /** Version 1 records carry only `human.prompt`. */
  readonly schemaVersion: 1 | 2;
  readonly id: string;
  readonly pid: number;
  readonly owner?: string;
  /** The enclosing run when this one was started from inside another Machine. */
  readonly parent?: string;
  /** What this run is for, as its launcher chose to describe it. */
  readonly label?: string;
  readonly machine: string;
  readonly path: string;
  readonly cwd: string;
  readonly status: "running" | "waiting" | "completed" | "failed";
  readonly state?: string;
  /** When the current state was entered. */
  readonly stateSince?: string;
  readonly agent?: RunStatusAgent;
  readonly human?: RunStatusHuman;
  /** Names the inbox responses the run took lately, so that each sender can tell; never a response. */
  readonly deliveries?: readonly string[];
  readonly error?: string;
  readonly startedAt: string;
  readonly updatedAt: string;
}

/** The pending Human request: what a surface needs to show it and to answer it. */
export interface RunStatusHuman {
  readonly prompt: string;
  /** Names this request to `machine respond`; absent when the run takes no outside response. */
  readonly requestId?: string;
  readonly choices?: readonly string[];
  readonly suggestions?: readonly string[];
  readonly discussion?: boolean;
}

export interface RunStatusAgent {
  readonly harness: string;
  readonly model?: string;
  readonly thinking?: string;
}

export interface RunStatusRun {
  readonly id?: string;
  readonly machine: string;
  readonly path: string;
  readonly cwd: string;
  readonly startedAt?: string;
}

/** A present key replaces its field; a present key holding `undefined` clears it. */
export interface RunStatusChange {
  readonly status?: "running" | "waiting";
  readonly state?: StateValue;
  readonly agent?: RunStatusAgent;
  readonly human?: RunStatusHuman;
  /** Names an inbox response the run took, in addition to those its record already names. */
  readonly delivery?: string;
}

export type RunStatusOutcome =
  | { readonly state?: StateValue }
  | { readonly error: string };

export interface RunStatusPublisher {
  update(change: RunStatusChange): void;
  finish(outcome: RunStatusOutcome): void;
}

const staleAfterMilliseconds = 60 * 60 * 1_000;
/** How long a record goes on naming a response its run took: longer than a sender waits to hear of it. */
export const deliveryRetentionMilliseconds = 60_000;
const disabled: RunStatusPublisher = { update() {}, finish() {} };
let temporaryFiles = 0;

/** The directory runs publish to, or undefined while publication is off. */
export function runStatusDirectory(environment: NodeJS.ProcessEnv = process.env): string | undefined {
  const configured = environment.MACHINES_RUN_STATUS_DIR;
  return configured === undefined || configured === "" ? undefined : resolve(configured);
}

/** The one pending outside response for a run, kept beside its record. */
export function runInboxPath(directory: string, id: string): string {
  return join(directory, `${id}.inbox`);
}

/**
 * A second name for a response in a run's inbox, which its sender keeps. Only
 * the sender and the run remove it, and whichever does owns the response.
 */
export function runDeliveryPath(directory: string, id: string, delivery: string): string {
  return join(directory, `.${id}.${delivery}.inbox.sent`);
}

/**
 * Publishes one run for hosts that can only read files, such as a status line.
 * Opt-in through MACHINES_RUN_STATUS_DIR. Publication is presentation: it never
 * throws, and it records neither Machine input nor output.
 */
export function createRunStatusPublisher(
  run: RunStatusRun,
  environment: NodeJS.ProcessEnv = process.env,
): RunStatusPublisher {
  const directory = runStatusDirectory(environment);
  const id = run.id ?? randomUUID();
  if (directory === undefined || !isFileSafeId(id)) return disabled;

  const owner = environment.MACHINES_RUN_OWNER || environment.CLAUDE_CODE_SESSION_ID || undefined;
  const parent = environment.MACHINES_RUN_PARENT || undefined;
  const label = formatLabel(environment.MACHINES_RUN_LABEL);
  const startedAt = run.startedAt ?? new Date().toISOString();
  let status: RunStatusRecord["status"] = "running";
  let state: string | undefined;
  let stateSince: string | undefined;
  let agent: RunStatusAgent | undefined;
  let human: RunStatusHuman | undefined;
  let deliveries: ReadonlyArray<{ readonly id: string; readonly takenAt: number }> = [];
  let error: string | undefined;

  const publish = () => {
    const record: RunStatusRecord = {
      schemaVersion: 2,
      id,
      pid: process.pid,
      ...(owner === undefined ? {} : { owner }),
      ...(parent === undefined ? {} : { parent }),
      ...(label === undefined ? {} : { label }),
      machine: run.machine,
      path: run.path,
      cwd: run.cwd,
      status,
      ...(state === undefined ? {} : { state }),
      ...(stateSince === undefined ? {} : { stateSince }),
      ...(agent === undefined ? {} : { agent }),
      ...(human === undefined ? {} : { human }),
      ...(deliveries.length === 0 ? {} : { deliveries: deliveries.map((delivery) => delivery.id) }),
      ...(error === undefined ? {} : { error }),
      startedAt,
      updatedAt: new Date().toISOString(),
    };
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      // Readers only ever see a whole record: write beside it, then rename over it.
      const temporary = join(directory, `.${id}.${process.pid}.${temporaryFiles += 1}.tmp`);
      try {
        writeFileSync(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600 });
        renameSync(temporary, join(directory, `${id}.json`));
      } catch (cause) {
        rmSync(temporary, { force: true });
        throw cause;
      }
    } catch {
      // A status line is never worth a run: an unwritable directory is ignored.
    }
  };

  try {
    pruneRunStatuses(directory);
  } catch {
    // Pruning is best effort for the same reason.
  }
  publish();

  return {
    update(change) {
      if (status === "completed" || status === "failed") return;
      const next = {
        status: change.status ?? status,
        state: "state" in change ? formatState(change.state) : state,
        agent: "agent" in change ? pickAgent(change.agent) : agent,
        human: "human" in change ? pickHuman(change.human) : human,
        // A later response must not hide an earlier one from a sender that has yet to look.
        deliveries: change.delivery === undefined ? deliveries : [
          ...deliveries.filter((delivery) => Date.now() - delivery.takenAt < deliveryRetentionMilliseconds),
          { id: change.delivery, takenAt: Date.now() },
        ],
      };
      // Repeated notifications for an unchanged run do not need another write.
      if (JSON.stringify(next) === JSON.stringify({ status, state, agent, human, deliveries })) return;
      if (next.state !== state) stateSince = new Date().toISOString();
      ({ status, state, agent, human, deliveries } = next);
      publish();
    },
    finish(outcome) {
      if (status === "completed" || status === "failed") return;
      if ("error" in outcome) {
        status = "failed";
        error = outcome.error;
      } else {
        status = "completed";
        state = formatState(outcome.state) ?? state;
      }
      stateSince = undefined;
      agent = undefined;
      human = undefined;
      publish();
      try {
        // Nothing reads the inbox from here on, and only the run empties it.
        rmSync(runInboxPath(directory, id), { force: true });
      } catch {
        // Left for pruning.
      }
    },
  };
}

/** Returns the valid records in a directory. Unreadable or malformed files are skipped. */
export function readRunStatuses(directory: string): RunStatusRecord[] {
  return readRecordFiles(directory).map(({ record }) => record);
}

function pruneRunStatuses(directory: string): void {
  const now = Date.now();
  for (const { file, record } of readRecordFiles(directory)) {
    const settled = record.status === "completed" || record.status === "failed" || !isProcessAlive(record.pid);
    if (!settled || now - Date.parse(record.updatedAt) <= staleAfterMilliseconds) continue;
    try {
      rmSync(file, { force: true });
      // A response nobody collected goes with the run it was meant for, under each of its names.
      const id = basename(file, ".json");
      rmSync(runInboxPath(directory, id), { force: true });
      for (const name of readdirSync(directory)) {
        if (!name.startsWith(`.${id}.`)) continue;
        if (/^[^.]+\.inbox\.(?:sent|taken)$/u.test(name.slice(id.length + 2))) rmSync(join(directory, name), { force: true });
      }
    } catch {
      // Another publisher may have pruned it first.
    }
  }
}

function readRecordFiles(directory: string): Array<{ file: string; record: RunStatusRecord }> {
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch {
    return [];
  }
  const found: Array<{ file: string; record: RunStatusRecord }> = [];
  for (const name of names) {
    if (name.startsWith(".") || !name.endsWith(".json")) continue;
    const file = join(directory, name);
    try {
      const record: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (isRunStatusRecord(record)) found.push({ file, record });
    } catch {
      // Not a record, or replaced while it was being read.
    }
  }
  return found;
}

function isRunStatusRecord(value: unknown): value is RunStatusRecord {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  const agent = record.agent as Record<string, unknown> | null | undefined;
  const human = record.human as Record<string, unknown> | null | undefined;
  return (record.schemaVersion === 1 || record.schemaVersion === 2)
    && typeof record.id === "string" && record.id !== ""
    && Number.isSafeInteger(record.pid) && (record.pid as number) > 0
    && isOptionalString(record.owner)
    && isOptionalString(record.parent)
    && isOptionalString(record.label)
    && (record.stateSince === undefined || isTimestamp(record.stateSince))
    && typeof record.machine === "string"
    && typeof record.path === "string"
    && typeof record.cwd === "string"
    && (record.status === "running" || record.status === "waiting"
      || record.status === "completed" || record.status === "failed")
    && isOptionalString(record.state)
    && (agent === undefined || (agent !== null && typeof agent === "object" && typeof agent.harness === "string"
      && isOptionalString(agent.model) && isOptionalString(agent.thinking)))
    && (human === undefined || (human !== null && typeof human === "object" && typeof human.prompt === "string"
      && isOptionalString(human.requestId) && isOptionalStrings(human.choices) && isOptionalStrings(human.suggestions)
      && (human.discussion === undefined || typeof human.discussion === "boolean")))
    && isOptionalStrings(record.deliveries)
    && isOptionalString(record.error)
    && isTimestamp(record.startedAt)
    && isTimestamp(record.updatedAt);
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isOptionalStrings(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.every((item) => typeof item === "string"));
}

function isTimestamp(value: unknown): boolean {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

/** The id becomes a file name, so it must not be able to leave the directory. */
export function isFileSafeId(id: string): boolean {
  return /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/u.test(id);
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    // EPERM means the process exists but belongs to someone else.
    return (cause as NodeJS.ErrnoException).code === "EPERM";
  }
}

function formatState(state: StateValue | undefined): string | undefined {
  if (state === undefined) return undefined;
  return typeof state === "string" ? state : JSON.stringify(state);
}

/** One short line: a label is a caption, not a place for task text. */
function formatLabel(label: string | undefined): string | undefined {
  const line = label?.split(/\r?\n/u).map((part) => part.trim()).find((part) => part !== "");
  return line === undefined ? undefined : line.slice(0, 160);
}

function pickAgent(agent: RunStatusAgent | undefined): RunStatusAgent | undefined {
  if (agent === undefined) return undefined;
  return {
    harness: agent.harness,
    ...(agent.model === undefined ? {} : { model: agent.model }),
    ...(agent.thinking === undefined ? {} : { thinking: agent.thinking }),
  };
}

function pickHuman(human: RunStatusHuman | undefined): RunStatusHuman | undefined {
  if (human === undefined) return undefined;
  return {
    prompt: human.prompt,
    ...(human.requestId === undefined ? {} : { requestId: human.requestId }),
    ...(human.choices === undefined ? {} : { choices: [...human.choices] }),
    ...(human.suggestions === undefined ? {} : { suggestions: [...human.suggestions] }),
    ...(human.discussion === true ? { discussion: true } : {}),
  };
}
