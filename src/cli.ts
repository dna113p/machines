#!/usr/bin/env node
import { launcherLimitMemory, readLimits, forgetLimits, limitCovers, type RememberedLimit } from "./agent-limits.ts";
import { humanChoiceLabel } from "./human-request.ts";

import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { emitKeypressEvents, type Key } from "node:readline";
import { inspect, stripVTControlCharacters } from "node:util";
import { fileURLToPath } from "node:url";

import yoctoSpinner from "yocto-spinner";
import { blue, bold, cyan, dim, green, magenta, red, yellow } from "yoctocolors";

import { assertJsonValue, isJsonValue, type JsonValue } from "./json.ts";
import { discoverMachines, machinesUserHome } from "./discovery.ts";
import {
  clearProviderOrder, effectiveProviderOrder, providerOrderExpired, providerOrderUntil,
  readProviderOrder, sortProviderCandidates, writeProviderOrder,
} from "./provider-order.ts";
import { runEnding } from "./endings.ts";
import {
  type AgentPresetSummary,
  type MachineSummary,
  listAgentPresets,
  listMachines,
  prepareMachineRun,
} from "./launcher.ts";
import { claimContinuation, RunNotAnsweredError, RunNotDueError, type Continuation } from "./run-checkpoint.ts";
import { inboxHuman, respondToRun } from "./run-inbox.ts";
import {
  createRunStatusPublisher,
  isProcessAlive,
  readRunStatuses,
  runOutputSummary,
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
import { runSleep, runsForViewer, type ViewerRun } from "./run-viewer.ts";
import { startRunUi, uiProjectDir } from "./run-ui.ts";

import type { StateValue } from "xstate";
import type { AgentUpdate, RunOptions } from "./index.ts";

const [command, selector, ...argumentsAfterSelector] = process.argv.slice(2);
const runsOptions = selector === undefined ? [] : [selector, ...argumentsAfterSelector];
const watchUsage = "machine watch [<run-id-or-label-start> | --dir <path>]";
const unwatchUsage = "machine unwatch <run-id-or-label-start> | --dir <path> | --all";
const watchForUsage = "machine watch --for <session> [<run-id-or-label-start> | --dir <path>]";
const unwatchForUsage = "machine unwatch --for <session> <run-id-or-label-start> | --dir <path> | --all";
const uiUsage = "machine ui [--port <port>] [--project <dir>]";

try {
  const listing = command === "runs" ? parseRunsOptions(runsOptions) : undefined;
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
    const limits = await readLimits(launcherLimitMemory());
    let order = await effectiveProviderOrder();
    const preference = process.env.MACHINES_AGENT_PREFER === undefined ? await readProviderOrder() : undefined;
    if (preference?.above !== undefined) {
      const reading = preferredSummary(presets, preference.order)?.quota;
      if (reading !== undefined && reading.remaining <= preference.above) order = [];
    }
    if (order.length > 0) console.log(`Provider order: ${order.join(", ")}`);
    const byName = new Map(presets.map((preset) => [preset.name, preset]));
    presets.forEach((preset, index) => {
      const names = process.env.MACHINES_AGENT_FALLBACK === "off" ? [] : preset.fallback ?? [];
      const chain = sortProviderCandidates([preset, ...names.map((name) => byName.get(name) ?? { name, harness: undefined })], order);
      printAgentListing(order.length === 0 ? preset : {
        ...preset, fallback: chain.map((candidate) => candidate.name),
      }, index > 0, order.length > 0 && preset.harness === order[0], limits.find((entry) => limitCovers(entry, preset)));
    });
  } else if (command === "prefer") {
    await prefer(runsOptions);
  } else if (command === "limits") {
    const memory = launcherLimitMemory();
    if (selector === "--forget" && argumentsAfterSelector.length === 1 && argumentsAfterSelector[0]?.trim()) {
      await forgetLimits(memory, argumentsAfterSelector[0]);
    } else if (selector === "--forget-all" && argumentsAfterSelector.length === 0) {
      await forgetLimits(memory);
    } else if (selector !== undefined) {
      throw new Error("Usage: machine limits [--forget <preset> | --forget-all]");
    }
    const limits = await readLimits(memory);
    if (limits.length === 0) console.log("No usage limits remembered.");
    else {
      console.log("Preset\tHarness\tKind\tScope\tReset or next probe\tRun\tSource");
      for (const entry of limits) console.log([
        entry.preset, entry.harness ?? entry.limit.harness, entry.limit.kind ?? "unknown", entry.scope,
        `${entry.known ? "reset" : "next probe"} ${new Date(entry.until).toISOString()}`, entry.run, entry.limit.quota === undefined ? "turn" : `quota reading: ${entry.limit.quota.remaining}% left, reserve ${entry.limit.reserve ?? 0}%`,
      ].map(plain).join("\t"));
    }
  } else if (command === "show" && selector !== undefined) {
    const machinePath = await resolveMachine(selector);
    console.log(`Machine: ${machinePath}`);
    console.log(await readFile(machinePath, "utf8"));
  } else if (command === "run" && selector !== undefined) {
    await runMachine(await resolveMachine(selector), argumentsAfterSelector);
  } else if (command === "continue" && selector === "--due" && argumentsAfterSelector.length === 0) {
    continueDueRuns();
  } else if (command === "continue" && selector !== undefined && argumentsAfterSelector.length === 0) {
    const continuation = claimContinuation(selector);
    try {
      process.chdir(continuation.checkpoint.cwd);
      await runMachine(continuation.checkpoint.machine.path, [], continuation);
    } finally { continuation.release(); }
  } else if (listing !== undefined) {
    if (listing.viewer === undefined) listRuns(listing.json, listing.all);
    else listViewerRuns(listing.json, listing.all, listing.viewer);
  } else if (command === "respond" && selector !== undefined) {
    await respond([selector, ...argumentsAfterSelector]);
  } else if (command === "watch") {
    watch(selector === undefined ? [] : [selector, ...argumentsAfterSelector]);
  } else if (command === "unwatch" && selector !== undefined) {
    unwatch([selector, ...argumentsAfterSelector]);
  } else if (command === "ui") {
    await ui(selector === undefined ? [] : [selector, ...argumentsAfterSelector]);
  } else {
    throw new Error([
      "Usage:",
      "  machine list",
      "  machine agents",
      "  machine prefer [<harness>...] [--until <ISO-time|HH:MM>] [--above <percent>] | --clear",
      "  machine limits [--forget <preset> | --forget-all]",
      "  machine show <name-or-file>",
      "  machine run <name-or-file> [--sleep] [--agent role=preset]... [--input-file <file|->] [--] [input]",
      "  machine continue <run-id>",
      "  machine continue --due",
      "  machine runs [--json] [--all]",
      "  machine runs --for [<session>] [--project <dir>] [--json] [--all]",
      "  machine respond [--question] <run-id> <request-id> [--] <response>",
      `  ${watchUsage}`,
      `  ${unwatchUsage}`,
      `  ${watchForUsage}`,
      `  ${unwatchForUsage}`,
      `  ${uiUsage}`,
    ].join("\n"));
  }
} catch (cause) {
  if (command === "continue" && cause instanceof RunNotDueError) {
    console.log(`Run ${selector} is not due until ${cause.due}.`);
  } else if (command === "continue" && cause instanceof RunNotAnsweredError) {
    const { human } = cause;
    if (human.headline !== undefined) console.log(human.headline);
    console.log(`Run ${selector} is waiting for an answer to: ${human.prompt}`);
    if (human.choices !== undefined) console.log(`Choices: ${human.choices.map(choice => humanChoiceLabel(human, choice)).join(", ")}`);
    if (human.suggestions !== undefined) console.log(`Suggestions: ${human.suggestions.map(suggestion => humanChoiceLabel(human, suggestion)).join(", ")}`);
    console.log(`Answer with: machine respond ${selector} ${human.requestId} <response>`);
    console.log(`Then wake it with: machine continue ${selector}`);
  } else {
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exitCode = 1;
  }
}

