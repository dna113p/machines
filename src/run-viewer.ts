import { isProcessAlive, type RunStatusRecord } from "./run-status.ts";
import { isWithinDirectory, runWatchMatches, type RunWatch } from "./run-watch.ts";

// The package exports this module as `@dna113p/machines/run-status`: what an
// application needs to draw its own widgets for published runs. It only reads;
// the publisher and the watch-list writer stay in the runtime.
export { readRunStatuses, runSessionId, runStatusDirectory } from "./run-status.ts";
export type { RunStatusAgent, RunStatusHuman, RunStatusLimit, RunStatusRecord } from "./run-status.ts";
export { statePaths } from "./run-graph.ts";
export type { RunGraph, RunGraphEdge, RunGraphState, RunTrailStep } from "./run-graph.ts";
export { readRunWatches } from "./run-watch.ts";
export type { RunWatch } from "./run-watch.ts";

/** How long a settled or lost run stays with its viewers before it drops out. */
export const settledRunVisibleMilliseconds = 30_000;

/** One surface that shows runs: a coding-agent session, a status line, a browser tab. */
export interface RunViewer {
  /** Shows the runs this session owns. Its watch list is kept under the same id. */
  readonly sessionId: string;
  /** Absolute project directory; shows unowned runs working in it or below it. */
  readonly projectDir?: string;
  /** What the session asked to watch; shows the top-level runs an entry names, whoever owns them. */
  readonly watches?: readonly RunWatch[];
}

export interface ViewerRunOptions {
  readonly now?: number;
  /** Keeps settled and lost runs however long ago they stopped. */
  readonly all?: boolean;
  readonly isAlive?: (pid: number) => boolean;
}

/**
 * How a waiting run's Human request is answered: by `machine respond` with
 * these two ids, or only through the program that hosts the run.
 */
export type RunAnswer =
  | { readonly via: "respond"; readonly runId: string; readonly requestId: string }
  | { readonly via: "host" };

/** A published record as one viewer shows it. */
export interface ViewerRun extends Omit<RunStatusRecord, "status"> {
  /** `lost` when the record says running or waiting and its process is gone. */
  readonly status: RunStatusRecord["status"] | "lost";
  /** Why the viewer shows it; the first that holds of owned, project, and watched. */
  readonly shown: "owned" | "project" | "watched";
  /** Present while the run waits on a request that something can answer. */
  readonly answer?: RunAnswer;
}

/**
 * The runs one viewer shows: the runs its session owns, unowned runs working
 * inside its project, and runs it watches. Sub-runs are never shown, and a
 * settled or lost run drops out after `settledRunVisibleMilliseconds`. Runs
 * that can still change come first, then the most recently updated; records
 * that tie keep the order they were given in.
 *
 * Pure apart from the default process-liveness probe. `claude/statusline.mjs`
 * cannot load this module and carries a copy of the selection;
 * tests/run-viewer.test.ts keeps the two in step.
 */
export function runsForViewer(
  records: readonly RunStatusRecord[],
  viewer: RunViewer,
  options: ViewerRunOptions = {},
): ViewerRun[] {
  const { now = Date.now(), all = false, isAlive = isProcessAlive } = options;
  const visible: Array<{ readonly run: ViewerRun; readonly active: boolean; readonly updatedAt: number }> = [];
  for (const record of records) {
    // Sub-runs belong to the run that started them, not to the session.
    if (record.parent !== undefined) continue;
    const shown = shownBecause(record, viewer);
    if (shown === undefined) continue;
    const updatedAt = Date.parse(record.updatedAt);
    const recorded = record.status === "running" || record.status === "waiting";
    // A run that stopped reporting without finishing has lost its process.
    const lost = recorded && !isAlive(record.pid);
    const active = recorded && !lost;
    if (!active && !all && now - updatedAt > settledRunVisibleMilliseconds) continue;
    const status = lost ? "lost" : record.status;
    const answer = status === "waiting" ? runAnswer(record) : undefined;
    visible.push({ run: { ...record, status, shown, ...(answer === undefined ? {} : { answer }) }, active, updatedAt });
  }
  visible.sort((left, right) => Number(right.active) - Number(left.active) || right.updatedAt - left.updatedAt);
  return visible.map(({ run }) => run);
}

function shownBecause(record: RunStatusRecord, viewer: RunViewer): ViewerRun["shown"] | undefined {
  // An owned run is its owner's: the project it works in shows it to nobody else.
  if (record.owner !== undefined) {
    if (record.owner === viewer.sessionId) return "owned";
  } else if (viewer.projectDir !== undefined && isWithinDirectory(record.cwd, viewer.projectDir)) {
    return "project";
  }
  // A run the session asked to watch is shown whoever owns it and wherever it works.
  return viewer.watches?.some((watch) => runWatchMatches(watch, record)) === true ? "watched" : undefined;
}

function runAnswer(record: RunStatusRecord): RunAnswer | undefined {
  if (record.human === undefined) return undefined;
  if (record.answeredBy === "host") return { via: "host" };
  // A record from before requests had ids says nothing about how it is answered.
  const { requestId } = record.human;
  return requestId === undefined ? undefined : { via: "respond", runId: record.id, requestId };
}
