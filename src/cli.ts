#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { emitKeypressEvents, type Key } from "node:readline";
import { inspect, stripVTControlCharacters } from "node:util";

import yoctoSpinner from "yocto-spinner";
import { bold, cyan, dim, green, magenta, red, yellow } from "yoctocolors";

import { assertJsonValue, isJsonValue, type JsonValue } from "./json.ts";
import { discoverMachines, machinesUserHome } from "./discovery.ts";
import {
  type AgentPresetSummary,
  type MachineSummary,
  listAgentPresets,
  listMachines,
  prepareMachineRun,
} from "./launcher.ts";
import { inboxHuman, respondToRun } from "./run-inbox.ts";
import {
  createRunStatusPublisher,
  isProcessAlive,
  readRunStatuses,
  runSessionId,
  runStatusDirectory,
  runStatusObserver,
  type RunStatusRecord,
} from "./run-status.ts";
import {
  readRunWatches,
  runWatch,
  runWatchMatches,
  runWatchPath,
  sameRunWatch,
  writeRunWatches,
  type RunWatch,
} from "./run-watch.ts";

import type { StateValue } from "xstate";
import type { AgentUpdate, RunOptions } from "./index.ts";

const [command, selector, ...argumentsAfterSelector] = process.argv.slice(2);
const runsOptions = selector === undefined ? [] : [selector, ...argumentsAfterSelector];
const watchUsage = "machine watch [<run-id-or-label-start> | --dir <path>]";
const unwatchUsage = "machine unwatch <run-id-or-label-start> | --dir <path> | --all";

try {
  if (command === "list" && selector === undefined) {
    const machines = await listMachines({ cwd: process.cwd() });
    if (machines.length === 0) console.log("No Machines found.");
    machines.forEach((found, index) => {
      printMachineListing(found, index > 0);
    });
    if (machines.some((found) => found.error !== undefined)) process.exitCode = 1;
  } else if (command === "agents" && selector === undefined) {
    const presets = await listAgentPresets({ cwd: process.cwd() });
    if (presets.length === 0) console.log("No Agent presets found.");
    presets.forEach((preset, index) => {
      printAgentListing(preset, index > 0);
    });
  } else if (command === "show" && selector !== undefined) {
    const machinePath = await resolveMachine(selector);
    console.log(`Machine: ${machinePath}`);
    console.log(await readFile(machinePath, "utf8"));
  } else if (command === "run" && selector !== undefined) {
    await runMachine(await resolveMachine(selector), argumentsAfterSelector);
  } else if (
    command === "runs"
    && runsOptions.every((option, index) => (option === "--json" || option === "--all") && runsOptions.indexOf(option) === index)
  ) {
    listRuns(runsOptions.includes("--json"), runsOptions.includes("--all"));
  } else if (command === "respond" && selector !== undefined) {
    await respond([selector, ...argumentsAfterSelector]);
  } else if (command === "watch") {
    watch(selector === undefined ? [] : [selector, ...argumentsAfterSelector]);
  } else if (command === "unwatch" && selector !== undefined) {
    unwatch([selector, ...argumentsAfterSelector]);
  } else {
    throw new Error([
      "Usage:",
      "  machine list",
      "  machine agents",
      "  machine show <name-or-file>",
      "  machine run <name-or-file> [--agent role=preset]... [--input-file <file|->] [--] [input]",
      "  machine runs [--json] [--all]",
      "  machine respond [--question] <run-id> <request-id> [--] <response>",
      `  ${watchUsage}`,
      `  ${unwatchUsage}`,
    ].join("\n"));
  }
} catch (cause) {
  console.error(cause instanceof Error ? cause.message : String(cause));
  process.exitCode = 1;
}

async function resolveMachine(selector: string) {
  if (isAbsolute(selector) || selector.includes("/") || selector.endsWith(".ts")) {
    return resolve(selector);
  }

  const machines = await discoverMachines(process.cwd(), machinesUserHome());
  const found = machines.find((candidate) => candidate.name === selector);
  if (found === undefined) {
    throw new Error(`Machine "${selector}" not found. Run "machine list" to see available Machines.`);
  }
  return found.path;
}