async function prefer(args: readonly string[]): Promise<void> {
  if (args.includes("--clear")) {
    if (args.length !== 1) throw new Error("machine prefer --clear takes no other arguments");
    await clearProviderOrder();
    console.log("Provider preference cleared.");
    return;
  }
  const order: string[] = [];
  let until: string | undefined;
  let above: number | undefined;
  let presets: readonly AgentPresetSummary[] | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--until") {
      const value = args[++index];
      if (until !== undefined || value === undefined) throw new Error("--until needs one ISO time or HH:MM");
      until = providerOrderUntil(value);
    } else if (arg === "--above") {
      const value = args[++index];
      if (above !== undefined || value === undefined || value.trim() === "" || !Number.isFinite(Number(value))
        || Number(value) < 0 || Number(value) > 100) throw new Error("--above needs one percent from 0 to 100");
      above = Number(value);
    } else if (arg.startsWith("-") || arg.trim() === "") {
      throw new Error(`Unknown machine prefer argument: ${arg}`);
    } else order.push(arg);
  }
  if (args.length > 0) {
    if (order.length === 0) throw new Error("machine prefer --until or --above requires at least one harness");
    presets = await listAgentPresets({ cwd: process.cwd() });
    for (const harness of new Set(order)) {
      if (!presets.some((preset) => preset.harness === harness)) {
        console.error(`Warning: no configured preset in this workspace has harness "${harness}".`);
      }
    }
    await writeProviderOrder({ order, ...(until === undefined ? {} : { until }), ...(above === undefined ? {} : { above }) });
  }
  const preference = await readProviderOrder();
  const override = process.env.MACHINES_AGENT_PREFER;
  if (preference !== undefined) {
    let condition = "";
    let released = false;
    if (preference.above !== undefined) {
      presets ??= await listAgentPresets({ cwd: process.cwd() });
      const selected = preferredSummary(presets, preference.order);
      released = selected?.quota !== undefined && selected.quota.remaining <= preference.above;
      condition = `; above ${preference.above}%; ` + (selected?.quota === undefined
        ? `condition cannot be checked${selected === undefined ? ": no quota hook" : ` (${selected.name}: ${selected.quotaError})`}`
        : `${selected.name}: ${quotaText(selected)}`);
    }
    const status = providerOrderExpired(preference) ? "expired" : override !== undefined
      ? "overridden by MACHINES_AGENT_PREFER" : released ? "released by quota condition" : "in effect";
    console.log(plain(`Provider order: ${preference.order.join(", ")}; until ${preference.until ?? "cleared"}${condition}; ${status}.`));
  }
  if (override !== undefined) {
    const effective = await effectiveProviderOrder();
    console.log(effective.length === 0 ? "No provider preference."
      : `Provider order (MACHINES_AGENT_PREFER): ${effective.join(", ")}; no expiry; in effect.`);
  } else if (preference === undefined) console.log("No provider preference.");
}

