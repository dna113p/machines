#!/usr/bin/env node

// Claude Code status line for Machine runs published through
// MACHINES_RUN_STATUS_DIR (see docs/integrations.md). It runs on every status
// refresh, so it imports only node: modules and never loads the runtime; the
// record shape below mirrors RunStatusRecord in src/run-status.ts.

import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const terminalVisibleMilliseconds = 30_000;
const maximumRuns = 5;
const defaultColumns = 120;
const ansiSequence = /\x1b\[[0-9;]*m/uy;
// Combining marks, format characters such as joiners, and Hangul medial and
// final jamo are drawn on the character before them.
const zeroWidth = /[\p{Mn}\p{Me}\p{Cf}\u1160-\u11ff]/u;
// East Asian Wide and Fullwidth characters, and emoji drawn as pictures, take two columns.
const wide = /[\u1100-\u115f\u2e80-\u303e\u3041-\ua4cf\ua960-\ua97f\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6\u{20000}-\u{3fffd}\p{Emoji_Presentation}]/u;

/**
 * Builds the status lines for the runs one Claude Code session should see.
 * Pure apart from the default process-liveness probe, which callers may replace.
 */
export function runStatusLines(records, options = {}) {
  const {
    sessionId,
    projectDir,
    now = Date.now(),
    columns = defaultColumns,
    color = true,
    isAlive = isProcessAlive,
  } = options;
  const paint = (code, text) => (color ? `\x1b[${code}m${text}\x1b[0m` : text);
  const width = Number.isSafeInteger(columns) && columns > 0 ? columns : defaultColumns;

  const visible = [];
  for (const record of records) {
    // Sub-runs belong to the run that started them, not to the session.
    if (!isRecord(record) || record.parent !== undefined || !isVisibleTo(record, sessionId, projectDir)) continue;
    const updatedAt = Date.parse(record.updatedAt);
    const recorded = record.status === "running" || record.status === "waiting";
    // A run that stopped reporting without finishing has lost its process.
    const lost = recorded && !isAlive(record.pid);
    const active = recorded && !lost;
    if (!active && now - updatedAt > terminalVisibleMilliseconds) continue;
    visible.push({ record, active, lost, updatedAt });
  }
  visible.sort((left, right) => Number(right.active) - Number(left.active) || right.updatedAt - left.updatedAt);

  const lines = [];
  for (const { record, active, lost, updatedAt } of visible.slice(0, maximumRuns)) {
    const waiting = active && record.status === "waiting";
    const completed = record.status === "completed";
    const failed = lost || record.status === "failed";
    const code = waiting ? 33 : completed ? 32 : failed ? 31 : 36;
    const symbol = waiting ? "◆" : completed ? "✓" : failed ? "✕" : "●";
    const state = waiting
      ? "input needed"
      : lost
        ? "lost"
        : failed
          ? "failed"
          : record.state ?? "starting";
    const elapsed = formatElapsed(Date.parse(record.startedAt), active ? now : updatedAt);
    lines.push(
      `${paint(code, symbol)} ${paint(2, plain(record.id).slice(0, 8))}  ${paint(1, plain(record.machine))} › ${paint(code, plain(state))} · ${paint(2, elapsed)}`,
    );
    if (waiting && record.human !== undefined) {
      const prompt = record.human.prompt.split("\n").map(plain).find((line) => line !== "");
      if (prompt !== undefined) lines.push(`  ${paint(33, prompt)}`);
    } else if (active && record.agent !== undefined) {
      lines.push(`  ${paint(2, plain(formatAgent(record.agent)))}`);
    }
  }
  if (visible.length > maximumRuns) lines.push(paint(2, `… ${visible.length - maximumRuns} more`));
  return lines.map((line) => truncate(line, width));
}

function isVisibleTo(record, sessionId, projectDir) {
  if (record.owner !== undefined) return typeof sessionId === "string" && record.owner === sessionId;
  if (typeof projectDir !== "string" || !isAbsolute(projectDir) || !isAbsolute(record.cwd)) return false;
  const project = resolve(projectDir);
  const cwd = resolve(record.cwd);
  return cwd === project || cwd.startsWith(project.endsWith(sep) ? project : `${project}${sep}`);
}

function isRecord(value) {
  if (value === null || typeof value !== "object") return false;
  const { agent, human } = value;
  // Version 2 adds what answers a waiting request; the line shows only its prompt.
  return (value.schemaVersion === 1 || value.schemaVersion === 2)
    && typeof value.id === "string"
    && Number.isSafeInteger(value.pid) && value.pid > 0
    && isOptionalString(value.owner)
    && isOptionalString(value.parent)
    && typeof value.machine === "string"
    && typeof value.cwd === "string"
    && ["running", "waiting", "completed", "failed"].includes(value.status)
    && isOptionalString(value.state)
    && (agent === undefined || (agent !== null && typeof agent === "object" && typeof agent.harness === "string"
      && isOptionalString(agent.model) && isOptionalString(agent.thinking)))
    && (human === undefined || (human !== null && typeof human === "object" && typeof human.prompt === "string"))
    && isTimestamp(value.startedAt)
    && isTimestamp(value.updatedAt);
}

function isOptionalString(value) {
  return value === undefined || typeof value === "string";
}

function isTimestamp(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    // EPERM means the process exists but belongs to someone else.
    return cause?.code === "EPERM";
  }
}

