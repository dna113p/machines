import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { smokeMcp } from "./mcp-smoke.mjs";

const temporary = await mkdtemp(join(tmpdir(), "machines-plugin-"));
try {
  const plugin = join(temporary, "machines");
  await cp(new URL("../build/codex/machines", import.meta.url), plugin, { recursive: true });
  const config = JSON.parse(await readFile(join(plugin, ".mcp.json"), "utf8")).mcpServers.machines;
  const manifest = JSON.parse(await readFile(join(plugin, ".codex-plugin/plugin.json"), "utf8"));
  assert.equal(manifest.name, "machines");
  assert.equal(config.cwd, ".");
  assert.ok(config.args.every((argument) => !argument.includes("/home/") && !argument.includes("${")));
  await smokeMcp({ ...config, cwd: resolve(plugin, config.cwd), project: join(temporary, "project") });
  console.log("Relocated plugin: independent dependencies, widget, discovery, and hosted Human round trip passed.");
} finally {
  await rm(temporary, { recursive: true, force: true });
}
