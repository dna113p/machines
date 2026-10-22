import "./environment.ts";

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { AgentUpdate } from "../src/index.ts";
import { prepareMachineRun } from "../src/launcher.ts";

export interface PriorityPreset {
  readonly name: string;
  readonly harness?: string;
  readonly fallback?: readonly string[];
  readonly limited?: boolean;
}

export const priorityPresets: readonly PriorityPreset[] = [
  { name: "boundCodex", harness: "codex", fallback: ["claudeA", "claudeB", "spareCodex"], limited: true },
  { name: "claudeA", harness: "claude", limited: true },
  { name: "claudeB", harness: "claude", limited: true },
  { name: "spareCodex", harness: "codex" },
];

/** Only the test's selected home and state directory are ever read or written. */
export async function priorityFixture(
  context: TestContext,
  presets: readonly PriorityPreset[] = priorityPresets,
) {
  const root = await mkdtemp(join(tmpdir(), "machines-provider-priority-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "project");
  const home = join(root, "home");
  const loginHome = join(root, "login-home");
  const state = join(home, "state");
  const directory = join(cwd, ".machines");
  await mkdir(directory, { recursive: true });
  await mkdir(home, { recursive: true });
  await mkdir(loginHome, { recursive: true });
  await writeFile(join(cwd, "package.json"), '{"type":"module"}\n');

  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: loginHome,
    MACHINES_USER_HOME: home,
    XDG_STATE_HOME: state,
    MACHINES_RUN_STATUS_DIR: "off",
    MACHINES_AGENT_LIMIT_WAIT_MINUTES: "0",
    TZ: "America/Denver",
  };
  delete environment.MACHINES_AGENT_PREFER;
  delete environment.MACHINES_AGENT_FALLBACK;

  // prepareMachineRun has no environment argument. Restore each changed variable after the test.
  const saved = new Map<string, string | undefined>();
  for (const key of ["MACHINES_USER_HOME", "XDG_STATE_HOME", "MACHINES_AGENT_PREFER", "MACHINES_AGENT_FALLBACK"]) {
    saved.set(key, process.env[key]);
    if (environment[key] === undefined) delete process.env[key];
    else process.env[key] = environment[key];
  }
  context.after(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  await writeFile(join(directory, "agents.ts"), [
    "export default ({ AgentLimitError }) => ({",
    ...presets.map(({ name, harness, fallback, limited }) => `${JSON.stringify(name)}: {
      description: ${JSON.stringify(`Fixture ${name}`)},
      ${harness === undefined ? "" : `harness: ${JSON.stringify(harness)},`}
      ${fallback === undefined ? "" : `fallback: ${JSON.stringify(fallback)},`}
      runner: (_request, report) => {
        report?.({ type: 'identity', harness: ${JSON.stringify(harness ?? "fixture")}, model: ${JSON.stringify(name)} });
        ${limited
          ? `throw new AgentLimitError('Fixture usage limit', { harness: ${JSON.stringify(harness ?? "fixture")}, resetsAt: ${Date.UTC(2099, 0, 1)} });`
          : `return { type: 'completed', preset: ${JSON.stringify(name)} };`}
      },
    },`),
    "});",
  ].join("\n"));
  await writeFile(join(directory, "work.ts"), `
    export const description = 'Exercises provider preference with fake Agents';
    export const agentRoles = { worker: 'Does the work' };
    export default ({ agent, final, machine }) => {
      let answer;
      const receive = ({ event }) => { answer = event; };
      return machine({ initial: 'work', output: () => answer, states: {
        work: agent('Work', {
          completed: { target: 'done', actions: receive },
        }, { using: 'worker' }),
        done: final(),
      } });
    };
  `);

  const cli = (args: readonly string[], change: NodeJS.ProcessEnv = {}, imports: readonly string[] = []) => {
    const env = { ...environment, ...change };
    for (const [key, value] of Object.entries(env)) if (value === undefined) delete env[key];
    const result = spawnSync(process.execPath, [
      ...imports.flatMap((path) => ["--import", pathToFileURL(path).href]),
      fileURLToPath(new URL("../src/cli.ts", import.meta.url)), ...args,
    ], { cwd, env, encoding: "utf8", timeout: 30_000 });
    assert.ifError(result.error);
    assert.equal(result.signal, null, `CLI terminated: ${result.stderr}`);
    return result;
  };
  const prefer = (...args: string[]) => {
    const result = cli(["prefer", ...args]);
    assert.equal(result.status, 0, result.stderr);
    return result;
  };
  const prepare = (bound = "boundCodex") => prepareMachineRun({
    cwd, home, machine: "work", agents: { worker: bound }, agentLimits: { waitMinutes: 0 },
  });
  return { root, cwd, home, loginHome, state, file: join(state, "machines", "provider-order.json"), cli, prefer, prepare };
}

export async function observePriority(prepared: Awaited<ReturnType<typeof prepareMachineRun>>) {
  const updates: AgentUpdate[] = [];
  const result = await prepared.start({ onAgentUpdate: (update) => updates.push(update) });
  return {
    result,
    updates,
    tried: updates.filter((update) => update.type === "identity").map((update) => update.model),
    swaps: updates.filter((update) => update.type === "limit").map((update) => ({
      status: update.status, agent: update.agent, to: update.to,
    })),
    attempts: updates.filter((update) => update.type === "attempt"),
  };
}
