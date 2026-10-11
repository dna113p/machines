import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import { configuredAgentPresets } from "../src/catalog.ts";
import { AgentLimitError, agentLimitOf } from "../src/index.ts";

const request = { prompt: "Do the work", outcomes: ["completed"], cwd: process.cwd() };

test("a usage limit is found through wrapped causes", () => {
  const limit = { harness: "claude", kind: "five_hour", resetsAt: 1_900_000_000_000 };
  const error = new AgentLimitError("Out of quota", limit, { cause: new Error("429") });

  assert.equal(error.name, "AgentLimitError");
  assert.equal(error.message, "Out of quota");
  assert.ok(error.cause instanceof Error);
  assert.equal(agentLimitOf(error), limit);
  assert.equal(agentLimitOf(new Error("Agent failed", { cause: new Error("Turn failed", { cause: error }) })), limit);
});

test("a usage limit thrown by another copy of the module is recognised", async () => {
  // A query string loads the module again, as source and an installed copy would.
  const copy: typeof import("../src/agent-limit.ts") = await import(
    `${pathToFileURL(resolve("src/agent-limit.ts")).href}?copy`
  );
  const error = new copy.AgentLimitError("Out of quota", { harness: "codex", kind: "usage" });

  assert.notEqual(copy.AgentLimitError, AgentLimitError);
  assert.ok(!(error instanceof AgentLimitError));
  assert.deepEqual(agentLimitOf(new Error("Agent failed", { cause: error })), { harness: "codex", kind: "usage" });
});

test("failures without a usage limit have none", () => {
  const circular = new Error("Circular");
  circular.cause = circular;

  for (const cause of [
    undefined, null, "You've hit your usage limit", 429, new Error("Failed"), circular,
    { limit: { harness: "claude" } },
    { [Symbol.for("machines.agent-limit")]: true },
    { [Symbol.for("machines.agent-limit")]: true, limit: { kind: "usage" } },
  ]) {
    assert.equal(agentLimitOf(cause), undefined);
  }
});

test("a custom preset runner can throw a usage limit", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "machines-agent-limit-"));
  try {
    const project = join(temporary, "project");
    await mkdir(join(project, ".machines"), { recursive: true });
    await writeFile(join(project, ".machines/agents.ts"), `
      export default ({ AgentLimitError }) => ({
        limited: {
          description: 'Always at its limit',
          runner: () => { throw new AgentLimitError('Out of quota', { harness: 'custom', kind: 'usage' }); },
        },
      });
    `);
    const { agents } = await configuredAgentPresets(project, join(temporary, "empty-home"));
    const limited = agents.limited;
    assert.ok(limited !== undefined);
    assert.throws(() => limited(request), (error) => {
      assert.deepEqual(agentLimitOf(error), { harness: "custom", kind: "usage" });
      return true;
    });
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
