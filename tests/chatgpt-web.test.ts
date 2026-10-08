import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";

import {
  acknowledgeRigBridgeHandoff,
  chatGptWebAgent,
  chatGptWebPrompt,
  fetchLatestRigBridgeHandoff,
  fetchRigBridgeStatus,
  findChromeExecutable,
  rigBridgeHandoffOperation,
  type ChatGptWebAgentOptions,
} from "../src/chatgpt-web.ts";
import type { AgentUpdate } from "../src/index.ts";
import { listAgentPresets } from "../src/launcher.ts";

const page = await readFile(resolve("tests/fixtures/fake-chatgpt.html"), "utf8");
const executable = await findChromeExecutable();
const workspace = await mkdtemp(join(tmpdir(), "machines-chatgpt-web-"));
const request = { prompt: "Fix the failing test", outcomes: ["completed", "blocked"], cwd: workspace };

let server: Server;
let base: string;
let profile: string;
let cdpUrl: string;
const readHandoffs = new Set<string>();

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>(done => probe.listen(0, "127.0.0.1", done));
  const { port } = probe.address() as AddressInfo;
  await new Promise(done => probe.close(done));
  return port;
}

before(async () => {
  let opened: number | undefined;
  server = createServer((req, res) => {
    if (req.url === "/api/handoffs/read" && req.method === "POST") {
      const chunks: Buffer[] = [];
      req.on("data", chunk => chunks.push(chunk));
      req.on("end", () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (body.handoff_id) readHandoffs.add(body.handoff_id);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } catch {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "bad json" }));
        }
      });
      return;
    }
    if (req.url === "/api/status") {
      const now = Date.now();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        version: "0.1.2",
        workspaces: [
          {
            id: "ws-1",
            projectId: "p-1",
            threadId: "t-1",
            cwd: workspace,
            createdAt: now,
            activeCommands: [],
            recentCommands: [
              { id: "cmd-1", tool: "bash", description: "npm test", startedAt: now, success: true },
            ],
          },
          { id: "other", cwd: "/elsewhere", createdAt: now, recentCommands: [
            { id: "cmd-x", tool: "bash", description: "unrelated", startedAt: now, success: true },
          ] },
        ],
        notifications: [
          {
            id: "h-1",
            projectId: "p-1",
            threadId: "t-1",
            reason: "completed",
            summary: "Fixed test and passed verification",
            createdAt: now,
            readAt: readHandoffs.has("h-1") ? now : null,
          },
        ],
        unreadCount: readHandoffs.has("h-1") ? 0 : 1,
      }));
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(page);
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  profile = await mkdtemp(join(tmpdir(), "machines-chatgpt-profile-"));
  cdpUrl = `http://127.0.0.1:${await freePort()}`;
});

after(async () => {
  // The runner leaves its browser running for reuse; tests own this temporary one.
  try {
    const version = await (await fetch(`${cdpUrl}/json/version`)).json() as { webSocketDebuggerUrl: string };
    const socket = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise(done => socket.addEventListener("open", done, { once: true }));
    socket.send(JSON.stringify({ id: 1, method: "Browser.close" }));
    await new Promise(done => socket.addEventListener("close", done, { once: true }));
  } catch { /* the browser was never started */ }
  await new Promise(done => server.close(done));
  await rm(profile, { recursive: true, force: true, maxRetries: 5 });
  await rm(workspace, { recursive: true, force: true });
});

const runner = (scenario: string, options: ChatGptWebAgentOptions = {}) => chatGptWebAgent({
  url: `${base}/?scenario=${scenario}`,
  cdpUrl,
  launch: { headless: true, userDataDir: profile, args: ["--disable-gpu"], ...(executable === undefined ? {} : { executable }) },
  bridgeStatusUrl: `${base}/api/status`,
  settleMs: 300,
  pollMs: 100,
  timeoutMs: 20_000,
  output: "capture",
  ...options,
});

test("ChatGPT Web prompt opens the target workspace and requests work_handoff", () => {
  const prompt = chatGptWebPrompt(request, "my-bridge");
  assert.match(prompt, /"my-bridge" connector/u);
  assert.ok(prompt.includes(`workspace_open with cwd ${JSON.stringify(workspace)}`));
  assert.ok(prompt.includes("call work_handoff with workspace_id"));
  assert.ok(prompt.includes(request.prompt));
  assert.ok(prompt.includes("Allowed outcome types: completed, blocked."));
});

test("ChatGPT Web validates requests before touching a browser", async () => {
  const agent = chatGptWebAgent({ cdpUrl: "http://127.0.0.1:9", launch: false });
  await assert.rejects(async () => agent({ prompt: "x", outcomes: ["completed"] }), /requires a working directory/u);
  await assert.rejects(async () => agent({ ...request, outcomes: [] }), /at least one allowed outcome/u);
  await assert.rejects(async () => agent(request), /No browser DevTools endpoint at http:\/\/127\.0\.0\.1:9/u);
});