function continueDueRuns(): void {
  const now = Date.now();
  const due = readRunStatuses(requireStatusDirectory()).filter((record) =>
    record.status === "sleeping" && record.continuedBy !== "host"
    && (record.human ? record.human.answer !== undefined : record.due !== undefined && Date.parse(record.due) <= now),
  ).sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
  if (due.length === 0) console.log("No sleeping runs are due.");
  const failures: string[] = [];
  for (const run of due) {
    console.log(`Continuing run ${run.id}`);
    const child = spawnSync(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), "continue", run.id], { stdio: "inherit" });
    if (child.error) failures.push(`Run ${run.id} failed (${child.error.message})`);
    else if (child.signal) failures.push(`Run ${run.id} failed (signal ${child.signal})`);
    else if (child.status !== 0) failures.push(`Run ${run.id} failed (exit ${String(child.status)})`);
  }
  if (failures.length > 0) {
    failures.forEach((failure) => console.error(failure));
    process.exitCode = 1;
  }
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

async function runMachine(machinePath: string, args: string[], continuation?: Continuation) {
  const invocation = continuation ? {
    input: continuation.checkpoint.input,
    agentOverrides: new Map(Object.entries(continuation.checkpoint.agents)),
    sleep: continuation.checkpoint.sleep === true,
  } : await parseRunArguments(args);
  if (invocation.sleep) requireStatusDirectory();
  printMachineHeader(machinePath);
  const prepared = await prepareMachineRun({
    cwd: process.cwd(),
    machine: machinePath,
    input: invocation.input,
    agents: Object.fromEntries(invocation.agentOverrides),
    ...(continuation ? { home: continuation.checkpoint.home, continueRun: continuation.checkpoint } : {}),
  });
  const status = createRunStatus(machinePath);
  const runId = continuation?.record.id ?? randomUUID();
  const published = createRunStatusPublisher({
    id: runId,
    ...(continuation ? { continueRun: continuation } : {}),
    machine: prepared.name,
    path: prepared.path,
    cwd: process.cwd(),
    ...(prepared.graph === undefined ? {} : { graph: prepared.graph }),
  }, continuation ? { ...process.env, MACHINES_RUN_STATUS_DIR: continuation.directory } : process.env);
  const statusDirectory = published.directory;
  if (continuation && statusDirectory === undefined) throw new Error("Cannot continue: could not publish the run status");
  if (invocation.sleep && statusDirectory === undefined) throw new Error("Cannot sleep: could not publish the run status");
  continuation?.release();
  if (continuation?.machineChanged) console.error("Continuing on a changed Machine file.");
  // Machines started by this run's Operations and Agents are its sub-runs.
  process.env.MACHINES_RUN_PARENT = runId;
  const observed = runStatusObserver((change) => published.update(change));
  let sleptUntil: string | undefined;
  let sleptForAnswer: string | undefined;

  try {
    const result = await prepared.start({
      ...(statusDirectory === undefined ? {} : { checkpoint: { directory: statusDirectory, id: runId, sleep: invocation.sleep } }),
      ...(continuation?.answer === undefined ? {} : { answer: continuation.answer }),
      ...(invocation.sleep ? { onSleep(due: string) {
        published.sleep(due);
        sleptUntil = due;
      }, onHumanSleep(request) {
        const requestId = randomUUID();
        published.sleepForAnswer({ ...request, requestId });
        sleptForAnswer = requestId;
      } } : {}),
      onStatus(change) {
        published.update({
          ...(change.now === undefined ? {} : { now: change.now ?? undefined }),
          ...(change.note === undefined ? {} : { note: change.note, page: change.page }),
        });
      },
      onEnter(entry) { observed.onEnter(entry); },
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
      onGraph(graph) { published.update({ graph }); },
      onState(state) {
        observed.onState(state);
        status.onState(state);
      },
    });

    if (sleptForAnswer !== undefined) {
      console.log(`--> sleeping in ${formatState(result.value)} for an answer. Answer with: machine respond ${runId} ${sleptForAnswer} <response>`);
      console.log(`Then wake it with: machine continue ${runId}`);
      return;
    }
    if (sleptUntil !== undefined) {
      console.log(`--> sleeping in ${formatState(result.value)} until ${sleptUntil}. Continue with: machine continue ${runId}`);
      return;
    }
    const ending = runEnding(prepared.endings, result.value);
    published.finish({ state: result.value, note: runOutputSummary(result.output), ...(ending === undefined ? {} : { ending }) });
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
    const now = Date.now();
    console.log(JSON.stringify(runs.map((record) => {
      const sleep = runSleep(record, now);
      return sleep === undefined ? record : { ...record, sleep };
    }), null, 2));
    return;
  }
  if (runs.length === 0) console.log(all ? "No Machine runs are published." : "No Machine runs are running, waiting or sleeping.");
  const session = runSessionId();
  const watches = session === undefined ? [] : readRunWatches(directory, session);
  runs.forEach((record, index) => {
    printRunListing(record, index > 0, watches.some((watched) => runWatchMatches(watched, record)));
  });
}

