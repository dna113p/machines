import "./environment.ts";

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import * as machines from "../src/index.ts";
import type { AgentRequest, Event } from "../src/index.ts";

const starter = "skills/machine-delegation/references/delegation-machine.md";
const source = readFileSync(resolve(starter), "utf8");

/** The starter's TypeScript block, saved where Node can import it. */
async function loadStarter(directory: string) {
  const blocks = [...source.matchAll(/```ts\n([\s\S]*?)```/gu)];
  assert.equal(blocks.length, 1, `${starter} has one TypeScript starter`);
  const path = join(directory, "delegate-task.ts");
  writeFileSync(path, blocks[0]![1]!);
  const module = await import(pathToFileURL(path).href) as { default: (primitives: machines.MachinePrimitives, input: string) => ReturnType<typeof machines.machine> };
  return module.default;
}

async function delegate(event: Event) {
  const directory = mkdtempSync(join(tmpdir(), "machines-delegation-starter-"));
  try {
    const factory = await loadStarter(directory);
    const resultPath = join(directory, "results", "result.json");
    const requests: AgentRequest[] = [];
    const definition = factory(machines, JSON.stringify({ task: "Review the parser.", resultPath }));
    let failure: unknown;
    const final = await machines.run(definition, {
      agents: { worker: (request) => { requests.push(request); return event; } },
    }).catch((cause: unknown) => { failure = cause; return undefined; });
    const saved = existsSync(resultPath) ? JSON.parse(readFileSync(resultPath, "utf8")) as Record<string, unknown> : undefined;
    return { final: final?.value, failure, saved, prompt: requests[0]?.prompt ?? "" };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("the delegation starter asks the worker for the trusted result fields", async () => {
  const { prompt } = await delegate({ type: "completed", summary: "Reviewed." });
  for (const field of ["assumptions", "scopeAdditions", "openQuestions", "needs"]) {
    assert.ok(prompt.includes(field), `the starter's prompt must ask for ${field}`);
  }
  assert.match(prompt, /openQuestions[^.]*irreversible|irreversible[^.]*openQuestions/u);
  assert.match(prompt, /needs[^.]*blocked|blocked[^.]*needs/u);
});

test("the delegation starter saves assumptions, scope additions and open questions with a completed result", async () => {
  const { final, saved } = await delegate({
    type: "completed",
    summary: "Reviewed the parser; tests pass.",
    assumptions: ["Empty input is valid"],
    scopeAdditions: ["tests/parser.test.ts"],
    openQuestions: ["Publish the new parser version?"],
  });
  assert.equal(final, "done");
  assert.deepEqual(saved, {
    outcome: "completed",
    summary: "Reviewed the parser; tests pass.",
    assumptions: ["Empty input is valid"],
    scopeAdditions: ["tests/parser.test.ts"],
    openQuestions: ["Publish the new parser version?"],
  });
});

test("the delegation starter saves what a blocked worker needs", async () => {
  const { final, saved } = await delegate({ type: "blocked", summary: "Cannot sign in.", needs: ["A registry login"] });
  assert.equal(final, "blocked");
  assert.deepEqual(saved?.needs, ["A registry login"]);
  assert.equal(saved?.outcome, "blocked");
});

test("the delegation starter keeps the fields optional and rejects ones that are not string lists", async () => {
  const plain = await delegate({ type: "completed", summary: "Done." });
  assert.equal(plain.final, "done");
  assert.deepEqual(plain.saved, { outcome: "completed", summary: "Done." });

  for (const event of [
    { type: "completed", summary: "Done.", assumptions: "Empty input is valid" },
    { type: "completed", summary: "Done.", scopeAdditions: [3] },
    { type: "blocked", summary: "Stuck.", needs: "A login" },
  ]) {
    const result = await delegate(event);
    assert.ok(result.failure !== undefined || result.final === undefined, `a malformed field was accepted: ${JSON.stringify(event)}`);
    assert.equal(result.saved, undefined, `a malformed field was saved: ${JSON.stringify(event)}`);
  }

  const missing = await delegate({ type: "completed", summary: " " });
  assert.equal(missing.saved, undefined, "a missing summary still fails");
});

test("the starter's saved-JSON paragraph names the result fields", () => {
  const paragraph = source.split(/\n{2,}/u).find((block) => block.startsWith("The saved JSON has"));
  assert.ok(paragraph, `${starter} keeps its saved-JSON paragraph`);
  for (const field of ["assumptions", "scopeAdditions", "openQuestions", "needs"]) {
    assert.ok(paragraph.includes(`\`${field}\``), `the saved-JSON paragraph must name \`${field}\``);
  }
});
