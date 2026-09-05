import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export async function smokeMcp({ command = process.execPath, args, cwd, project }) {
  await mkdir(join(project, ".machines"), { recursive: true });
  const userHome = join(project, ".empty-home");
  await mkdir(userHome, { recursive: true });
  await writeFile(join(project, ".machines", "review.ts"), `
export const description = "Waits for a deterministic packaging smoke response.";
export default ({ machine, human, final }) => machine({
  initial: "review",
  states: {
    review: human("Continue?", { submitted: "done" }, { choices: ["yes"] }),
    done: final(),
  },
});
`);
  const transport = new StdioClientTransport({
    command, args, cwd, stderr: "pipe", env: { MACHINES_USER_HOME: userHome },
  });
  const client = new Client({ name: "machines-package-smoke", version: "1.0.0" });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => { stderr += String(chunk); });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 5);
    const resource = await client.readResource({ uri: "ui://machines/run-v1.html" });
    assert.match(resource.contents[0].text, /machine_respond/u);
    const discovered = await client.callTool({ name: "machine_list", arguments: { cwd: project } });
    assert.equal(discovered.isError, undefined, JSON.stringify(discovered));
    assert.ok(discovered.structuredContent.machines.some((item) => item.name === "review" && !item.error));
    const started = await client.callTool({ name: "machine_start", arguments: { cwd: project, machine: "review" } });
    assert.equal(started.isError, undefined, JSON.stringify(started));
    const runId = started.structuredContent.run.id;
    const waiting = await waitFor("waiting");
    assert.equal(typeof waiting.human.requestId, "string");
    const responded = await client.callTool({
      name: "machine_respond",
      arguments: { runId, requestId: waiting.human.requestId, response: "yes" },
    });
    assert.equal(responded.isError, undefined, JSON.stringify(responded));
    assert.equal((await waitFor("completed")).state, "done");

    async function waitFor(status) {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const result = await client.callTool({ name: "machine_status", arguments: { runId } });
        assert.equal(result.isError, undefined, JSON.stringify(result));
        const run = result.structuredContent.runs[0];
        assert.notEqual(run.status, "failed", JSON.stringify(run));
        if (run.status === status) return run;
        await setTimeout(20);
      }
      throw new Error(`Packaged run did not become ${status}`);
    }
  } catch (cause) {
    throw new Error(`MCP packaging smoke failed${stderr ? `:\n${stderr}` : ""}`, { cause });
  } finally {
    await client.close();
  }
}