/** A viewer named with `--for`: a session, or this process's own, and the project directory it works in. */
interface NamedViewer {
  readonly session?: string;
  readonly project?: string;
}

/** What `machine runs` was asked; undefined when the options are not ones it takes. */
function parseRunsOptions(args: readonly string[]) {
  let json = false;
  let all = false;
  let forViewer = false;
  let session: string | undefined;
  let project: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    const next = args[index + 1];
    // What follows an option is its value unless it is another option.
    const value = next === undefined || next.startsWith("--") ? undefined : next;
    if (option === "--json" && !json) json = true;
    else if (option === "--all" && !all) all = true;
    else if (option === "--for" && !forViewer) {
      forViewer = true;
      // Without a session id the viewer is this process's own session.
      session = value;
      if (value !== undefined) index += 1;
    } else if (option === "--project" && project === undefined && value !== undefined) {
      project = value;
      index += 1;
    } else return undefined;
  }
  // A project is a viewer's: without --for the listing is of every session and project.
  if (!forViewer) return project === undefined ? { json, all } : undefined;
  const viewer: NamedViewer = { ...(session === undefined ? {} : { session }), ...(project === undefined ? {} : { project }) };
  return { json, all, viewer };
}

/** The runs one viewer shows, by the rule its status line applies. */
function listViewerRuns(json: boolean, all: boolean, viewer: NamedViewer) {
  if (viewer.project === "") throw new Error("Expected a directory after --project");
  const { directory, session } = requireWatchList(viewer.session);
  const watches = readRunWatches(directory, session);
  // As they are read, not by start time: runs updated in the same millisecond
  // keep that order, here as in the library and on the status line.
  const runs = runsForViewer(readRunStatuses(directory), {
    sessionId: session,
    // Compared absolute, wherever the command ran and however the path was written.
    ...(viewer.project === undefined ? {} : { projectDir: resolve(viewer.project) }),
    watches,
  }, { all });
  if (json) {
    console.log(JSON.stringify(runs, null, 2));
    return;
  }
  if (runs.length === 0) console.log(`Session ${session} shows no Machine runs.`);
  runs.forEach((run, index) => {
    printRunListing(run, index > 0, watches.some((watched) => runWatchMatches(watched, run)));
  });
}