async function runMachine(machinePath: string, args: string[]) {
  const invocation = await parseRunArguments(args);
  printMachineHeader(machinePath);
  const prepared = await prepareMachineRun({
    cwd: process.cwd(),
    machine: machinePath,
    input: invocation.input,
    agents: Object.fromEntries(invocation.agentOverrides),
  });
  const status = createRunStatus(machinePath);
  const runId = randomUUID();
  const published = createRunStatusPublisher({ id: runId, machine: prepared.name, path: prepared.path, cwd: process.cwd() });
  const statusDirectory = runStatusDirectory();
  // Machines started by this run's Operations and Agents are its sub-runs.
  process.env.MACHINES_RUN_PARENT = runId;
  const observed = runStatusObserver((change) => published.update(change));

  try {
    const result = await prepared.start({
      onAgentUpdate(update) {
        observed.onAgentUpdate(update);
        status.onAgentUpdate(update);
      },
      // A published run can also be answered through its inbox by `machine respond`.
      ...(statusDirectory === undefined ? {} : {
        human: inboxHuman({
          directory: statusDirectory,
          runId,
          publish: (request) => published.update({ status: "waiting", human: request }),
          acknowledge: (delivery) => published.update({ delivery }),
          onTerminalRefused: (reason) => console.error(reason),
          onTerminalClosed(requestId) {
            // Finish the unanswered prompt line before saying where the answer can come from.
            process.stdout.write("\n");
            console.error(`No terminal input. Answer with: machine respond ${runId} ${requestId} <response>`);
          },
        }),
      }),
      onHumanInput(active) {
        published.update(active ? { status: "waiting" } : { status: "running", human: undefined });
        status.onHumanInput(active);
      },
      onState(state) {
        observed.onState(state);
        status.onState(state);
      },
    });

    published.finish({ state: result.value });
    status.succeed();
    console.log(`--> ${String(result.value)}`);
    if (result.output !== undefined) {
      console.log(isJsonValue(result.output) ? JSON.stringify(result.output, null, 2) : inspect(result.output));
    }
  } catch (cause) {
    published.finish({ error: cause instanceof Error ? cause.message : String(cause) });
    status.fail();
    throw cause;
  } finally {
    status.close();
  }
}

function listRuns(json: boolean, all: boolean) {
  const directory = requireStatusDirectory();
  const published = publishedRuns(directory);
  // Without --all, only the runs that can still change or be answered.
  const runs = all ? published : published.filter(isActiveRun);
  if (json) {
    console.log(JSON.stringify(runs, null, 2));
    return;
  }
  if (runs.length === 0) console.log(all ? "No Machine runs are published." : "No Machine runs are running or waiting.");
  const session = runSessionId();
  const watches = session === undefined ? [] : readRunWatches(directory, session);
  runs.forEach((record, index) => {
    printRunListing(record, index > 0, watches.some((watched) => runWatchMatches(watched, record)));
  });
}

/** Every record in the directory, including runs that finished or lost their process and are still recorded. */
function publishedRuns(directory: string) {
  return readRunStatuses(directory).sort((left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt));
}

/** A run that stopped reporting without finishing has lost its process, as on the status line. */
function runStatus(record: RunStatusRecord) {
  return record.status !== "completed" && record.status !== "failed" && !isProcessAlive(record.pid) ? "lost" : record.status;
}

function isActiveRun(record: RunStatusRecord) {
  const status = runStatus(record);
  return status === "running" || status === "waiting";
}

function watch(args: string[]) {
  const { directory, session } = requireWatchList();
  const watches = readRunWatches(directory, session);
  const runs = publishedRuns(directory);
  if (args.length === 0) {
    if (watches.length === 0) console.log("This session watches no other runs.");
    for (const watched of watches) {
      console.log(describeWatch(watched));
      printWatchedRuns(watched, runs);
    }
    return;
  }
  const added = parseWatch(args, watchUsage);
  if (!watches.some((watched) => sameRunWatch(watched, added))) writeRunWatches(directory, session, [...watches, added]);
  console.log(`Watching ${describeWatch(added)}`);
  printWatchedRuns(added, runs);
}

