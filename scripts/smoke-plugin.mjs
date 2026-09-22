import assert from "node:assert/strict";
import { access, cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { smokeMcp } from "./mcp-smoke.mjs";

const temporary = await mkdtemp(join(tmpdir(), "machines-plugin-"));
try {
  const plugin = join(temporary, "machines");
  await cp(new URL("../build/codex/machines", import.meta.url), plugin, { recursive: true });
  const config = JSON.parse(await readFile(join(plugin, ".mcp.json"), "utf8")).mcpServers.machines;
  const manifest = JSON.parse(await readFile(join(plugin, ".codex-plugin/plugin.json"), "utf8"));
  assert.equal(manifest.name, "machines");
  assert.equal(manifest.skills, "./skills/");
  for (const required of [
    "skills/machine-delegation/SKILL.md",
    "skills/machine-delegation/references/delegation-machine.md",
    "skills/machine-builder/SKILL.md",
    "docs/authoring.md",
    "docs/integrations.md",
    "docs/local-decisions.md",
    "services/laya/server.py",
  ]) {
    await access(join(plugin, required));
  }
  assert.equal(config.cwd, ".");
  assert.ok(config.args.every((argument) => !argument.includes("/home/") && !argument.includes("${")));
  const { openRouterDecisionAgent } = await import(pathToFileURL(join(plugin, "dist/src/openrouter.js")).href);
  const classified = await openRouterDecisionAgent({ apiKey: "offline-fixture", fetch: async (url) => {
    assert.equal(url, "https://openrouter.ai/api/alpha/decisions");
    return Response.json({ model: "fixture", usage: { input_tokens: 1, output_tokens: 0 },
      answers: { decision: { type: "choice", choice: "review" } } });
  } })({ prompt: "Synthetic evidence", outcomes: ["review"] });
  assert.deepEqual(classified, { type: "review", decision: {
    choice: "review", model: "fixture", provider: "openrouter-decision",
  } });
  for (const [name, port] of [["laya", 8001], ["von", 8000]]) {
    const adapter = await import(pathToFileURL(join(plugin, "dist/src/" + name + ".js")).href);
    const event = await adapter[name + "Agent"]({
      baseUrl: "http://127.0.0.1:" + port, apiKey: "fixture-only", model: "fixture-request",
      fetch: async (url) => {
        assert.equal(url, "http://127.0.0.1:" + port + "/v1/systemone");
        return Response.json({ model:"fixture-response", answers:{ decision:{
          type:"choice", choice:"review", probabilities:{ review:1, done:0 }, confidence:1,
        } } });
      },
    })({ prompt:"Synthetic evidence", outcomes:["review","done"] });
    assert.equal(event.type, "review");
    assert.equal(event.decision.provider, name);
    assert.equal(event.decision.model, "fixture-response");
  }
  await smokeMcp({ ...config, cwd: resolve(plugin, config.cwd), project: join(temporary, "project") });
  console.log("Relocated plugin: independent dependencies, OpenRouter/Laya/Von decision fixtures, widget, discovery, and hosted Human round trip passed.");
} finally {
  await rm(temporary, { recursive: true, force: true });
}