/** Every record in the directory, including runs that finished or lost their process and are still recorded. */
function publishedRuns(directory: string) {
  return readRunStatuses(directory).sort((left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt));
}

/** A run that stopped reporting without finishing has lost its process, as on the status line. */
function runStatus(record: RunStatusRecord | ViewerRun) {
  // A viewer's run already has the status its process leaves it.
  if ("shown" in record) return record.status;
  return (record.status === "running" || record.status === "waiting") && !isProcessAlive(record.pid) ? "lost" : record.status;
}

function isActiveRun(record: RunStatusRecord) {
  const status = runStatus(record);
  return status === "running" || status === "waiting" || status === "sleeping";
}

function watch(given: string[]) {
  const { named, args, usage, who } = watchSession(given, watchUsage, watchForUsage);
  const { directory, session } = requireWatchList(named);
  const watches = readRunWatches(directory, session);
  const runs = publishedRuns(directory);
  if (args.length === 0) {
    if (watches.length === 0) console.log(`${who} watches no other runs.`);
    for (const watched of watches) {
      console.log(describeWatch(watched));
      printWatchedRuns(watched, runs);
    }
    return;
  }
  const added = parseWatch(args, usage);
  if (!watches.some((watched) => sameRunWatch(watched, added))) writeRunWatches(directory, session, [...watches, added]);
  console.log(`Watching ${describeWatch(added)}`);
  printWatchedRuns(added, runs);
}

