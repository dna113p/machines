import type { RunStatusRecord } from "../src/run-status.ts";

export interface RunStatusLineOptions {
  /** Claude Code `session_id`; shows the records it owns. */
  readonly sessionId?: string;
  /** Absolute project directory; shows unowned records started in or below it. */
  readonly projectDir?: string;
  /** The session's watch list; shows the top-level records an entry names, whoever owns them. Invalid entries are skipped. */
  readonly watches?: readonly ({ readonly text: string } | { readonly dir: string } | object | null)[];
  readonly now?: number;
  readonly columns?: number;
  readonly color?: boolean;
  readonly isAlive?: (pid: number) => boolean;
}

/** The directory runs publish to, or undefined while publication is off: `runStatusDirectory` in src/run-status.ts. */
export function runStatusDirectory(environment?: NodeJS.ProcessEnv): string | undefined;

/** Records that are not valid RunStatusRecords are skipped. */
export function runStatusLines(
  records: readonly (RunStatusRecord | object)[],
  options?: RunStatusLineOptions,
): string[];
