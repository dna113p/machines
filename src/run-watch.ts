import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";

import { isFileSafeId, watchListName, watchRetentionMilliseconds, type RunStatusRecord } from "./run-status.ts";

/**
 * One thing a session asked to see on its status line besides its own runs:
 * runs named by the start of their id or label, or runs working in a directory.
 */
export type RunWatch = { readonly text: string } | { readonly dir: string };

let temporaryFiles = 0;

/**
 * A session's watch list, kept beside the records under a name their readers
 * skip. `claude/statusline.mjs` reads the same file without loading this module.
 */
export function runWatchPath(directory: string, sessionId: string): string {
  if (!isFileSafeId(sessionId)) {
    throw new Error(`Session id "${sessionId}" cannot name a watch list: use only letters, digits, ".", "_", and "-"`);
  }
  return join(directory, `.watch.${sessionId}.json`);
}

/** What a session watches. A missing, unreadable, or malformed list watches nothing. */
export function readRunWatches(directory: string, sessionId: string): RunWatch[] {
  try {
    const list: unknown = JSON.parse(readFileSync(runWatchPath(directory, sessionId), "utf8"));
    const watches = (list as { readonly watches?: unknown } | null)?.watches;
    return Array.isArray(watches) ? watches.flatMap((watch) => pickWatch(watch) ?? []) : [];
  } catch {
    return [];
  }
}

/** Replaces a session's watch list; an empty one removes its file. */
export function writeRunWatches(directory: string, sessionId: string, watches: readonly RunWatch[]): void {
  const path = runWatchPath(directory, sessionId);
  if (watches.length === 0) {
    rmSync(path, { force: true });
    return;
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  // Readers only ever see a whole list: write beside it, then rename over it.
  const temporary = join(directory, `.watch.${sessionId}.${process.pid}.${temporaryFiles += 1}.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify({ schemaVersion: 1, watches })}\n`, { mode: 0o600 });
    renameSync(temporary, path);
  } catch (cause) {
    rmSync(temporary, { force: true });
    throw cause;
  }
  try {
    pruneRunWatches(directory, path);
  } catch {
    // Pruning is best effort.
  }
}

/** Whether a watch names a run. A sub-run is never watched: it is its parent's detail. */
export function runWatchMatches(watch: RunWatch, record: RunStatusRecord): boolean {
  if (record.parent !== undefined) return false;
  if ("dir" in watch) {
    if (!isAbsolute(record.cwd)) return false;
    const cwd = resolve(record.cwd);
    return cwd === watch.dir || cwd.startsWith(watch.dir.endsWith(sep) ? watch.dir : `${watch.dir}${sep}`);
  }
  if (record.id.startsWith(watch.text)) return true;
  // The label must start with the whole text, not with a longer word that begins like it.
  const next = record.label?.startsWith(watch.text) ? record.label.slice(watch.text.length) : undefined;
  return next !== undefined && !/^[\p{L}\p{N}_-]/u.test(next);
}

/** Checks and normalizes what `machine watch` was given. */
export function runWatch(input: RunWatch): RunWatch {
  if ("dir" in input) {
    if (input.dir === "") throw new Error("Expected a directory after --dir");
    return { dir: resolve(input.dir) };
  }
  const text = input.text.trim();
  if (text === "") throw new Error("Expected the start of a run id or label to watch");
  // Checked before the ends are trimmed: a line break there is still a second line.
  if (/[\r\n]/u.test(input.text)) throw new Error("A watch is one line: the start of a run id or label");
  return { text };
}

export function sameRunWatch(left: RunWatch, right: RunWatch): boolean {
  return "dir" in left ? "dir" in right && left.dir === right.dir : "text" in right && left.text === right.text;
}

function pickWatch(value: unknown): RunWatch | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const { text, dir } = value as Record<string, unknown>;
  if (typeof text === "string" && text !== "" && dir === undefined) return { text };
  if (typeof dir === "string" && isAbsolute(dir) && text === undefined) return { dir: resolve(dir) };
  return undefined;
}

/**
 * Sessions end without saying so; a list nobody has changed for a month belongs
 * to one that did. A run that starts prunes them by the same rule.
 */
function pruneRunWatches(directory: string, kept: string): void {
  const now = Date.now();
  for (const name of readdirSync(directory)) {
    const file = join(directory, name);
    if (!watchListName.test(name) || file === kept) continue;
    try {
      if (now - statSync(file).mtimeMs > watchRetentionMilliseconds) rmSync(file, { force: true });
    } catch {
      // Another session may have pruned it first.
    }
  }
}