test("ChatGPT Web is a built-in preset and an Agent binding adapter", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "machines-chatgpt-home-"));
  try {
    const project = join(temporary, "project");
    await mkdir(join(project, ".machines"), { recursive: true });
    const location = { cwd: project, home: join(temporary, "empty-home") };
    const builtin = (await listAgentPresets(location)).find(preset => preset.name === "chatgpt-web");
    assert.equal(builtin?.harness, "chatgpt-web");
    assert.equal(builtin.source, "built in");
    await writeFile(join(project, ".machines/agents.ts"), `
      export default ({ chatGptWebAgent }) => ({
        "chatgpt-project": {
          description: "ChatGPT project",
          harness: "chatgpt-web",
          runner: chatGptWebAgent({ url: "https://chatgpt.com/g/project" }),
        },
      });
    `);
    const configured = (await listAgentPresets(location)).find(preset => preset.name === "chatgpt-project");
    assert.equal(configured?.harness, "chatgpt-web");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("ChatGPT Web enables the connector, submits the task, captures handoff, and returns the final event", { skip: executable === undefined && "no Chromium browser" }, async () => {
  const updates: AgentUpdate[] = [];
  const event = await runner("normal")(request, update => updates.push(update));
  assert.equal(event.type, "completed");
  assert.equal(event.connector, true);
  assert.equal(event.message, "Finished the task.");
  assert.equal(event.summary, "Fixed test and passed verification");
  assert.equal(event.handoff?.id, "h-1");
  assert.equal(event.handoff?.reason, "completed");
  assert.ok(readHandoffs.has("h-1"), "Handoff should have been marked read");
  assert.ok(typeof event.prompt === "string");
  assert.ok(event.prompt.includes(`workspace_open with cwd ${JSON.stringify(workspace)}`));
  assert.ok(event.prompt.includes("Fix the failing test"));

  assert.deepEqual(updates[0], { type: "identity", harness: "chatgpt-web" });
  const tools = updates.filter(update => update.type === "tool");
  assert.ok(tools.some(update => update.title === `workspace_open ${workspace}` && update.status === "completed"));
  assert.ok(tools.some(update => update.id === "cmd-1" && update.title === "npm test" && update.status === "completed"));
  assert.ok(tools.some(update => update.id === "handoff:h-1" && update.status === "completed"));
  assert.ok(!tools.some(update => update.id === "cmd-x"));
  assert.ok(tools.some(update => update.id === "chatgpt-conversation" && update.status === "completed"
    && update.title?.endsWith("/c/fake-conversation")));
});

test("ChatGPT Web falls back to work_handoff reason when MACHINES_EVENT line is omitted", { skip: executable === undefined && "no Chromium browser" }, async () => {
  const event = await runner("handoff-no-event")(request);
  assert.equal(event.type, "completed");
  assert.equal(event.summary, "Fixed test and passed verification");
  assert.equal(event.handoff?.id, "h-1");
});

test("ChatGPT Web falls back to typed input when paste is not handled", { skip: executable === undefined && "no Chromium browser" }, async () => {
  const event = await runner("no-paste", { selectConnector: false })(request);
  assert.equal(event.type, "completed");
  assert.equal(event.connector, false);
  assert.ok(typeof event.prompt === "string" && event.prompt.includes("Fix the failing test"));
});

test("ChatGPT Web approves tool confirmations only when allowed", { skip: executable === undefined && "no Chromium browser" }, async () => {
  const event = await runner("approve", { approveToolCalls: true })(request);
  assert.equal(event.type, "completed");
  const updates: AgentUpdate[] = [];
  await assert.rejects(
    async () => runner("approve", { timeoutMs: 2_000 })(request, update => updates.push(update)),
    /did not finish within 2000 ms[\s\S]*Conversation: .*\/c\/fake-conversation/u,
  );
  assert.ok(updates.some(update => update.type === "output" && update.text.includes("waiting for tool approval")));
});

test("ChatGPT Web reports replies without a Machines event and without a handoff", { skip: executable === undefined && "no Chromium browser" }, async () => {
  // If statusUrl is disabled, no handoff is observed and missing MACHINES_EVENT fails as expected
  await assert.rejects(async () => runner("no-event", { bridgeStatusUrl: false })(request), /finished without returning a Machines event/u);
});

test("rigBridgeHandoffOperation and query utilities read and acknowledge handoffs for Machines", async () => {
  const status = await fetchRigBridgeStatus(`${base}/api/status`);
  assert.equal(status?.version, "0.1.2");
  const handoff = await fetchLatestRigBridgeHandoff({ cwd: workspace, statusUrl: `${base}/api/status` });
  assert.equal(handoff?.id, "h-1");
  assert.equal(handoff?.reason, "completed");
  assert.equal(handoff?.summary, "Fixed test and passed verification");

  const op = rigBridgeHandoffOperation({ cwd: workspace, statusUrl: `${base}/api/status`, acknowledge: true });
  const event = await op();
  assert.equal(event.type, "completed");
  assert.equal(event.summary, "Fixed test and passed verification");
  assert.equal(event.handoff?.id, "h-1");
  assert.ok(readHandoffs.has("h-1"));

  await assert.rejects(
    async () => rigBridgeHandoffOperation({ cwd: "/non-existent", statusUrl: `${base}/api/status` })(),
    /No rig-bridge handoff notification found/u,
  );
});
