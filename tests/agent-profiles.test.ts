import "./environment.ts";
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import {
  activateAgentProfile, clearAgentProfile, configureAgentTuning, listAgentPresets,
  prepareMachineRun, readActiveAgentProfile, readAgentProfiles, withAgentTuning,
  type AgentProfile,
} from "../src/launcher.ts";
import { codexAgent } from "../src/codex.ts";
import { claudeAgent } from "../src/claude.ts";
import { writeProviderOrder } from "../src/provider-order.ts";
import type { AgentUpdate, AgentRunner, JsonValue } from "../src/index.ts";
import { observePriority, priorityFixture } from "./provider-test-fixture.ts";

let originalEnvironment: (readonly [string, string | undefined])[] = [];
beforeEach(() => {
  const keys = ["CODEX_MODEL", "CODEX_EFFORT", "CODEX_SERVICE_TIER", "MACHINES_AGENT_MODEL", "MACHINES_AGENT_EFFORT", "MACHINES_CLAUDE_MODEL", "MACHINES_CLAUDE_EFFORT"];
  originalEnvironment = keys.map((key) => [key, process.env[key]] as const);
  for (const key of keys) delete process.env[key];
});
afterEach(() => {
  for (const [key, value] of originalEnvironment) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

const deadline = "2099-01-01T00:00:00.000Z";
const fake = resolve("tests/fixtures/fake-codex-agent.mjs");
const request = { prompt: "Task", outcomes: ["completed"], cwd: process.cwd() };
const burn: AgentProfile = { order: ["codex"], allowedProviders: ["codex"] };

async function definitions(fixture: Awaited<ReturnType<typeof priorityFixture>>, value: unknown) {
  await writeFile(join(fixture.cwd, ".machines", "profiles.json"), JSON.stringify(value));
}

async function codexPreset(fixture: Awaited<ReturnType<typeof priorityFixture>>, mode = "arguments") {
  const machineFile = join(fixture.cwd, ".machines", "work.ts");
  await writeFile(machineFile, (await readFile(machineFile, "utf8")).replace("{ using: 'worker' }", `{ using: 'worker', cwd: ${JSON.stringify(fixture.cwd)} }`));
  await writeFile(join(fixture.cwd, ".machines", "agents.ts"), `
    export default ({codexAgent}) => ({
      worker: { description: 'Fake Codex', harness: 'codex', model: 'label-only',
        runner: codexAgent(${JSON.stringify(process.execPath)}, ${JSON.stringify([fake, mode])}, {
          model: 'original', effort: 'medium', sandbox: 'workspace-write', output: 'capture',
          skipGitRepoCheck: true, ephemeral: false, env: { CODEX_MODEL: 'env-original' },
          harness: 'codex',
        }), fallback: ['spare'] },
      spare: { description: 'Other provider', harness: 'other', runner: () => ({type: 'completed', provider: 'other'}) },
    });
  `);
}

test("CLI defines reusable profiles, snapshots activation atomically, inspects and clears without touching prefer", async (context) => {
  const fixture = await priorityFixture(context);
  await codexPreset(fixture);
  const profile = { ...burn, overrides: [{ preset: "worker", model: "gpt-test", options: { serviceTier: "fast", effort: "high" } }] };
  await definitions(fixture, { "burn-codex": profile });
  fixture.prefer("claude", "--above", "30");
  const preferBefore = await readFile(fixture.file, "utf8");
  const run = (...args: string[]) => {
    const result = fixture.cli(["profile", ...args]);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  assert.match(run("list"), /burn-codex/u);
  assert.match(run("show", "burn-codex"), /gpt-test/u);
  assert.match(run("use", "burn-codex", "--until", deadline), /in effect/u);
  assert.deepEqual(await readActiveAgentProfile(fixture.home), { name: "burn-codex", until: deadline, profile });
  const stateFile = join(fixture.state, "machines", "agent-profile.json");
  assert.equal((await stat(stateFile)).mode & 0o777, 0o600);
  assert.deepEqual((await readdir(join(fixture.state, "machines"))).sort(), ["agent-profile.json", "provider-order.json"]);
  await definitions(fixture, { "burn-codex": {} });
  assert.deepEqual((await readActiveAgentProfile(fixture.home))?.profile, profile, "activation holds its definition snapshot");
  const listing = fixture.cli(["agents"]);
  assert.equal(listing.status, 0, listing.stderr);
  assert.match(listing.stdout, /Profile:.*burn-codex.*allowedProviders.*fast/u);
  assert.match(listing.stdout, /worker\t.*codex\tgpt-test\thigh/u);
  assert.match(listing.stdout, /excluded by profile/u);
  assert.match(run("clear"), /deactivated/u);
  assert.equal(await readActiveAgentProfile(fixture.home), undefined);
  assert.equal(await readFile(fixture.file, "utf8"), preferBefore);
  assert.match(run("list"), /burn-codex/u);
  assert.match(run("show"), /No active profile/u);
  assert.match(run("use", "burn-codex", "--until", "23:59"), /in effect/u);
});

test("profile definitions use nearest project replacement and alternate home state resolution", async (context) => {
  const fixture = await priorityFixture(context);
  await mkdir(join(fixture.home, ".machines"));
  await writeFile(join(fixture.home, ".machines", "profiles.json"), JSON.stringify({ shared: burn, global: {} }));
  await definitions(fixture, { shared: { order: ["claude"] } });
  assert.deepEqual({ ...await readAgentProfiles(fixture.cwd, fixture.home) }, { shared: { order: ["claude"] }, global: {} });
  const result = fixture.cli(["profile", "use", "shared", "--until", deadline], { XDG_STATE_HOME: undefined });
  assert.equal(result.status, 0, result.stderr);
  const value = JSON.parse(await readFile(join(fixture.home, ".local", "state", "machines", "agent-profile.json"), "utf8"));
  assert.equal(value.name, "shared");
});

test("filtering is independent of stable preference order and cannot add presets outside a chain", async (context) => {
  const fixture = await priorityFixture(context, [
    { name: "boundCodex", harness: "codex", fallback: ["other", "allowedSecond", "allowedThird"] },
    { name: "other", harness: "claude" },
    { name: "allowedSecond", harness: "deepseek" },
    { name: "allowedThird", harness: "deepseek" },
    { name: "outsider", harness: "api-account" },
  ]);
  await activateAgentProfile("priority", { order: ["api-account", "deepseek"], allowedProviders: ["deepseek", "api-account"] }, deadline, fixture.home);
  const observed = await observePriority(await fixture.prepare());
  assert.deepEqual(observed.tried, ["allowedSecond"]);
  assert.equal(observed.result.output.preset, "allowedSecond");
  assert.deepEqual((await fixture.prepare()).profile?.profile.allowedProviders, ["deepseek", "api-account"]);
  await activateAgentProfile("empty", { allowedProviders: ["api-account"] }, deadline, fixture.home);
  await assert.rejects(fixture.prepare(), /role "worker" has no allowed preset.*configured chain/u);
  await activateAgentProfile("empty", { allowedProviders: [] }, deadline, fixture.home);
  await assert.rejects(fixture.prepare(), /no allowed preset/u);
});

test("fallback off and onLimit cannot bypass a strict filter", async (context) => {
  const fixture = await priorityFixture(context, [
    { name: "boundCodex", harness: "codex", fallback: ["allowed"] },
    { name: "allowed", harness: "claude", limited: true },
  ]);
  await activateAgentProfile("strict", { allowedProviders: ["claude"], order: ["codex"] }, deadline, fixture.home);
  process.env.MACHINES_AGENT_FALLBACK = "off";
  await assert.rejects(fixture.prepare(), /no allowed preset.*FALLBACK=off/u);
  delete process.env.MACHINES_AGENT_FALLBACK;
  await writeFile(join(fixture.cwd, ".machines", "report.ts"), `
    export const description = 'Report a filtered provider limit';
    export const agentRoles = {worker: 'Work'};
    export default ({agent, final, machine}) => machine({initial:'work', states:{
      work: agent('Work', {completed:'wrong', limited:'done'}, {using:'worker', onLimit:'limited'}), done:final(), wrong:final()
    }});
  `);
  const prepared = await prepareMachineRun({ cwd: fixture.cwd, home: fixture.home, machine: "report", agents: { worker: "boundCodex" } });
  const observed = await observePriority(prepared);
  assert.equal(observed.result.value, "done");
  assert.deepEqual(observed.tried, ["allowed"]);
});

test("fallback off skips saved conditional preference quota hooks with and without a profile", async (context) => {
  const fixture = await priorityFixture(context);
  const marker = join(fixture.root, "quota-reads");
  await writeFile(join(fixture.cwd, ".machines", "agents.ts"), `
    import { appendFileSync } from 'node:fs';
    export default () => ({
      worker: { description: 'Bound', harness: 'codex', fallback: ['spare'],
        runner: () => ({type:'completed'}) },
      spare: { description: 'Quota', harness: 'claude',
        quota: async () => { appendFileSync(${JSON.stringify(marker)}, 'read'); return {remaining: 50}; },
        runner: () => ({type:'completed'}) },
    });
  `);
  await writeProviderOrder({ order: ["claude"], above: 30 }, fixture.home);
  process.env.MACHINES_AGENT_FALLBACK = "off";
  await (await fixture.prepare("worker")).start();
  await activateAgentProfile("filter-only", { allowedProviders: ["codex"] }, deadline, fixture.home);
  await (await fixture.prepare("worker")).start();
  await assert.rejects(readFile(marker), { code: "ENOENT" });
  delete process.env.MACHINES_AGENT_FALLBACK;
  await activateAgentProfile("own-order", burn, deadline, fixture.home);
  await (await fixture.prepare("worker")).start();
  // The profile supplies its own order, so the legacy condition stays inactive.
  await assert.rejects(readFile(marker), { code: "ENOENT" });
  await clearAgentProfile(fixture.home);
  await (await fixture.prepare("worker")).start();
  assert.ok((await readFile(marker, "utf8")).startsWith("read"));
});

test("an impossible activation path is absent, but an unreadable activation still fails closed", async (context) => {
  const fixture = await priorityFixture(context);
  process.env.MACHINES_AGENT_PREFER = "";
  delete process.env.XDG_STATE_HOME;
  await writeFile(join(fixture.home, ".local"), "not a directory");
  assert.equal(await readActiveAgentProfile(fixture.home), undefined);
  await fixture.prepare();
  // A directory at the activation path is malformed state, not a missing activation.
  process.env.XDG_STATE_HOME = fixture.state;
  await mkdir(join(fixture.state, "machines", "agent-profile.json"), { recursive: true });
  await assert.rejects(fixture.prepare(), /Could not read profile JSON/u);
});

test("environment order supersedes profile order, above only releases saved prefer, expiry restores it", async (context) => {
  const fixture = await priorityFixture(context, [
    { name: "boundCodex", harness: "codex", fallback: ["claudeA", "deepseek"] },
    { name: "claudeA", harness: "claude" },
    { name: "deepseek", harness: "deepseek" },
  ]);
  fixture.prefer("claude", "--above", "100");
  await activateAgentProfile("order", { order: ["deepseek"], allowedProviders: ["deepseek", "codex", "claude"] }, deadline, fixture.home);
  assert.deepEqual((await observePriority(await fixture.prepare())).tried, ["deepseek"]);
  process.env.MACHINES_AGENT_PREFER = "claude";
  assert.deepEqual((await observePriority(await fixture.prepare())).tried, ["claudeA"]);
  process.env.MACHINES_AGENT_PREFER = "";
  assert.deepEqual((await observePriority(await fixture.prepare())).tried, ["boundCodex"]);
  await activateAgentProfile("strict", { ...burn, order: ["deepseek"] }, deadline, fixture.home);
  process.env.MACHINES_AGENT_PREFER = "claude";
  assert.deepEqual((await observePriority(await fixture.prepare())).tried, ["boundCodex"], "env cannot release filter");
  delete process.env.MACHINES_AGENT_PREFER;
  const stateFile = join(fixture.state, "machines", "agent-profile.json");
  const stored = (await readActiveAgentProfile(fixture.home))!;
  await writeFile(stateFile, JSON.stringify({ ...stored, until: "2000-01-01T00:00:00.000Z" }));
  assert.equal((await fixture.prepare()).profile, undefined);
  assert.deepEqual((await observePriority(await fixture.prepare())).tried, ["claudeA"]);
  assert.notEqual(await readActiveAgentProfile(fixture.home), undefined, "expired snapshot stays inspectable");
});

test("prepared profiles and adapter environment are immutable while new preparations see deactivation", async (context) => {
  const fixture = await priorityFixture(context);
  await codexPreset(fixture);
  await activateAgentProfile("burn", { ...burn, overrides: [{ preset: "worker", model: "profile-model", forModel: "profile-model", options: { effort: "high", serviceTier: "fast" } }] }, deadline, fixture.home);
  const prepared = await fixture.prepare("worker");
  assert.ok(Object.isFrozen(prepared.profile?.profile.overrides?.[0]?.options));
  await clearAgentProfile(fixture.home);
  const updates: AgentUpdate[] = [];
  const result = await prepared.start({ onAgentUpdate: (value) => updates.push(value) });
  const args = result.output.args;
  assert.equal(args[args.indexOf("--model") + 1], "profile-model");
  assert.ok(args.includes('model_reasoning_effort="high"') && args.includes('service_tier="fast"'));
  assert.equal(args[args.indexOf("--sandbox") + 1], "workspace-write");
  assert.ok(args.includes("--skip-git-repo-check") && !args.includes("--ephemeral"));
  assert.equal(result.output.envModel, "env-original", "credentials and configured env survive tuning");
  assert.ok(updates.some((value) => value.type === "identity" && value.model === "profile-model" && value.thinking === "high" && value.harness === "codex"));
  const fresh = await fixture.prepare("worker");
  const original = await fresh.start();
  assert.ok(original.output.args.includes("original"));
  assert.ok(!original.output.args.includes('service_tier="fast"'));
});

test("actual Codex tuning preserves argv and originals, isolates concurrent configurations and pins env", async () => {
  const options = { model: "base", effort: "medium", sandbox: "read-only" as const, output: "capture" as const, env: { CODEX_MODEL: "local-env" } };
  const args = [fake, "arguments"];
  const original = codexAgent(process.execPath, args, options);
  const fast = configureAgentTuning(original, { model: "one", options: { serviceTier: "fast", effort: "high" } });
  const ultra = configureAgentTuning(original, { model: "two", options: { serviceTier: "ultrafast", effort: "low" } });
  const [first, second, base] = await Promise.all([fast.runner(request), ultra.runner(request), original(request)]);
  assert.ok((first.args as string[]).includes('service_tier="fast"'));
  assert.ok((second.args as string[]).includes('service_tier="ultrafast"'));
  assert.ok((base.args as string[]).includes("base") && !(base.args as string[]).some((arg) => arg.startsWith("service_tier=")));
  assert.equal(options.model, "base");
  assert.deepEqual(args, [fake, "arguments"]);
  const previous = process.env.CODEX_MODEL;
  try {
    process.env.CODEX_MODEL = "before";
    const pinned = configureAgentTuning(codexAgent(process.execPath, [fake, "arguments"], { output: "capture" }), { options: { effort: "high" } });
    process.env.CODEX_MODEL = "after";
    assert.ok(((await pinned.runner(request)).args as string[]).includes("before"));
  } finally {
    if (previous === undefined) delete process.env.CODEX_MODEL; else process.env.CODEX_MODEL = previous;
  }
});

test("a custom adapter owns a unique JSON option and model-specific rules, without core edits", async (context) => {
  const fixture = await priorityFixture(context);
  await writeFile(join(fixture.cwd, ".machines", "agents.ts"), `
    export default ({withAgentTuning}) => {
      function create(model = 'plain', options = {}) {
        const runner = (_request, report) => {
          report?.({type:'identity', harness:'custom-account', model});
          return {type:'completed', model, options};
        };
        return withAgentTuning(runner, {configure(tuning) {
          const selected = tuning.model ?? model;
          const values = tuning.options ?? {};
          if (Object.keys(values).some(key => key !== 'lattice')) throw new Error('Unknown custom option; supported: lattice');
          if (values.lattice !== undefined && (!Array.isArray(values.lattice) || !values.lattice.every(value => typeof value === 'number'))) throw new Error('lattice must be a numeric array');
          if (values.lattice !== undefined && selected !== 'grid') throw new Error('lattice requires grid model');
          return {runner: create(selected, values), model: selected};
        }});
      }
      return {worker: {description:'Custom model', harness:'custom-account', runner:create()}};
    };
  `);
  const profile: AgentProfile = { allowedProviders: ["custom-account"], overrides: [{ provider: "custom-account", model: "grid", options: { lattice: [2, 3] } }] };
  await activateAgentProfile("custom", profile, deadline, fixture.home);
  assert.deepEqual((await (await fixture.prepare("worker")).start()).output.options, { lattice: [2, 3] });
  const summary = (await listAgentPresets({ cwd: fixture.cwd, home: fixture.home })).find((preset) => preset.name === "worker");
  assert.equal(summary?.model, "grid");
  for (const [override, message] of [
    [{ model: "plain", options: { lattice: [2] } }, /lattice requires grid/u],
    [{ model: "grid", options: { lattice: "bad" } }, /numeric array/u],
    [{ model: "grid", options: { unknown: 1 } }, /Unknown custom option/u],
  ] as [NonNullable<AgentProfile["overrides"]>[number], RegExp][]) {
    await activateAgentProfile("bad", { overrides: [{ preset: "worker", ...override }] }, deadline, fixture.home);
    await assert.rejects(fixture.prepare("worker"), message);
  }
});

test("unknown or unsafe Codex options, mismatched model scopes and opaque wrappers fail before execution", async (context) => {
  const fixture = await priorityFixture(context);
  await codexPreset(fixture);
  const unsafeOptions: Record<string, JsonValue>[] = [
    { effort: 2 }, { serviceTier: "invalid" }, { sandbox: "danger-full-access" }, { env: { TOKEN: "DO-NOT-LOG" } },
    { command: "touch /tmp/should-not-execute" }, { args: [] }, { credentials: "DO-NOT-LOG" }, { extraUsage: "allow" },
  ];
  for (const options of unsafeOptions) {
    await activateAgentProfile("bad", { overrides: [{ preset: "worker", options }] }, deadline, fixture.home);
    await assert.rejects(fixture.prepare("worker"), (error: Error) => {
      assert.match(error.message, /Profile cannot configure preset "worker".*(?:unsupported|must be one of)/u);
      assert.ok(!error.message.includes("DO-NOT-LOG"));
      return true;
    });
  }
  await activateAgentProfile("mismatch", { overrides: [{ preset: "worker", model: "one", forModel: "two", options: { effort: "high" } }] }, deadline, fixture.home);
  await assert.rejects(fixture.prepare("worker"), /forModel restriction/u);
  await activateAgentProfile("opaque", { overrides: [{ preset: "spare", model: "fake" }] }, deadline, fixture.home);
  await assert.rejects(fixture.prepare("worker"), /does not support profile tuning.*withAgentTuning/u);
  const originalRunner = codexAgent(process.execPath, [fake, "arguments"], { output: "capture" });
  const wrapped: AgentRunner = (req, report) => originalRunner(req, report);
  assert.throws(() => configureAgentTuning(wrapped, { model: "fake" }), /does not support profile tuning/u);
  const explicit = withAgentTuning(wrapped, { configure: (tuning) => configureAgentTuning(codexAgent(process.execPath, [fake, "arguments"], { output: "capture" }), tuning) });
  assert.equal(configureAgentTuning(explicit, { model: "chosen" }).model, "chosen");
});

test("fallback never inherits another provider's tuning", async (context) => {
  const fixture = await priorityFixture(context);
  await codexPreset(fixture, "usage-limit");
  await activateAgentProfile("tune", { overrides: [{ preset: "worker", options: { serviceTier: "fast" } }] }, deadline, fixture.home);
  const result = await (await fixture.prepare("worker")).start();
  assert.equal(result.output.provider, "other");
  assert.equal(result.output.args, undefined);
});

test("Claude adapter effort tuning preserves permission controls and rejects foreign controls", async () => {
  const fakeClaude = resolve("tests/fixtures/fake-claude-agent.mjs");
  const runner = claudeAgent(process.execPath, [fakeClaude, "arguments"], { output: "capture", permissionMode: "dontAsk", tools: ["Read"], disallowedTools: ["Bash"], extraUsage: "limit" });
  const configured = configureAgentTuning(runner, { model: "sonnet", options: { effort: "high" } });
  const event = await configured.runner(request);
  const args = event.args as string[];
  assert.equal(args[args.indexOf("--effort") + 1], "high");
  assert.equal(args[args.indexOf("--model") + 1], "sonnet");
  assert.equal(args[args.indexOf("--tools") + 1], "Read");
  assert.equal(args[args.indexOf("--permission-mode") + 1], "dontAsk");
  assert.equal(args[args.indexOf("--disallowed-tools") + 1], "Bash");
  for (const key of ["serviceTier", "tools", "permissionMode", "extraUsage", "env"]) {
    assert.throws(() => configureAgentTuning(runner, { options: { [key]: "invalid" } }), /unsupported profile option/u);
  }
});

test("malformed definitions and persisted activation fail safely, invalid CLI inputs preserve valid activation", async (context) => {
  const fixture = await priorityFixture(context);
  await definitions(fixture, { burn });
  await activateAgentProfile("burn", burn, deadline, fixture.home);
  const stateFile = join(fixture.state, "machines", "agent-profile.json");
  const saved = await readFile(stateFile, "utf8");
  for (const args of [["use", "burn"], ["use", "burn", "--until", "yesterday"], ["use", "burn", "--until", "2000-01-01T00:00Z"], ["use", "missing", "--until", deadline], ["clear", "extra"], ["show", "burn", "extra"]]) {
    assert.notEqual(fixture.cli(["profile", ...args]).status, 0);
    assert.equal(await readFile(stateFile, "utf8"), saved);
  }
  for (const malformed of [null, [], { order: "codex" }, { allowedProviders: [""] }, { order: ["codex", "codex"] }, { until: deadline }, { overrides: {} }, { overrides: [{ model: "one" }] }, { overrides: [{ provider: "codex", options: [] }] }]) {
    await definitions(fixture, { bad: malformed });
    await assert.rejects(readAgentProfiles(fixture.cwd, fixture.home));
  }
  for (const malformed of ['{', 'null', '{}', '{"name":"burn","until":"tomorrow","profile":{}}', '{"name":"burn","until":"2099-01-01T00:00:00.000Z","profile":{"allowedProviders":false}}']) {
    await writeFile(stateFile, malformed);
    await assert.rejects(fixture.prepare(), /profile/iu);
  }
  await writeFile(stateFile, saved);
  await activateAgentProfile("overlap", { overrides: [{ provider: "codex", model: "one" }, { preset: "boundCodex", model: "two" }] }, deadline, fixture.home);
  await assert.rejects(fixture.prepare(), /overlapping overrides/u);
  await activateAgentProfile("missing", { overrides: [{ provider: "not-configured", model: "one" }] }, deadline, fixture.home);
  await assert.rejects(fixture.prepare(), /matches no configured preset/u);
});

test("atomic profile activation, expiry and clear preserve an already prepared selection", async (context) => {
  const fixture = await priorityFixture(context, [
    { name: "boundCodex", harness: "codex", fallback: ["other"] },
    { name: "other", harness: "claude" },
  ]);
  const profile = { allowedProviders: ["claude"], order: ["claude"] };
  await activateAgentProfile("temporary", profile, deadline, fixture.home);
  profile.allowedProviders.push("codex");
  assert.deepEqual((await readActiveAgentProfile(fixture.home))?.profile.allowedProviders, ["claude"]);
  const prepared = await fixture.prepare();
  const stateFile = join(fixture.state, "machines", "agent-profile.json");
  const saved = (await readActiveAgentProfile(fixture.home))!;
  await writeFile(stateFile, JSON.stringify({ ...saved, until: "2000-01-01T00:00:00.000Z" }));
  assert.equal((await fixture.prepare()).profile, undefined);
  assert.deepEqual((await observePriority(await fixture.prepare())).tried, ["boundCodex"]);
  await clearAgentProfile(fixture.home);
  assert.deepEqual((await observePriority(prepared)).tried, ["other"]);
  assert.equal(await readActiveAgentProfile(fixture.home), undefined);
  await clearAgentProfile(fixture.home);
  await Promise.all(Array.from({ length: 6 }, (_, index) => activateAgentProfile(`p${index}`, burn, deadline, fixture.home)));
  assert.deepEqual((await readActiveAgentProfile(fixture.home))?.profile, burn);
  assert.deepEqual(await readdir(join(fixture.state, "machines")), ["agent-profile.json"]);
});

test("profile input validation never replaces valid state or exposes malformed persisted values", async (context) => {
  const fixture = await priorityFixture(context);
  await activateAgentProfile("good", burn, deadline, fixture.home);
  const stateFile = join(fixture.state, "machines", "agent-profile.json");
  const saved = await readFile(stateFile, "utf8");
  for (const malformed of [null, [], { order: "codex" }, { allowedProviders: [""] }, { order: ["codex", "codex"] }, { until: deadline }, { overrides: {} }, { overrides: [{ model: "one" }] }, { overrides: [{ provider: "codex", options: [] }] }]) {
    await assert.rejects(activateAgentProfile("bad", malformed as AgentProfile, deadline, fixture.home));
    assert.equal(await readFile(stateFile, "utf8"), saved);
  }
  for (const until of ["yesterday", "2000-01-01T00:00Z", "25:00", "2099-02-30T12:00:00Z"]) {
    await assert.rejects(activateAgentProfile("bad", burn, until, fixture.home));
    assert.equal(await readFile(stateFile, "utf8"), saved);
  }
  for (const malformed of ['{"secret":"DO-NOT-LOG"', 'null', '{}', '{"name":"burn","until":"tomorrow","profile":{}}', '{"name":"burn","until":"2099-01-01T00:00:00.000Z","profile":{"allowedProviders":false}}']) {
    await writeFile(stateFile, malformed);
    await assert.rejects(fixture.prepare(), (error: Error) => {
      assert.match(error.message, /profile/iu);
      assert.ok(!error.message.includes("DO-NOT-LOG"));
      return true;
    });
  }
});

test("tuning inputs and originals cannot contaminate a second configuration", async () => {
  const baseOptions = { lattice: [1] };
  const runner = withAgentTuning(() => ({ type: "completed", options: baseOptions }), {
    configure(tuning) {
      assert.ok(Object.isFrozen(tuning) && Object.isFrozen(tuning.options?.lattice));
      return { model: tuning.model, runner: () => ({ type: "completed", options: tuning.options }) };
    },
  });
  const values = { lattice: [2, 3] };
  const first = configureAgentTuning(runner, { model: "first", options: values });
  values.lattice.push(4);
  const second = configureAgentTuning(runner, { model: "second", options: { lattice: [5] } });
  assert.deepEqual((await first.runner(request)).options, { lattice: [2, 3] });
  assert.deepEqual((await second.runner(request)).options, { lattice: [5] });
  assert.deepEqual((await runner(request)).options, baseOptions);
  assert.throws(() => configureAgentTuning(runner, { options: { lost: undefined } } as never), /undefined/u);
  assert.throws(() => configureAgentTuning(runner, { model: "\nbad" }), /one-line/u);
  assert.throws(() => configureAgentTuning(runner, { options: [] } as never), /JSON object/u);
  for (const invalid of [null, [], "bad", 12]) {
    assert.throws(() => configureAgentTuning(runner, invalid as never), /JSON object/u);
  }
});