function unwatch(args: string[]) {
  const { directory, session } = requireWatchList();
  if (args[0] === "--all") {
    if (args.length !== 1) throw new Error(`Usage: ${unwatchUsage}`);
    writeRunWatches(directory, session, []);
    console.log("This session watches no other runs.");
    return;
  }
  const removed = parseWatch(args, unwatchUsage);
  const watches = readRunWatches(directory, session);
  const kept = watches.filter((watched) => !sameRunWatch(watched, removed));
  if (kept.length === watches.length) {
    console.log(`This session was not watching ${describeWatch(removed)}`);
    return;
  }
  writeRunWatches(directory, session, kept);
  console.log(`No longer watching ${describeWatch(removed)}`);
}

function parseWatch(args: string[], usage: string): RunWatch {
  if (args[0] === "--dir") {
    if (args.length !== 2) throw new Error(`Usage: ${usage}`);
    return runWatch({ dir: args[1]! });
  }
  if (args[0] !== "--" && args[0]?.startsWith("--") === true) throw new Error(`Usage: ${usage}`);
  return runWatch({ text: (args[0] === "--" ? args.slice(1) : args).join(" ") });
}

function describeWatch(watched: RunWatch) {
  return "dir" in watched ? `--dir ${watched.dir}` : watched.text;
}

function printWatchedRuns(watched: RunWatch, runs: readonly RunStatusRecord[]) {
  const matched = runs.filter((record) => runWatchMatches(watched, record));
  if (matched.length === 0) console.log("  no published run matches yet");
  for (const record of matched) console.log(`  ${runColumns(record).join("\t")}`);
}

/** The session whose watch list this process changes, and where the list is kept. */
function requireWatchList() {
  const directory = requireStatusDirectory();
  const session = runSessionId();
  if (session === undefined) {
    throw new Error(
      "No session to watch for: set MACHINES_RUN_OWNER to the id of the session whose status line shows the runs.",
    );
  }
  // Refuses a session id that cannot name a file.
  runWatchPath(directory, session);
  return { directory, session };
}

async function respond(args: string[]) {
  const question = args[0] === "--question";
  const [runId, requestId, ...words] = question ? args.slice(1) : args;
  if (words[0] === "--") words.shift();
  if (runId === undefined || requestId === undefined || words.length === 0) {
    throw new Error("Usage: machine respond [--question] <run-id> <request-id> [--] <response>");
  }
  const text = words.join(" ");
  await respondToRun({
    directory: requireStatusDirectory(),
    runId,
    requestId,
    response: question ? { type: "question", text } : text,
  });
  console.log(`Machine run ${runId} took the ${question ? "question" : "response"}.`);
}

function requireStatusDirectory() {
  const directory = runStatusDirectory();
  if (directory === undefined) {
    throw new Error("Run status publication is off: set MACHINES_RUN_STATUS_DIR to the directory the runs publish to.");
  }
  return directory;
}

async function parseRunArguments(args: string[]) {
  let inputFile: string | undefined;
  const agentOverrides = new Map<string, string>();
  let index = 0;

  while (index < args.length) {
    const argument = args[index];
    if (argument === "--") {
      index += 1;
      break;
    }
    if (argument === "--input-file") {
      if (inputFile !== undefined || args[index + 1] === undefined) throw new Error("Expected one --input-file <file|->");
      inputFile = args[index + 1];
      index += 2;
      continue;
    }
    if (argument !== "--agent") break;

    const assignment = args[index + 1];
    if (assignment === undefined) {
      throw new Error('Expected "role=preset" after "--agent"');
    }
    const separator = assignment.indexOf("=");
    const role = separator === -1 ? "" : assignment.slice(0, separator);
    const preset = separator === -1 ? "" : assignment.slice(separator + 1);
    if (
      role.trim() === ""
      || preset.trim() === ""
      || role !== role.trim()
      || preset !== preset.trim()
    ) {
      throw new Error(`Invalid Agent override "${assignment}"; expected "role=preset"`);
    }
    if (agentOverrides.has(role)) {
      throw new Error(`Agent role "${role}" was overridden more than once`);
    }
    agentOverrides.set(role, preset);
    index += 2;
  }

  let input: JsonValue = args.slice(index).join(" ");
  if (inputFile !== undefined) {
    if (args.length > index) throw new Error("Use positional input or --input-file, not both");
    let text: string;
    if (inputFile === "-") {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
      text = Buffer.concat(chunks).toString("utf8");
    } else text = await readFile(inputFile, "utf8");
    const parsed: unknown = JSON.parse(text);
    assertJsonValue(parsed, "Machine input");
    input = parsed;
  }
  return { agentOverrides, input };
}

