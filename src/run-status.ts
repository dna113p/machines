import { formatNote, runNoteProblem } from "./run-note.ts";
import { copyHumanRequest, type HumanPresentation } from "./human-request.ts";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import type { StateValue } from "xstate";

import { machinesUserHome } from "./discovery.ts";
import type { RunEnding } from "./endings.ts";
import type { AgentUpdate, StateEntry } from "./index.ts";
import { statePaths, type RunGraph, type RunTrailStep } from "./run-graph.ts";

/** One published run, stored as `<id>.json` in the run-status directory. */
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
  readonly status: "running" | "waiting" | "sleeping" | "completed" | "failed";
  /** When a sleeping timed wait is due, in ISO format. */
  readonly due?: string;
  readonly state?: string;
  /** The workflow’s current sentence, at most 200 characters on one line. */
  readonly now?: string;
  /** When the current state was entered. */
  readonly stateSince?: string;
  readonly agent?: RunStatusAgent;
  /** Present while the current Agent state waits for a usage limit to reset; `status` stays `running`. */
  readonly limit?: RunStatusLimit;
  /** Latest further Agent attempt in this state. */
  readonly attempt?: RunStatusAttempt;
  readonly retry?: RunStatusRetry;
  readonly human?: RunStatusHuman;
  /**
   * `host` when the program hosting the run answers its Human requests itself:
   * the run has no inbox, and `machine respond` refuses it. Absent otherwise.
   */
  readonly answeredBy?: "host";
  /** Sleeping runs with this marker are woken by their host, not `machine continue --due`. */
  readonly continuedBy?: "host";
  /** Names the inbox responses the run took lately, so that each sender can tell; never a response. */
  readonly deliveries?: readonly string[];
  readonly error?: string;
  /** The authored note or final output summary, at most 2000 characters. */
  readonly note?: string;
  /** An isolated HTML body fragment attached to this note. */
  readonly page?: string;
  /** The declared ending reached by a completed run. */
  readonly ending?: RunEnding;
  /** The Machine's states and transitions, when it is small enough to draw. */
  readonly graph?: RunGraph;
  /** The states the run entered, oldest first: the latest `trailLimit` of them. */
  readonly trail?: readonly RunTrailStep[];
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly continued?: { readonly at: string; readonly machineChanged: boolean };
}

/** The pending Human request: what a surface needs to show it and to answer it. */
export interface RunStatusHuman extends HumanPresentation {
  readonly prompt: string;
  /** Names this request to `machine respond`; absent when the run takes no outside response. */
  readonly requestId?: string;
  readonly choices?: readonly string[];
  readonly suggestions?: readonly string[];
  readonly discussion?: boolean;
  /** Plain answer recorded while sleeping; consumed on continuation. */
  readonly answer?: string;
}

export interface RunStatusAgent {
  readonly harness: string;
  readonly model?: string;
  readonly thinking?: string;
}

export type RunStatusAttempt = Pick<Extract<AgentUpdate, { type: "attempt" }>, "role" | "text">;

/** The next Operation attempt and the deadline before it starts. */
export interface RunStatusRetry {
  readonly attempt: number;
  readonly of: number;
  readonly due: string;
}

/** A wait for an Agent usage limit: a one-line summary, and when the wait is expected to end. */
export interface RunStatusLimit {
  readonly text: string;
  readonly until?: string;
}

export interface RunStatusRun {
  readonly continueRun?: { readonly record: RunStatusRecord; readonly machineChanged: boolean };
  readonly id?: string;
  readonly machine: string;
  readonly path: string;
  readonly cwd: string;
  readonly startedAt?: string;
  /** Replaces the owner the environment names; an empty one publishes the run unowned. */
  readonly owner?: string;
  /** Replaces `MACHINES_RUN_LABEL`, and is shortened as it is. */
  readonly label?: string;
  readonly answeredBy?: "host";
  readonly continuedBy?: "host";
  readonly graph?: RunGraph;
}

/** A present key replaces its field; a present key holding `undefined` clears it. */
export interface RunStatusChange {
  /** Replaces the note and its page together; omitting page removes it. */
  readonly note?: string;
  readonly page?: string;
  readonly now?: string;
  readonly graph?: RunGraph;
  readonly status?: "running" | "waiting";
  readonly state?: StateValue;
  readonly agent?: RunStatusAgent;
  /** Leaving the state clears it as well. */
  readonly limit?: RunStatusLimit;
  /** Latest further Agent attempt in this state. */
  readonly attempt?: RunStatusAttempt;
  readonly retry?: RunStatusRetry;
  readonly human?: RunStatusHuman;
  /** Names an inbox response the run took, in addition to those its record already names. */
  readonly delivery?: string;
}

