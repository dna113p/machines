import type { RunStatusRecord } from "../src/run-status.ts";

export interface RunStatusLineOptions {
  /** Claude Code `session_id`; shows the records it owns. */
  readonly sessionId?: string;
  /** Absolute project directory; shows unowned records started in or below it. */
  readonly projectDir?: string;
  readonly now?: number;
  readonly columns?: number;
  readonly color?: boolean;
  readonly isAlive?: (pid: number) => boolean;
}

/** Records that are not valid RunStatusRecords are skipped. */
export function runStatusLines(
  records: readonly (RunStatusRecord | object)[],
  options?: RunStatusLineOptions,
): string[];
