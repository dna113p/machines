import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createMachinesMcpServer } from "../mcp/server.ts";

const cwd = resolve("tests/fixtures/mcp-project");

test("the MCP adapter exposes five tools and one optional UI resource", async (context) => {
  const { client, close } = await connectedClient();
  context.after(close);

  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map((tool) => tool.name), [
    "machine_list",
    "machine_agents",
    "machine_start",
    "machine_status",
    "machine_respond",
  ]);
  assert.deepEqual(listed.tools[2]?._meta?.ui, {
    resourceUri: "ui://machines/run-v1.html",
  });
  assert.deepEqual(listed.tools[2]?.annotations, {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: true,
  });
  const pluginConfig = JSON.parse(
    readFileSync("codex/machines/.mcp.json", "utf8"),
  ) as { mcpServers: { machines: { default_tools_approval_mode?: string } } };
  assert.equal(pluginConfig.mcpServers.machines.default_tools_approval_mode, "approve");

  const resources = await client.listResources();
  assert.equal(resources.resources[0]?.uri, "ui://machines/run-v1.html");
  const resource = await client.readResource({ uri: "ui://machines/run-v1.html" });
  const content = resource.contents[0];
  assert.equal(content?.mimeType, "text/html;profile=mcp-app");
  assert.match("text" in content! ? content.text : "", /machine_respond/u);
});

test("the MCP adapter starts, observes, and responds to a hosted Machine", async (context) => {
  const { client, close } = await connectedClient();
  context.after(close);

  const listed = await client.callTool({ name: "machine_list", arguments: { cwd } });
  assert.equal(listed.isError, undefined);
  assert.match(toolText(listed), /review — Waits for one restricted Human review response/u);

  const started = await client.callTool({
    name: "machine_start",
    arguments: { cwd, machine: "review", input: "the change" },
  });
  assert.equal(started.isError, undefined);
  const runId = readRun(toolStructuredContent(started)).id;
  const waiting = await waitForStatus(client, runId, "waiting");
  const requestId = readHumanRequestId(waiting);
  assert.deepEqual(waiting.human, {
    requestId,
    prompt: "Review \"the change\"?",
    choices: ["approve", "deny"],
  });

  const invalid = await client.callTool({
    name: "machine_respond",
    arguments: { runId, requestId, response: "other" },
  });
  assert.equal(invalid.isError, true);
  assert.match(toolText(invalid), /Expected one of: approve, deny/u);
  assert.equal((await status(client, runId)).status, "waiting");

  const responded = await client.callTool({
    name: "machine_respond",
    arguments: { runId, requestId, response: "approve" },
  });
  assert.equal(responded.isError, undefined);
  const completed = await waitForStatus(client, runId, "completed");
  assert.equal(completed.state, "done");
});

test("the MCP adapter validates the explicit project directory", async (context) => {
  const { client, close } = await connectedClient();
  context.after(close);

  const result = await client.callTool({
    name: "machine_list",
    arguments: { cwd: "relative" },
  });
  assert.equal(result.isError, true);
  assert.match(toolText(result), /cwd must be an absolute path/u);
});

async function connectedClient() {
  const { server, session } = createMachinesMcpServer();
  const client = new Client({ name: "machines-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    session,
    close: async () => {
      session.close();
      await Promise.all([client.close(), server.close()]);
    },
  };
}

async function waitForStatus(
  client: Client,
  runId: string,
  expected: string,
): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const run = await status(client, runId);
    if (run.status === expected) return run;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  throw new Error(`Machine run did not reach ${expected}`);
}

async function status(client: Client, runId: string): Promise<Record<string, unknown>> {
  const result = await client.callTool({ name: "machine_status", arguments: { runId } });
  const runs = toolStructuredContent(result)?.runs;
  assert.ok(Array.isArray(runs));
  assert.ok(runs[0] !== null && typeof runs[0] === "object");
  return runs[0] as Record<string, unknown>;
}

function readRun(value: Record<string, unknown> | undefined): Record<string, unknown> & { id: string } {
  const run = value?.run;
  assert.ok(run !== null && typeof run === "object");
  assert.equal(typeof (run as { id?: unknown }).id, "string");
  return run as Record<string, unknown> & { id: string };
}

function toolText(value: unknown): string {
  const content = (value as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  const first = content[0] as { type?: unknown; text?: unknown } | undefined;
  return first?.type === "text" && typeof first.text === "string" ? first.text : "";
}

function toolStructuredContent(value: unknown): Record<string, unknown> | undefined {
  const content = (value as { structuredContent?: unknown }).structuredContent;
  return content !== null && typeof content === "object"
    ? content as Record<string, unknown>
    : undefined;
}

function readHumanRequestId(run: Record<string, unknown>): string {
  const human = run.human;
  assert.ok(human !== null && typeof human === "object" && "requestId" in human);
  assert.equal(typeof human.requestId, "string");
  return human.requestId as string;
}

test("disconnecting an MCP transport closes its owned session", async (context) => {
  const { client, session, close } = await connectedClient();
  context.after(close);
  const started = await client.callTool({ name: "machine_start", arguments: { cwd, machine: "review" } });
  const runId = readRun(toolStructuredContent(started)).id;
  await waitForStatus(client, runId, "waiting");
  await client.close();
  assert.deepEqual(session.status({}).structuredContent?.runs, []);
  await assert.rejects(session.start({ cwd, machine: "review" }), /closed/u);
});