function unwatch(given: string[]) {
  const { named, args, usage, who } = watchSession(given, unwatchUsage, unwatchForUsage);
  if (args.length === 0) throw new Error(`Usage: ${usage}`);
  const { directory, session } = requireWatchList(named);
  if (args[0] === "--all") {
    if (args.length !== 1) throw new Error(`Usage: ${usage}`);
    writeRunWatches(directory, session, []);
    console.log(`${who} watches no other runs.`);
    return;
  }
  const removed = parseWatch(args, usage);
  const watches = readRunWatches(directory, session);
  const kept = watches.filter((watched) => !sameRunWatch(watched, removed));
  if (kept.length === watches.length) {
    console.log(`${who} was not watching ${describeWatch(removed)}`);
    return;
  }
  writeRunWatches(directory, session, kept);
  console.log(`No longer watching ${describeWatch(removed)}`);
}

/**
 * Takes a leading `--for <session>` from what `machine watch` and
 * `machine unwatch` were given: the list to change is then that session's and
 * not this process's own.
 */
function watchSession(given: string[], usage: string, forUsage: string) {
  if (given[0] !== "--for") return { named: undefined, args: given, usage, who: "This session" };
  const named = given[1];
  if (named === undefined || named.startsWith("--")) throw new Error(`Usage: ${forUsage}`);
  return { named, args: given.slice(2), usage: forUsage, who: `Session ${named}` };
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
  for (const record of matched) {
    console.log(`  ${runColumns(record).join("\t")}`);
    const note = finishedRunNote(record);
    if (note !== undefined) console.log(`    ${note}`);
  }
}

/** The session whose watch list is read or changed, this process's own unless one is named, and where the list is kept. */
function requireWatchList(named?: string) {
  const directory = requireStatusDirectory();
  const session = named ?? runSessionId();
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
  const result = await respondToRun({
    directory: requireStatusDirectory(),
    runId,
    requestId,
    response: question ? { type: "question", text } : text,
  });
  console.log(result === "recorded"
    ? `Recorded the answer; run ${runId} is still sleeping. Wake it with: machine continue ${runId}`
    : `Machine run ${runId} took the ${question ? "question" : "response"}.`);
}