export type RunStatusOutcome =
  | { readonly state?: StateValue; readonly note?: string; readonly ending?: RunEnding }
  | { readonly error: string };

export interface RunStatusPublisher {
  /**
   * Where the run is published. Undefined when it is not: publication is off,
   * or the directory could not take the run's first record.
   */
  readonly directory: string | undefined;
  update(change: RunStatusChange): void;
  sleep(due: string): void;
  sleepForAnswer(request: RunStatusHuman & { readonly requestId: string }): void;
  finish(outcome: RunStatusOutcome): void;
}

const staleAfterMilliseconds = 60 * 60 * 1_000;
/** How many entered states a record keeps: enough for a long run's repairs, small enough to rewrite at every step. */
export const trailLimit = 200;
/** How long a record goes on naming a response its run took: longer than a sender waits to hear of it. */
export const deliveryRetentionMilliseconds = 60_000;
/** How long a session's watch list is kept after its last change: sessions end without saying so. */
export const watchRetentionMilliseconds = 30 * 24 * 60 * 60 * 1_000;
/** The name of a session's watch list, which `src/run-watch.ts` keeps beside the records. */
export const watchListName = /^\.watch\..+\.json$/u;
// A record being written, and the second names of a response: each lasts moments unless its process was stopped.
const leftoverName = /^\.[A-Za-z0-9._-]+\.(?:\d+\.\d+\.tmp|[A-Za-z0-9_-]+\.inbox\.(?:sent|taken))$/u;
// A run's inbox, which goes with its record: one without a record belongs to a run that was pruned.
const inboxName = /^[A-Za-z0-9_-][A-Za-z0-9._-]*\.inbox$/u;
const disabled: RunStatusPublisher = { directory: undefined, update() {}, sleep() {}, sleepForAnswer() {}, finish() {} };
let temporaryFiles = 0;

/**
 * The directory runs publish to, or undefined while publication is off.
 * `MACHINES_RUN_STATUS_DIR` moves it, and turns publication off when it is
 * `off` or empty. Unset, it is the user's own state directory, so every
 * process of one user agrees on it without being told.
 *
 * `claude/statusline.mjs` cannot load this module and carries a copy of the
 * rule; tests/run-status.test.ts keeps the two in step.
 */