function formatAgent(agent) {
  return [agent.harness, agent.model, agent.thinking === undefined ? undefined : `thinking ${agent.thinking}`]
    .filter((part) => part !== undefined)
    .join(" · ");
}

function formatElapsed(startedAt, endedAt) {
  const seconds = Math.max(0, Math.floor((endedAt - startedAt) / 1_000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** Recorded text must not be able to move the cursor or restyle the status line. */
function plain(text) {
  return text.replace(/[\u0000-\u001f\u007f-\u009f]+/gu, " ").trim();
}

/** Shortens to a width in terminal columns; colour sequences take no room and stay intact. */
function truncate(line, width) {
  if (columnsOf(line.replace(new RegExp(ansiSequence.source, "gu"), "")) <= width) return line;
  let shortened = "";
  let used = 0;
  let colored = false;
  let index = 0;
  while (index < line.length) {
    ansiSequence.lastIndex = index;
    const sequence = ansiSequence.exec(line)?.[0];
    if (sequence !== undefined) {
      shortened += sequence;
      colored = true;
      index += sequence.length;
      continue;
    }
    const character = String.fromCodePoint(line.codePointAt(index));
    const columns = characterColumns(character);
    // The last column is kept for the ellipsis.
    if (used + columns > width - 1) break;
    shortened += character;
    used += columns;
    index += character.length;
  }
  return `${shortened}…${colored ? "\x1b[0m" : ""}`;
}

function columnsOf(text) {
  let columns = 0;
  for (const character of text) columns += characterColumns(character);
  return columns;
}

function characterColumns(character) {
  if (zeroWidth.test(character)) return 0;
  return wide.test(character) ? 2 : 1;
}

function readRecords(directory) {
  const records = [];
  for (const name of readdirSync(directory)) {
    if (name.startsWith(".") || !name.endsWith(".json")) continue;
    try {
      records.push(JSON.parse(readFileSync(join(directory, name), "utf8")));
    } catch {
      // Not a record, or replaced while it was being read.
    }
  }
  return records;
}

async function main() {
  const directory = process.env.MACHINES_RUN_STATUS_DIR;
  if (directory === undefined || directory === "" || process.stdin.isTTY) return;

  let text = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) text += chunk;
  const input = JSON.parse(text);
  if (input === null || typeof input !== "object") return;

  const columns = /^[0-9]+$/u.test(process.env.COLUMNS ?? "") ? Number(process.env.COLUMNS) : defaultColumns;
  const lines = runStatusLines(readRecords(directory), {
    sessionId: input.session_id,
    projectDir: [input.workspace?.project_dir, input.workspace?.current_dir, input.cwd]
      .find((path) => typeof path === "string" && path !== ""),
    columns,
    color: process.env.NO_COLOR === undefined,
  });
  if (lines.length > 0) process.stdout.write(`${lines.join("\n")}\n`);
}

function isMainModule() {
  if (typeof import.meta.main === "boolean") return import.meta.main;
  try {
    return process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  // A status line that fails would replace the host's own; stay silent instead.
  process.on("uncaughtException", () => process.exit(0));
  process.stdout.on("error", () => {});
  main().catch(() => {}).finally(() => {
    process.exitCode = 0;
  });
}