function printMachineListing(found: MachineSummary, separate: boolean) {
  if (!process.stdout.isTTY) {
    if (found.error !== undefined) console.error(found.error);
    const readiness = found.error !== undefined ? "invalid" : found.missingAgents.length === 0
      ? "ready"
      : `missing Agents: ${found.missingAgents.join(", ")}`;
    console.log(`${found.name}\t${found.description}\t${found.path}\t${readiness}`);
    return;
  }

  if (separate) console.log();
  console.log(bold(cyan(found.name)));
  console.log(`  ${found.description}`);
  console.log(`  ${dim(found.path)}`);
  if (found.error !== undefined) console.log(`  ${red(found.error)}`);
  if (found.missingAgents.length > 0) {
    console.log(`  ${yellow(`missing Agents: ${found.missingAgents.join(", ")}`)}`);
  }
}

function printAgentListing(preset: AgentPresetSummary, separate: boolean) {
  const identity = [preset.harness, preset.model, preset.thinking].filter(Boolean);
  if (!process.stdout.isTTY) {
    console.log([
      preset.name,
      preset.description,
      preset.harness ?? "",
      preset.model ?? "",
      preset.thinking ?? "",
      preset.source,
      preset.fallback?.join(", ") ?? "",
    ].join("\t"));
    return;
  }

  if (separate) console.log();
  console.log(bold(cyan(preset.name)));
  console.log(`  ${preset.description}`);
  if (identity.length > 0) console.log(`  ${magenta(identity.join(" · "))}`);
  if (preset.fallback !== undefined) console.log(`  fallback: ${preset.fallback.join(", ") || "none"}`);
  console.log(`  ${dim(preset.source)}`);
}

/** Recorded text must not be able to move the cursor or restyle the terminal. */
function plain(text: string) {
  return text.replace(/[\u0000-\u001f\u007f-\u009f]+/gu, " ").trim();
}

/** A run as tab-separated columns: its label follows the four that were always there. */
function runColumns(record: RunStatusRecord) {
  const label = record.label === undefined ? "" : plain(record.label);
  return [record.id, record.machine, runStatus(record), record.state ?? "starting"].map(plain).concat(label === "" ? [] : [label]);
}

function printRunListing(record: RunStatusRecord, separate: boolean, watched: boolean) {
  const state = record.state ?? "starting";
  const recorded = runStatus(record);
  const human = recorded === "waiting" ? record.human : undefined;
  // A run that finished or lost its process is no longer waiting for anything.
  const limit = recorded === "running" || recorded === "waiting" ? record.limit : undefined;
  const details = human === undefined ? (limit === undefined ? [] : [plain(limit.text)]) : [
    ...human.prompt.split("\n").map(plain).filter((line) => line !== ""),
    ...(human.requestId === undefined ? [] : [`request: ${plain(human.requestId)}`]),
    ...(record.answeredBy === "host" ? ["answered through its host"] : []),
    ...(human.choices === undefined ? [] : [`choices: ${human.choices.map(plain).join(", ")}`]),
    ...(human.suggestions === undefined ? [] : [`suggestions: ${human.suggestions.map(plain).join(", ")}`]),
    ...(human.discussion === true ? ["discussion: questions allowed"] : []),
  ];

  if (!process.stdout.isTTY) {
    const columns = runColumns(record);
    // The mark has its own column, after the label's, whether or not the run has a label.
    console.log((watched ? [...columns, ...(columns.length === 4 ? [""] : []), "watched"] : columns).join("\t"));
    for (const line of details) console.log(`  ${line}`);
    return;
  }

  if (separate) console.log();
  const status = recorded === "waiting"
    ? yellow(recorded)
    : recorded === "running" ? cyan(recorded) : recorded === "completed" ? green(recorded) : red(recorded);
  console.log(
    `${bold(plain(record.id))}  ${bold(cyan(plain(record.machine)))} › ${status} · ${plain(state)}${
      watched ? ` · ${dim("watched")}` : ""
    }`,
  );
  if (record.label !== undefined && plain(record.label) !== "") console.log(`  ${plain(record.label)}`);
  for (const line of details) {
    console.log(`  ${line.startsWith("request: ") || line === "answered through its host" ? dim(line) : line}`);
  }
}