export function runStatusDirectory(environment: NodeJS.ProcessEnv = process.env): string | undefined {
  const configured = environment.MACHINES_RUN_STATUS_DIR;
  if (configured === "" || configured === "off") return undefined;
  if (configured !== undefined) return resolve(configured);
  // XDG_STATE_HOME describes the real home. A process given another Machines
  // home keeps its runs under that one, and out of the real one.
  const state = environment.XDG_STATE_HOME;
  if (environment.MACHINES_USER_HOME === undefined && state !== undefined && isAbsolute(state)) {
    return join(state, "machines", "runs");
  }
  try {
    const home = machinesUserHome(environment);
    return isAbsolute(home) ? join(home, ".local", "state", "machines", "runs") : undefined;
  } catch {
    // Without a usable home there is nowhere standard to publish.
    return undefined;
  }
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
 * Publishes one run for hosts that can only read files, such as a status line,
 * in `runStatusDirectory`. Invalid note/page updates throw; publication failures
 * do not. Records contain no Machine input and only the supplied output summary
 * or authored note/page.
 * A run whose first record cannot be written, as in a read-only home, is not
 * published at all.
 */
export function createRunStatusPublisher(
  run: RunStatusRun,
  environment: NodeJS.ProcessEnv = process.env,
): RunStatusPublisher {
  const directory = runStatusDirectory(environment);
  const id = run.id ?? randomUUID();
  if (directory === undefined || !isFileSafeId(id)) return disabled;

  const previous = run.continueRun?.record;
  const continuedBy = run.continuedBy ?? previous?.continuedBy;
  const continued = run.continueRun ? { at: new Date().toISOString(), machineChanged: run.continueRun.machineChanged } : undefined;
  const owner = previous ? previous.owner : (run.owner ?? runSessionId(environment)) || undefined;
  const parent = previous ? previous.parent : environment.MACHINES_RUN_PARENT || undefined;
  const label = previous ? previous.label : formatLabel(run.label ?? environment.MACHINES_RUN_LABEL);
  const startedAt = previous?.startedAt ?? run.startedAt ?? new Date().toISOString();
  let graph = run.graph;
  let status: RunStatusRecord["status"] = "running";
  let due: string | undefined;
  let state: string | undefined;
  let stateSince: string | undefined;
  let agent: RunStatusAgent | undefined;
  let limit: RunStatusLimit | undefined;
  let attempt: RunStatusAttempt | undefined;
  let retry: RunStatusRetry | undefined;
  let human: RunStatusHuman | undefined;
  let deliveries: ReadonlyArray<{ readonly id: string; readonly takenAt: number }> = [];
  let error: string | undefined;
  let note = previous?.note;
  let page = previous?.page;
  let now = previous?.now;
  let ending: RunEnding | undefined;
  let trail: RunTrailStep[] = [...previous?.trail ?? []];
  const enter = (entered: string | undefined, at: string) => {
    const path = entered === undefined ? "" : statePaths(entered).join(", ");
    if (path === "" || trail.at(-1)?.state === path) return;
    trail = [...trail, { state: path, at }].slice(-trailLimit);
  };

  const publish = (): boolean => {
    const record: RunStatusRecord = {
      schemaVersion: 2,
      ...(continued === undefined ? {} : { continued }),
      id,
      pid: process.pid,
      ...(owner === undefined ? {} : { owner }),
      ...(parent === undefined ? {} : { parent }),
      ...(label === undefined ? {} : { label }),
      machine: run.machine,
      path: run.path,
      cwd: run.cwd,
      status,
      ...(due === undefined ? {} : { due }),
      ...(state === undefined ? {} : { state }),
      ...(stateSince === undefined ? {} : { stateSince }),
      ...(agent === undefined ? {} : { agent }),
      ...(limit === undefined ? {} : { limit }),
      ...(attempt === undefined ? {} : { attempt }),
      ...(retry === undefined ? {} : { retry }),
      ...(human === undefined ? {} : { human }),
      ...(run.answeredBy === undefined ? {} : { answeredBy: run.answeredBy }),
      ...(continuedBy === undefined ? {} : { continuedBy }),
      ...(deliveries.length === 0 ? {} : { deliveries: deliveries.map((delivery) => delivery.id) }),
      ...(error === undefined ? {} : { error }),
      ...(note === undefined ? {} : { note }),
      ...(page === undefined ? {} : { page }),
      ...(now === undefined ? {} : { now }),
      ...(ending === undefined ? {} : { ending }),
      ...(graph === undefined ? {} : { graph }),
      ...(trail.length === 0 ? {} : { trail }),
      startedAt,
      updatedAt: new Date().toISOString(),
    };
    try {
      writeRunStatusRecord(directory, record);
      return true;
    } catch {
      // A status line is never worth a run: an unwritable directory is ignored.
      return false;
    }
  };

  try {
    pruneRunStatuses(directory);
  } catch {
    // Pruning is best effort for the same reason.
  }
  // A directory that cannot take the first record is not tried again at every
  // change, and the run goes on exactly as one that publication is off for.
  if (!publish()) return disabled;

  return {
    directory,
    update(change) {
      if (status === "completed" || status === "failed" || status === "sleeping") return;
      const problem = runNoteProblem(change);
      if (problem) throw new Error(problem);
      const nextState = "state" in change ? formatState(change.state) : state;
      const next = {
        graph: "graph" in change ? change.graph : graph,
        status: change.status ?? status,
        state: nextState,
        now: "now" in change ? change.now : now,
        note: "note" in change ? formatNote(change.note) : note,
        page: "note" in change ? change.page : page,
        agent: "agent" in change ? pickAgent(change.agent) : agent,
        // A wait belongs to the state whose Agent is waiting.
        limit: "limit" in change ? pickLimit(change.limit) : nextState === state ? limit : undefined,
        attempt: "attempt" in change ? pickAttempt(change.attempt) : nextState === state ? attempt : undefined,
        retry: "retry" in change ? change.retry : nextState === state ? retry : undefined,
        human: "human" in change ? pickHuman(change.human) : human,
        // A later response must not hide an earlier one from a sender that has yet to look.
        deliveries: change.delivery === undefined ? deliveries : [
          ...deliveries.filter((delivery) => Date.now() - delivery.takenAt < deliveryRetentionMilliseconds),
          { id: change.delivery, takenAt: Date.now() },
        ],
      };
      // Repeated notifications for an unchanged run do not need another write.
      if (JSON.stringify(next) === JSON.stringify({ graph, status, state, now, note, page, agent, limit, attempt, retry, human, deliveries })) return;
      if (next.state !== state) {
        stateSince = new Date().toISOString();
        enter(next.state, stateSince);
      }
      ({ graph, status, state, now, note, page, agent, limit, attempt, retry, human, deliveries } = next);
      publish();
    },
    sleep(until) {
      if (status === "completed" || status === "failed" || status === "sleeping") return;
      status = "sleeping";
      due = until;
      agent = undefined;
      limit = undefined;
      attempt = undefined;
      human = undefined;
      publish();
    },
    sleepForAnswer(request) {
      if (status === "completed" || status === "failed" || status === "sleeping") return;
      status = "sleeping";
      due = undefined;
      agent = undefined;
      limit = undefined;
      attempt = undefined;
      human = pickHuman(request);
      publish();
    },
    finish(outcome) {
      if (status === "completed" || status === "failed" || status === "sleeping") return;
      if ("error" in outcome) {
        status = "failed";
        error = outcome.error;
      } else {
        status = "completed";
        state = formatState(outcome.state) ?? state;
        note ??= formatNote(outcome.note);
        ending = outcome.ending === undefined ? undefined : { name: outcome.ending.name, kind: outcome.ending.kind };
        enter(state, new Date().toISOString());
      }
      retry = undefined;
      stateSince = undefined;
      agent = undefined;
      limit = undefined;
      attempt = undefined;
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

/** Readers only ever see a whole record: write beside it, then rename over it. */
export function writeRunStatusRecord(directory: string, record: RunStatusRecord): void {
  if (!isFileSafeId(record.id)) throw new Error(`Invalid run id "${record.id}"`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.${record.id}.${process.pid}.${temporaryFiles += 1}.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    renameSync(temporary, join(directory, `${record.id}.json`));
  } catch (cause) {
    rmSync(temporary, { force: true });
    throw cause;
  }
}

/**
 * Turns what a run reports as it executes into the changes to its record, for
 * `machine run` and for a hosted run alike.
 */
export function runStatusObserver(
  update: (change: RunStatusChange) => void,
): { onAgentUpdate(update: AgentUpdate): void; onState(state: StateValue): void; onEnter(entry: StateEntry): void } {
  let publishedState: string | undefined;
  // A runner reports its identity as it starts. For a state entered by a
  // transition that is before the state is announced, so an identity is held
  // for the rest of the tick and published with the state it belongs to.
  let arriving: Extract<AgentUpdate, { type: "identity" }> | undefined;
  return {
    onEnter(entry) {
      // Entry precedes invoked work and onState. Publish the current state now,
      // together with its retry so a continued entry preserves its saved count.
      update(entry.retry && entry.due
        ? { state: entry.value, retry: { ...entry.retry, due: entry.due } }
        : { state: entry.value, retry: undefined });
    },
    onAgentUpdate(agent) {
      if (agent.type === "identity") {
        arriving = agent;
        queueMicrotask(() => {
          if (arriving !== agent) return;
          arriving = undefined;
          update({ agent });
        });
      } else if (agent.type === "attempt") {
        arriving = undefined;
        update({ attempt: { role: agent.role, text: agent.text }, agent: undefined, limit: undefined });
      } else if (agent.type === "limit" && agent.status !== "swapped") {
        // A swap while every preset is being tried again leaves the wait as it is published.
        update({
          limit: agent.status === "resumed"
            ? undefined
            : { text: agent.text, ...(agent.until === undefined ? {} : { until: agent.until }) },
        });
      }
    },
    onState(state) {
      const entered = formatState(state);
      if (entered === publishedState) update({ state });
      else {
        update({ state, agent: arriving });
        arriving = undefined;
      }
      publishedState = entered;
    },
  };
}

/**
 * The session a process belongs to: the owner of the runs it starts, and the
 * session whose watch list `machine watch` changes. `MACHINES_RUN_OWNER` is how
 * any host names it; the others are what Claude Code, Codex, and Pi give the
 * commands they start.
 */
export function runSessionId(environment: NodeJS.ProcessEnv = process.env): string | undefined {
  return environment.MACHINES_RUN_OWNER
    || environment.CLAUDE_CODE_SESSION_ID
    || environment.CODEX_THREAD_ID
    || environment.PI_SESSION_ID
    || undefined;
}

/** Returns the valid records in a directory. Unreadable or malformed files are skipped. */
export function readRunStatuses(directory: string): RunStatusRecord[] {
  return readRecordFiles(directory).map(({ record }) => record);
}

function pruneRunStatuses(directory: string): void {
  const now = Date.now();
  const remove = (file: string): void => {
    try {
      rmSync(file, { force: true });
    } catch {
      // Not a file, or not ours to remove: nothing else waits on it.
    }
  };
  for (const { file, record } of readRecordFiles(directory)) {
    if (existsSync(join(directory, `${record.id}.checkpoint.json`))) continue;
    const settled = record.status === "completed" || record.status === "failed" || !isProcessAlive(record.pid);
    if (!settled || now - Date.parse(record.updatedAt) <= staleAfterMilliseconds) continue;
    // A response nobody collected goes with the run it was meant for, under each
    // of its names. The record goes last: a publisher stopped part way leaves it
    // for the next one to prune whole.
    const id = basename(file, ".json");
    remove(runInboxPath(directory, id));
    for (const name of listNames(directory)) {
      if (!name.startsWith(`.${id}.`)) continue;
      if (/^[^.]+\.inbox\.(?:sent|taken)$/u.test(name.slice(id.length + 2))) remove(join(directory, name));
    }
    remove(file);
  }
  // What a stopped process left half done has no record to go with, nor has an
  // inbox whose run was pruned without it, and a session that ended never
  // removes its watch list. Other files are not ours.
  const names = new Set(listNames(directory));
  for (const name of names) {
    if (/^\.[A-Za-z0-9_-][A-Za-z0-9._-]*\.claim$/u.test(name)) {
      cleanDeadClaim(join(directory, name));
      continue;
    }
    const orphaned = inboxName.test(name) && !names.has(`${basename(name, ".inbox")}.json`);
    const kept = leftoverName.test(name) || orphaned
      ? staleAfterMilliseconds
      : watchListName.test(name) ? watchRetentionMilliseconds : undefined;
    if (kept === undefined) continue;
    const file = join(directory, name);
    try {
      if (now - statSync(file).mtimeMs > kept) rmSync(file, { force: true });
    } catch {
      // Another publisher may have pruned it first.
    }
  }
}

/** Removes only a dead owner's token; rmdir cannot remove a new, populated claim. */
export function cleanDeadClaim(directory: string): void {
  try {
    for (const token of readdirSync(directory)) {
      const match = /^(\d+)\.[a-f0-9-]+$/u.exec(token);
      if (match && !isProcessAlive(Number(match[1]))) rmSync(join(directory, token), { force: true });
    }
    rmdirSync(directory);
  } catch { /* A live owner, another cleaner, or an unrelated file. */ }
}

function listNames(directory: string): string[] {
  try {
    return readdirSync(directory);
  } catch {
    return [];
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
  const attempt = record.attempt as Record<string, unknown> | null | undefined;
  const limit = record.limit as Record<string, unknown> | null | undefined;
  const continued = record.continued as Record<string, unknown> | null | undefined;
  return (continued === undefined || (continued !== null && typeof continued === "object" && isTimestamp(continued.at) && typeof continued.machineChanged === "boolean"))
    && (record.schemaVersion === 1 || record.schemaVersion === 2)
    && typeof record.id === "string" && record.id !== ""
    && Number.isSafeInteger(record.pid) && (record.pid as number) > 0
    && isOptionalString(record.owner)
    && isOptionalString(record.parent)
    && isOptionalString(record.label)
    && (record.stateSince === undefined || isTimestamp(record.stateSince))
    && (record.due === undefined || isTimestamp(record.due))
    && (record.status !== "sleeping" || isTimestamp(record.due)
      || (human !== null && typeof human === "object" && typeof human.requestId === "string"))
    && typeof record.machine === "string"
    && typeof record.path === "string"
    && typeof record.cwd === "string"
    && (record.status === "running" || record.status === "waiting"
      || record.status === "sleeping" || record.status === "completed" || record.status === "failed")
    && isOptionalString(record.now)
    && isOptionalString(record.state)
    && (agent === undefined || (agent !== null && typeof agent === "object" && typeof agent.harness === "string"
      && isOptionalString(agent.model) && isOptionalString(agent.thinking)))
    && (human === undefined || (human !== null && typeof human === "object" && typeof human.prompt === "string"
      && isOptionalString(human.requestId) && isOptionalString(human.answer)
      && isOptionalStrings(human.choices) && isOptionalStrings(human.suggestions)
      && isOptionalString(human.headline) && isOptionalString(human.recommended)
      && isOptionalString(human.reason) && isOptionalString(human.page) && isOptionalStrings(human.discards)
      && (human.effects === undefined || (human.effects !== null && typeof human.effects === "object"
        && !Array.isArray(human.effects) && Object.values(human.effects).every(value => typeof value === "string")))
      && (human.discussion === undefined || typeof human.discussion === "boolean")))
    && (attempt === undefined || (attempt !== null && typeof attempt === "object"
      && typeof attempt.role === "string" && typeof attempt.text === "string"))
    && (limit === undefined || (limit !== null && typeof limit === "object" && typeof limit.text === "string"
      && isOptionalString(limit.until)))
    && (record.answeredBy === undefined || record.answeredBy === "host")
    && (record.continuedBy === undefined || record.continuedBy === "host")
    && isOptionalStrings(record.deliveries)
    && isOptionalString(record.error)
    && runNoteProblem(record) === undefined
    && (record.ending === undefined || (record.ending !== null && typeof record.ending === "object"
      && !Array.isArray(record.ending) && typeof (record.ending as RunEnding).name === "string"
      && isEndingKind((record.ending as RunEnding).kind)))
    && (record.graph === undefined || isGraph(record.graph))
    && (record.trail === undefined || (Array.isArray(record.trail) && record.trail.every((step) =>
      step !== null && typeof step === "object" && typeof step.state === "string" && isTimestamp(step.at))))
    && isTimestamp(record.startedAt)
    && (record.retry === undefined || isRetry(record.retry))
    && isTimestamp(record.updatedAt);
}

function isRetry(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const retry = value as Partial<RunStatusRetry>;
  return Number.isInteger(retry.attempt) && Number.isInteger(retry.of)
    && retry.attempt! >= 2 && retry.attempt! <= retry.of! && retry.of! <= 11 && isTimestamp(retry.due);
}

function isGraph(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  const graph = value as Record<string, unknown>;
  return isOptionalString(graph.initial)
    && Array.isArray(graph.states) && graph.states.every((state) => state !== null && typeof state === "object"
      && typeof state.id === "string" && typeof state.kind === "string"
      && (state.ending === undefined || isEndingKind(state.ending))
      && isOptionalString(state.parent) && isOptionalString(state.role))
    && Array.isArray(graph.edges) && graph.edges.every((edge) => edge !== null && typeof edge === "object"
      && typeof edge.from === "string" && typeof edge.to === "string" && typeof edge.event === "string");
}

function isEndingKind(value: unknown): boolean {
  return value === "succeeded" || value === "failed" || value === "cancelled";
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

/** Only an object's non-empty summary is published from a Machine's output. */
export function runOutputSummary(output: unknown): string | undefined {
  if (output === null || typeof output !== "object" || Array.isArray(output)) return undefined;
  const summary = (output as Record<string, unknown>).summary;
  return typeof summary === "string" && summary.trim() !== "" ? summary : undefined;
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

function pickAttempt(attempt: RunStatusAttempt | undefined): RunStatusAttempt | undefined {
  return attempt === undefined ? undefined : { role: attempt.role, text: attempt.text };
}

function pickLimit(limit: RunStatusLimit | undefined): RunStatusLimit | undefined {
  if (limit === undefined) return undefined;
  return { text: limit.text, ...(limit.until === undefined ? {} : { until: limit.until }) };
}

function pickHuman(human: RunStatusHuman | undefined): RunStatusHuman | undefined {
  if (human === undefined) return undefined;
  const { prompt, discussion, ...fields } = copyHumanRequest(human);
  return {
    prompt,
    ...(human.requestId === undefined ? {} : { requestId: human.requestId }),
    ...fields,
    ...(discussion === true ? { discussion: true } : {}),
  };
}
