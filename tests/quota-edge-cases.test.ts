import "./environment.ts";

import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import type { AgentQuota } from "@dna113p/machines";
import { loadAgentBindings } from "../src/agent-bindings.ts";
import { FileLimitMemory, limitAwareRunner, readLimits } from "../src/agent-limits.ts";
import { writeProviderOrder } from "../src/provider-order.ts";
import { observePriority, priorityFixture } from "./provider-test-fixture.ts";

for (const reserve of [0, 100]) {
  test(`bindings accept quota and reserve boundary ${reserve} with the public AgentQuota type`, async (context) => {
    const fixture = await priorityFixture(context, []);
    const reading: AgentQuota = { remaining: reserve, kind: 'seven_day', resetsAt: Date.UTC(2099, 0, 1) };
    await writeFile(join(fixture.cwd, '.machines', 'agents.ts'), `export default () => ({
      valid: { description: 'Valid reserve', runner: () => ({type:'completed'}),
        reserve: ${reserve}, quota: async () => (${JSON.stringify(reading)}) },
    });`);
    const { presets } = await loadAgentBindings(fixture.cwd, fixture.home);
    assert.equal(presets.valid?.reserve, reserve);
    assert.deepEqual(await presets.valid?.quota?.(), reading);
  });
}

for (const value of ['-1', 'NaN', 'Infinity', '"10"', 'null']) {
  test(`preflight rejects reserve ${value} with preset and field names`, async (context) => {
    const fixture = await priorityFixture(context, []);
    await writeFile(join(fixture.cwd, '.machines', 'agents.ts'), `export default () => ({
      invalidReserve: { description: 'Invalid reserve', runner: () => ({type:'completed'}),
        reserve: ${value}, quota: async () => ({remaining:50}) },
    });`);
    await assert.rejects(fixture.prepare('invalidReserve'), /invalidReserve.*reserve/u);
  });
}

test('onLimit delivers a quota reserve as the bound preset event without calling a runner or fallback hook', async (context) => {
  const fixture = await priorityFixture(context, []);
  await writeFile(join(fixture.cwd, '.machines', 'agents.ts'), `export default () => ({
    bound: { description: 'Bound', harness: 'codex', reserve: 10, fallback: ['spare'],
      quota: async () => ({ remaining: 8, kind: 'seven_day', resetsAt: ${Date.UTC(2099, 0, 1)} }),
      runner: () => { throw new Error('must not run bound'); } },
    spare: { description: 'Spare', harness: 'claude',
      quota: async () => { throw new Error('must not read spare'); },
      runner: () => { throw new Error('must not run spare'); } },
  });`);
  await writeFile(join(fixture.cwd, '.machines', 'work.ts'), `
    export const description = 'Quota onLimit';
    export const agentRoles = { worker: 'Worker' };
    export default ({agent, final, machine}) => {
      let result;
      return machine({ initial: 'work', output: () => result, states: {
        work: agent('Work', { completed: 'unexpected', limited: {target:'done', actions: ({event}) => {result = event;}} },
          {using:'worker', onLimit:'limited'}), done: final(), unexpected: final(),
      }});
    };
  `);
  const { result, updates } = await observePriority(await fixture.prepare('bound'));
  assert.equal(result.value, 'done');
  assert.equal(result.output?.type, 'limited');
  assert.deepEqual(result.output?.limit, { role: 'worker', agent: 'bound', harness: 'codex',
    kind: 'seven_day', resetsAt: '2099-01-01T00:00:00.000Z' });
  assert.match(String(result.output?.message), /8% left, reserve 10%/u);
  assert.deepEqual(updates, []);
});

for (const remaining of [25, 30, 35]) {
  test(`launcher applies the conditional preference at ${remaining}% using configuration order, including overridden builtins`, async (context) => {
    const fixture = await priorityFixture(context, []);
    await writeFile(join(fixture.cwd, '.machines', 'agents.ts'), `
      const preset = (name, harness) => ({description:name, harness, runner: (_request, report) => {
        report?.({type:'identity', harness, model:name}); return {type:'completed', preset:name};
      }});
      export default () => ({
        boundCodex: {...preset('boundCodex', 'codex'), fallback:['zFirst', 'claude']},
        zFirst: {...preset('zFirst', 'claude'), quota: async () => ({remaining:${remaining}})},
        claude: {...preset('claude', 'claude'), quota: async () => {throw new Error('must not read later hook');}},
      });
    `);
    await writeProviderOrder({order:['claude'], above:30}, fixture.home);
    const observed = await observePriority(await fixture.prepare());
    assert.deepEqual(observed.tried, [remaining > 30 ? 'zFirst' : 'boundCodex']);
  });
}

test('quota provenance survives disk memory alongside legacy entries and is marked by machine limits', async (context) => {
  const fixture = await priorityFixture(context, []);
  const file = join(fixture.root, 'limits.json');
  const reset = Date.UTC(2099, 0, 1);
  const legacy = { preset: 'legacy', harness: 'claude', scope: 'provider', recordedAt: Date.now(),
    run: 'legacy-run', revision: 'legacy-revision', limit: { harness: 'claude', kind: 'five_hour', resetsAt: reset },
    until: reset, known: true };
  await writeFile(file, JSON.stringify([legacy]));
  const runner = limitAwareRunner('worker', [{ name:'quota-preset', harness:'codex', reserve:10,
    quota:async () => ({remaining:8, kind:'seven_day', resetsAt:reset}),
    runner:() => {throw new Error('must not run');},
  }], new FileLimitMemory(file), {maxWaitMs:0, probeMs:60_000});
  await assert.rejects(async () => runner({prompt:'Work', cwd:fixture.cwd, outcomes:['done']}), /8% left, reserve 10%/u);
  const entries = await readLimits(new FileLimitMemory(file));
  assert.deepEqual(entries.find((entry) => entry.preset === 'legacy'), legacy);
  assert.equal(entries.find((entry) => entry.preset === 'quota-preset')?.limit.quota?.remaining, 8);
  const saved = await readFile(file, 'utf8');
  const result = fixture.cli(['limits'], {MACHINES_AGENT_LIMITS_FILE:file});
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout.split('\n').find((line) => line.startsWith('quota-preset\t')) ?? '', /quota reading.*8%.*10%/u);
  assert.equal(await readFile(file, 'utf8'), saved);
});

test('prefer rejects invalid above arguments without replacing the last valid order', async (context) => {
  const fixture = await priorityFixture(context);
  await writeProviderOrder({order:['claude'], above:30}, fixture.home);
  const saved = await readFile(fixture.file, 'utf8');
  for (const args of [['--above'], ['--above','NaN'], ['--above','-1'], ['--above','101'], ['--above','30','--above','40']]) {
    assert.notEqual(fixture.cli(['prefer','claude',...args]).status, 0);
    assert.equal(await readFile(fixture.file, 'utf8'), saved);
  }
});