function printMachineHeader(machinePath: string) {
  if (!process.stdout.isTTY) {
    console.log(`Machine: ${machinePath}`);
    return;
  }

  console.log(`${magenta("◆")} ${bold(machineName(machinePath))}`);
  console.log(`  ${dim(machinePath)}\n`);
}

interface RunStatus extends Required<Pick<RunOptions, "onState" | "onAgentUpdate" | "onHumanInput">> {
  succeed(): void;
  fail(): void;
  close(): void;
}

function createRunStatus(machinePath: string): RunStatus {
  const name = machineName(machinePath);

  if (!process.stderr.isTTY) {
    return {
      onState(state) {
        console.error(`● ${name} · ${formatState(state)}`);
      },
      onAgentUpdate(update) {
        if (update.type === "limit") console.error(update.text.replace(/\s+/gu, " "));
      },
      onHumanInput() {},
      succeed() {},
      fail() {},
      close() {},
    };
  }

  let currentState = "starting";
  let enteredAt = 0;
  let humanInputActive = false;
  let activityExpanded = false;
  let agentOutput = "";
  let agentIdentity: Partial<Extract<AgentUpdate, { type: "identity" }>> = {};
  let agentLimit = "";
  let agentWaiting = false;
  let refresh: NodeJS.Timeout | undefined;
  const tools = new Map<string, { title: string; status?: Extract<AgentUpdate, { type: "tool" }>["status"] }>();
  const hotkeysAvailable = Boolean(process.stdin.isTTY && process.stdin.setRawMode);
  const initialRawMode = process.stdin.isRaw;
  let hotkeysEnabled = false;
  const signalHandlers = new Map<NodeJS.Signals, () => void>();
  const spinner = yoctoSpinner({ handleSignals: false, stream: process.stderr });

  function runningText() {
    const hint = hotkeysAvailable
      ? ` · ${dim(activityExpanded ? "[o] hide activity" : "[o] activity")}`
      : "";
    const status = `${cyan(displayState(currentState))} · ${dim(formatElapsed(Date.now() - enteredAt))}${hint}`;
    const identity = [
      agentIdentity.harness,
      agentIdentity.model,
      agentIdentity.thinking === undefined
        ? undefined
        : `thinking ${agentIdentity.thinking}`,
    ].filter(Boolean).join(" · ");
    const width = Math.max(20, (process.stderr.columns ?? 100) - 4);
    const identityLine = identity === "" ? "" : `\n  ${dim(truncate(identity, width))}`;
    const limitLine = agentLimit === ""
      ? ""
      : `\n  ${yellow(truncate(stripVTControlCharacters(agentLimit).replace(/\s+/gu, " "), width))}`;

    return activityExpanded
      ? `${status}${identityLine}${limitLine}\n${activityText()}`
      : `${status}${identityLine}${limitLine}`;
  }

  function completedText() {
    return `${green(displayState(currentState))} · ${dim(formatElapsed(Date.now() - enteredAt))}`;
  }

  function clearRefresh() {
    if (refresh !== undefined) clearInterval(refresh);
    refresh = undefined;
  }

  function completeCurrent() {
    clearRefresh();
    if (spinner.isSpinning) spinner.success(completedText());
  }

  function activityText() {
    const toolLines = [...tools.values()].map((tool) => {
      if (tool.status === "completed") return `${green("✓")} ${tool.title}`;
      if (tool.status === "failed") return `${red("✖")} ${tool.title}`;
      if (tool.status === "in_progress") return `${cyan("…")} ${tool.title}`;
      return `${dim("·")} ${tool.title}`;
    });
    const lastNewline = agentOutput.lastIndexOf("\n");
    const completeOutput = lastNewline === -1 ? "" : agentOutput.slice(0, lastNewline);
    const outputLines = completeOutput
      .replace(/^MACHINES_EVENT .+$(?:\r?\n)?/gmu, "")
      .replace(/^New version available:.+$(?:\r?\n)?/gmu, "")
      .trim()
      .split(/\r?\n/u)
      .filter((line) => line !== "")
      .slice(-4)
      .map((line) => `${dim("│")} ${line}`);
    const lines = [...toolLines, ...outputLines].slice(-8);

    if (lines.length === 0) return dim("  Waiting for Agent activity…");

    const width = Math.max(20, (process.stderr.columns ?? 100) - 4);
    return lines
      .map((line) => `  ${truncate(stripVTControlCharacters(line), width)}`)
      .join("\n");
  }

  function render() {
    if (spinner.isSpinning) spinner.text = runningText();
  }

  function onKeypress(_character: string | undefined, key: Key) {
    if (key?.ctrl && key.name === "c") {
      disableHotkeys();
      process.kill(process.pid, "SIGINT");
      return;
    }

    if (key?.name !== "o") return;

    activityExpanded = !activityExpanded;
    render();
  }

  function enableHotkeys() {
    if (!hotkeysAvailable || hotkeysEnabled) return;

    emitKeypressEvents(process.stdin);
    process.stdin.on("keypress", onKeypress);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    hotkeysEnabled = true;
  }

  function disableHotkeys() {
    if (!hotkeysEnabled) return;

    process.stdin.off("keypress", onKeypress);
    process.stdin.setRawMode(initialRawMode ?? false);
    if (!initialRawMode) process.stdin.pause();
    hotkeysEnabled = false;
  }

  function closeHotkeys() {
    disableHotkeys();
    for (const [signal, handler] of signalHandlers) process.off(signal, handler);
    signalHandlers.clear();
  }

  if (hotkeysAvailable) {
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
      const handler = () => {
        closeHotkeys();
        process.kill(process.pid, signal);
      };
      signalHandlers.set(signal, handler);
      process.once(signal, handler);
    }
  }

  enableHotkeys();

  return {
    onAgentUpdate(update) {
      if (update.type === "identity") {
        agentIdentity = update;
      } else if (update.type === "output") {
        agentOutput = (agentOutput + update.text).slice(-32_768);
      } else if (update.type === "limit") {
        // A wait stays on screen while its presets are tried again, until one of them resumes.
        if (update.status !== "swapped") agentWaiting = update.status === "waiting";
        if (update.status !== "swapped" || !agentWaiting) agentLimit = update.text;
      } else {
        const previous = tools.get(update.id);
        tools.set(update.id, {
          title: update.title ?? previous?.title ?? "tool",
          status: update.status ?? previous?.status,
        });
      }
      render();
    },
    onHumanInput(active) {
      humanInputActive = active;

      if (active) {
        disableHotkeys();
        completeCurrent();
        process.stderr.write(`${yellow("◆")} ${yellow("input needed")}\n`);
      } else {
        enableHotkeys();
      }
    },
    onState(state) {
      if (!humanInputActive) completeCurrent();

      currentState = formatState(state);
      enteredAt = Date.now();
      agentOutput = "";
      agentIdentity = {};
      agentLimit = "";
      agentWaiting = false;
      tools.clear();

      if (humanInputActive) return;

      spinner.start(runningText());
      refresh = setInterval(() => {
        spinner.text = runningText();
      }, 1_000);
      refresh.unref();
    },
    succeed() {
      completeCurrent();
    },
    fail() {
      clearRefresh();
      const failed = `${red(displayState(currentState))} · ${dim(formatElapsed(Date.now() - enteredAt))}`;
      if (spinner.isSpinning) spinner.error(failed);
      else process.stderr.write(`${red("✖")} ${failed}\n`);
    },
    close() {
      closeHotkeys();
    },
  };
}

function formatState(state: StateValue): string {
  return typeof state === "string" ? state : JSON.stringify(state);
}

function displayState(state: string) {
  return state.replace(/([a-z0-9])([A-Z])/gu, "$1 $2").toLowerCase();
}

function truncate(text: string, width: number) {
  return text.length <= width ? text : `${text.slice(0, width - 1)}…`;
}

function machineName(machinePath: string) {
  const file = basename(machinePath);

  if (file === "index.ts") return basename(dirname(machinePath));

  return file.endsWith(".ts") ? file.slice(0, -3) : file;
}

function formatElapsed(milliseconds: number) {
  const seconds = Math.round(milliseconds / 1_000);

  if (seconds < 60) return `${seconds}s`;

  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}