/** Serves the live page of published runs until interrupted. */
async function ui(args: string[]) {
  let port: number | undefined;
  let project: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const value = args[index + 1];
    if (argument === "--port" && value !== undefined && /^\d+$/u.test(value) && Number(value) <= 65_535) port = Number(value);
    else if (argument === "--project" && value !== undefined) project = resolve(value);
    else throw new Error(`Usage: ${uiUsage}`);
    index += 1;
  }
  const page = await startRunUi({
    directory: requireStatusDirectory(),
    projectDir: project ?? uiProjectDir(process.cwd()),
    ...(port === undefined ? {} : { port }),
  });
  console.log(`Machines UI: ${page.url}`);
  console.log("Press Ctrl-C to stop.");
  await new Promise<void>((resolveStop) => {
    const stop = () => resolveStop();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  await page.close();
}

function requireStatusDirectory() {
  const directory = runStatusDirectory();
  if (directory === undefined) {
    // Unset, the variable leaves publication on, so only a home that cannot hold the standard directory turns it off.
    throw new Error(process.env.MACHINES_RUN_STATUS_DIR === undefined
      ? "Run status publication is off: there is no absolute home directory to keep the standard directory in. Set MACHINES_RUN_STATUS_DIR to the directory the runs publish to."
      : "Run status publication is off: unset MACHINES_RUN_STATUS_DIR to use the standard directory, or set it to the directory the runs publish to.");
  }
  return directory;
}

async function parseRunArguments(args: string[]) {
  let inputFile: string | undefined;
  let sleep = false;
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
    if (argument === "--sleep") {
      sleep = true;
      index += 1;
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
  return { agentOverrides, input, sleep };
}

function printMachineListing(found: MachineSummary, separate: boolean) {
  if (!process.stdout.isTTY) {
    if (found.error !== undefined) console.error(found.error);
    const readiness = found.error !== undefined ? "invalid" : found.missingAgents.length === 0
      ? "ready"
      : `missing Agents: ${found.missingAgents.join(", ")}`;
    console.log(`${found.name}\t${found.description}\t${found.path}\t${readiness}`);
    for (const ending of found.endings ?? []) console.log(`  ${ending.name} (${ending.kind})`);
    return;
  }

  if (separate) console.log();
  console.log(bold(cyan(found.name)));
  console.log(`  ${found.description}`);
  console.log(`  ${dim(found.path)}`);
  if (found.endings?.length) console.log(`  endings: ${found.endings.map((ending) => `${ending.name} (${ending.kind})`).join(", ")}`);
  if (found.error !== undefined) console.log(`  ${red(found.error)}`);
  if (found.missingAgents.length > 0) {
    console.log(`  ${yellow(`missing Agents: ${found.missingAgents.join(", ")}`)}`);
  }
}

function printAgentListing(preset: AgentPresetSummary, separate: boolean, preferred = false, limit?: RememberedLimit) {
  const remembered = limit === undefined ? undefined : plain(
    `usage limit: ${limit.preset} (${limit.limit.kind ?? "unknown"}, ${limit.scope}; ${limit.known ? "reset" : "next probe"} ${new Date(limit.until).toISOString()})`,
  );
  const quota = quotaText(preset);
  const identity = [preset.harness, preset.model, preset.thinking].filter(Boolean);
  if (!process.stdout.isTTY) {
    console.log([
      preset.name,
      preset.description + (preferred ? " (preferred)" : ""),
      preset.harness ?? "",
      preset.model ?? "",
      preset.thinking ?? "",
      preset.source,
      preset.fallback?.join(", ") ?? "",
      ...(remembered === undefined ? [] : [remembered]),
      ...(quota === "" ? [] : [quota]),
    ].join("\t"));
    return;
  }

  if (separate) console.log();
  console.log(bold(cyan(preset.name)) + (preferred ? " (preferred)" : ""));
  console.log(`  ${preset.description}`);
  if (identity.length > 0) console.log(`  ${magenta(identity.join(" · "))}`);
  if (preset.fallback !== undefined) console.log(`  fallback: ${preset.fallback.join(", ") || "none"}`);
  if (remembered !== undefined) console.log(`  ${yellow(remembered)}`);
  if (quota !== "") console.log(`  ${quota}`);
  console.log(`  ${dim(preset.source)}`);
}

function preferredSummary(presets: readonly AgentPresetSummary[], order: readonly string[]) {
  return presets.filter((preset) => preset.harness === order[0] && preset.hasQuota)
    .sort((a, b) => (a.configurationIndex ?? Infinity) - (b.configurationIndex ?? Infinity))[0];
}

function quotaText(preset: AgentPresetSummary): string {
  const reserve = preset.reserve ?? (preset.hasQuota ? 0 : undefined);
  return plain([
    reserve === undefined ? "" : `reserve ${reserve}%`,
    preset.quota === undefined
      ? preset.hasQuota ? `quota unavailable: ${preset.quotaError}` : ""
      : `${preset.quota.kind ?? "usage"} ${preset.quota.remaining}% left${preset.quota.resetsAt === undefined ? "" : `, resets ${new Date(preset.quota.resetsAt).toISOString()}`}`,
  ].filter(Boolean).join("; "));
}

/** Recorded text must not be able to move the cursor or restyle the terminal. */
function plain(text: string) {
  // oxlint-disable-next-line no-control-regex -- control characters are what this removes.
  return text.replace(/[\u0000-\u001f\u007f-\u009f]+/gu, " ").trim();
}

/** A run as tab-separated columns: its label follows the four that were always there. */
function runColumns(record: RunStatusRecord | ViewerRun) {
  const label = record.label === undefined ? "" : plain(record.label);
  return [record.id, record.machine, runStatus(record), record.now ?? record.state ?? "starting"].map(plain).concat(label === "" ? [] : [label]);
}

function finishedRunNote(record: RunStatusRecord | ViewerRun): string | undefined {
  if (record.status !== "completed" && record.status !== "failed") return undefined;
  const note = record.note?.split(/\r?\n/u).map(plain).find((line) => line !== "");
  return note === undefined ? undefined : note + (record.page === undefined ? "" : " (page)");
}

function printRunListing(record: RunStatusRecord | ViewerRun, separate: boolean, watched: boolean) {
  const state = record.now ?? record.state ?? "starting";
  const recorded = runStatus(record);
  const sleep = runSleep(record);
  const human = recorded === "waiting" || sleep?.for === "answer" ? record.human : undefined;
  // A run that finished or lost its process is no longer waiting for anything.
  const limit = recorded === "running" || recorded === "waiting" ? record.limit : undefined;
  const details = human === undefined ? (limit === undefined ? [] : [plain(limit.text)]) : [
    ...(human.headline === undefined ? [] : [plain(human.headline)]),
    ...human.prompt.split("\n").map(plain).filter((line) => line !== ""),
    ...(human.requestId === undefined ? [] : [`request: ${plain(human.requestId)}`]),
    ...(record.answeredBy === "host" ? ["answered through its host"] : []),
    ...(human.choices === undefined ? [] : [`choices: ${human.choices.map(choice => plain(humanChoiceLabel(human, choice))).join(", ")}`]),
    ...(human.suggestions === undefined ? [] : [`suggestions: ${human.suggestions.map(suggestion => plain(humanChoiceLabel(human, suggestion))).join(", ")}`]),
    ...(human.discussion === true && recorded === "waiting" ? ["discussion: questions allowed"] : []),
  ];
  if ((recorded === "running" || recorded === "waiting") && record.attempt) details.push(plain(record.attempt.text));
  if (record.retry) details.push(`retry: attempt ${record.retry.attempt} of ${record.retry.of}, due ${plain(record.retry.due)}`);
  if (sleep?.for === "time") details.push(`due: ${plain(sleep.due)}${sleep.isDue ? " (due now)" : ""}`);
  if (sleep?.for === "answer") {
    details.push(sleep.answered
      ? `answered; wakes with ${record.continuedBy === "host" ? "its host" : `machine continue ${plain(record.id)}`}`
      : `answer with: machine respond ${plain(record.id)} ${plain(sleep.requestId)} <response>`);
  }
  const note = finishedRunNote(record);
  if (note !== undefined) details.push(note);

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
    : recorded === "sleeping" ? blue(recorded) : recorded === "running" ? cyan(recorded) : recorded === "completed" ? green(recorded) : red(recorded);
  console.log(
    `${bold(plain(record.id))}  ${bold(cyan(plain(record.machine)))} › ${status} · ${plain(state)}${
      watched ? ` · ${dim("watched")}` : ""
    }`,
  );
  if (record.label !== undefined && plain(record.label) !== "") console.log(`  ${plain(record.label)}`);
  for (const line of details) {
    console.log(`  ${line.startsWith("request: ") || line.startsWith("answered;") || line === "answered through its host" ? dim(line) : line}`);
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
        if (update.type === "limit" || update.type === "attempt") console.error(update.text.replace(/\s+/gu, " "));
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
  let agentAttempt = "";
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

    const attemptLine = agentAttempt === "" ? "" : `\n  ${dim(truncate(stripVTControlCharacters(agentAttempt).replace(/\s+/gu, " "), width))}`;
    return activityExpanded
      ? `${status}${identityLine}${attemptLine}${limitLine}\n${activityText()}`
      : `${status}${identityLine}${attemptLine}${limitLine}`;
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
      } else if (update.type === "attempt") {
        agentAttempt = update.text;
        agentIdentity = {};
        agentOutput = "";
        agentLimit = "";
        agentWaiting = false;
        tools.clear();
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
      agentAttempt = "";
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
