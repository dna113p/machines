#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { emitKeypressEvents, type Key } from "node:readline";
import { stripVTControlCharacters } from "node:util";

import yoctoSpinner from "yocto-spinner";
import { bold, cyan, dim, green, magenta, red, yellow } from "yoctocolors";

import { discoverMachines, machinesUserHome } from "./discovery.ts";
import {
  type AgentPresetSummary,
  type MachineSummary,
  listAgentPresets,
  listMachines,
  prepareMachineRun,
} from "./launcher.ts";

import type { StateValue } from "xstate";
import type { AgentUpdate, RunOptions } from "./index.ts";

const [command, selector, ...argumentsAfterSelector] = process.argv.slice(2);

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
  } else {
    throw new Error([
      "Usage:",
      "  machine list",
      "  machine agents",
      "  machine show <name-or-file>",
      "  machine run <name-or-file> [--agent role=preset]... [--] [input]",
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
  const invocation = parseRunArguments(args);
  printMachineHeader(machinePath);
  const prepared = await prepareMachineRun({
    cwd: process.cwd(),
    machine: machinePath,
    input: invocation.input,
    agents: Object.fromEntries(invocation.agentOverrides),
  });
  const status = createRunStatus(machinePath);

  try {
    const result = await prepared.start({
      onAgentUpdate: status.onAgentUpdate,
      onHumanInput: status.onHumanInput,
      onState: status.onState,
    });

    status.succeed();
    console.log(`--> ${String(result.value)}`);
  } catch (cause) {
    status.fail();
    throw cause;
  } finally {
    status.close();
  }
}

function parseRunArguments(args: string[]) {
  const agentOverrides = new Map<string, string>();
  let index = 0;

  while (index < args.length) {
    const argument = args[index];
    if (argument === "--") {
      index += 1;
      break;
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

  return {
    agentOverrides,
    input: args.slice(index).join(" "),
  };
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
    ].join("\t"));
    return;
  }

  if (separate) console.log();
  console.log(bold(cyan(preset.name)));
  console.log(`  ${preset.description}`);
  if (identity.length > 0) console.log(`  ${magenta(identity.join(" · "))}`);
  console.log(`  ${dim(preset.source)}`);
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
      onAgentUpdate() {},
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
    const identityLine = identity === ""
      ? ""
      : `\n  ${dim(truncate(identity, Math.max(20, (process.stderr.columns ?? 100) - 4)))}`;

    return activityExpanded
      ? `${status}${identityLine}\n${activityText()}`
      : `${status}${identityLine}`;
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
