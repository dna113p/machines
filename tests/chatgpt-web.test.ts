import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createSecureServer, type Server as SecureServer } from "node:https";
import { type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, beforeEach, test } from "node:test";

import {
  acknowledgeRigBridgeHandoff,
  chatGptWebAgent,
  chatGptWebContinue,
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

// chatGptWebContinue only accepts https://chatgpt.com conversations, so the test
// browser resolves that host to a local TLS listener serving the same fake page.
const certificate = await (async () => {
  const directory = await mkdtemp(join(tmpdir(), "machines-chatgpt-tls-"));
  try {
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=chatgpt.com",
      "-keyout", join(directory, "key.pem"), "-out", join(directory, "cert.pem"),
    ], { stdio: "ignore" });
    return { key: await readFile(join(directory, "key.pem")), cert: await readFile(join(directory, "cert.pem")) };
  } catch {
    return undefined;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
})();

let server: Server;
let secure: SecureServer | undefined;
let base: string;
let profile: string;
let cdpUrl: string;
const readHandoffs = new Set<string>();
const started = Date.now();
/** What the fake page reported: each send click and each tool approval. */
const pageEvents: { kind: string; text: string; at: number }[] = [];

const handoff = (id: string, threadId: string, createdAt: number, projectId = "p-1") => ({
  id, projectId, threadId, reason: "needs_input", summary: `Summary of ${id}`, createdAt, readAt: null,
});
const defaultNotifications = (now: number): unknown[] => [
  {
    id: "h-1",
    projectId: "p-1",
    threadId: "t-1",
    reason: "completed",
    summary: "Fixed test and passed verification",
    createdAt: now,
    readAt: readHandoffs.has("h-1") ? now : null,
  },
];
let notifications = defaultNotifications;

beforeEach(() => {
  pageEvents.length = 0;
  notifications = defaultNotifications;
});

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>(done => probe.listen(0, "127.0.0.1", done));
  const { port } = probe.address() as AddressInfo;
  await new Promise(done => probe.close(done));
  return port;
}

before(async () => {
  let opened: number | undefined;
  const handler = (req: IncomingMessage, res: ServerResponse) => {
    if (req.url === "/page-events" && req.method === "POST") {
      const chunks: Buffer[] = [];
      req.on("data", chunk => chunks.push(chunk));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { kind: string; text: string };
        pageEvents.push({ kind: body.kind, text: body.text, at: Date.now() });
        res.writeHead(204);
        res.end();
      });
      return;
    }
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
          // A second conversation working in the same directory.
          { id: "ws-2", projectId: "p-1", threadId: "t-2", cwd: workspace, createdAt: now },
          // rig-bridge keys a project by repository, so a worktree elsewhere shares the project.
          { id: "ws-worktree", projectId: "p-1", threadId: "t-worktree", cwd: `${workspace}-worktree`, createdAt: now },
        ],
        notifications: notifications(now),
        unreadCount: readHandoffs.has("h-1") ? 0 : 1,
      }));
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(page);
  };
  server = createServer(handler);
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  if (certificate !== undefined) {
    const listener = createSecureServer(certificate, handler);
    await new Promise<void>(done => listener.listen(0, "127.0.0.1", done));
    secure = listener;
  }
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
  if (secure !== undefined) {
    secure.closeAllConnections();
    await new Promise(done => secure!.close(done));
  }
  await rm(profile, { recursive: true, force: true, maxRetries: 5 });
  await rm(workspace, { recursive: true, force: true });
});

// Every test shares one browser, so whichever launches it must map chatgpt.com for the continuation tests.
const launch = () => ({
  headless: true,
  userDataDir: profile,
  args: [
    "--disable-gpu",
    ...(secure === undefined ? [] : [
      `--host-resolver-rules=MAP chatgpt.com 127.0.0.1:${(secure.address() as AddressInfo).port}`,
      "--ignore-certificate-errors",
    ]),
  ],
  ...(executable === undefined ? {} : { executable }),
});

const runner = (scenario: string, options: ChatGptWebAgentOptions = {}) => chatGptWebAgent({
  url: `${base}/?scenario=${scenario}`,
  cdpUrl,
  launch: launch(),
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

const skipContinue = executable === undefined ? "no Chromium browser" : certificate === undefined ? "no openssl" : false;
const conversation = (scenario: string) => `https://chatgpt.com/c/fake-conversation?scenario=${scenario}`;
const continuation = (options: ChatGptWebAgentOptions = {}) => chatGptWebContinue({
  cdpUrl,
  launch: launch(),
  bridgeStatusUrl: `${base}/api/status`,
  pollMs: 100,
  timeoutMs: 20_000,
  output: "capture",
  ...options,
});
const reported = (kind: string) => pageEvents.filter(event => event.kind === kind);
const staleHandoff = handoff("h-stale", "t-1", started - 60_000);
const openTabs = async () => (await (await fetch(`${cdpUrl}/json/list`)).json() as { url: string }[]).map(tab => tab.url);

test("ChatGPT Web continuation validates its input before touching a browser", async () => {
  const send = chatGptWebContinue({ cdpUrl: "http://127.0.0.1:9", launch: false, bridgeStatusUrl: `${base}/api/status` });
  const input = { conversation: "https://chatgpt.com/c/abc-123", text: "Yes, ship it.", cwd: workspace };
  for (const invalid of [
    "not a url",
    "http://chatgpt.com/c/abc-123",
    "https://example.com/c/abc-123",
    "https://chatgpt.com.example.com/c/abc-123",
    "https://chatgpt.com:8443/c/abc-123",
    "https://user:secret@chatgpt.com/c/abc-123",
    "https://chatgpt.com/",
    "https://chatgpt.com/c/",
    "https://chatgpt.com/?next=/c/abc-123",
  ]) {
    await assert.rejects(async () => send({ ...input, conversation: invalid }), (error: Error) => {
      assert.match(error.message, /requires an https:\/\/chatgpt\.com\/c\/<id> conversation URL without credentials/u);
      assert.ok(!error.message.includes("secret"));
      return true;
    });
  }
  await assert.rejects(async () => send({ ...input, text: "" }), /requires a non-empty message/u);
  await assert.rejects(async () => send({ ...input, text: " \n" }), /requires a non-empty message/u);
  await assert.rejects(async () => send({ ...input, cwd: undefined as unknown as string }), /requires a working directory/u);
  await assert.rejects(async () => send({ ...input, bridgeThreadId: "" }), /bridgeThreadId to be a non-empty string/u);
  await assert.rejects(
    async () => chatGptWebContinue({ cdpUrl: "http://127.0.0.1:9", launch: false, bridgeStatusUrl: false })(input),
    /requires a rig-bridge status URL/u,
  );
  // Only a valid request reaches the browser.
  await assert.rejects(
    async () => send({ ...input, conversation: "https://chatgpt.com/g/g-p-project/c/abc-123" }),
    /continuation failed for https:\/\/chatgpt\.com\/g\/g-p-project\/c\/abc-123: No browser DevTools endpoint at http:\/\/127\.0\.0\.1:9/u,
  );
});

test("ChatGPT Web continuation sends one message and returns the handoff created after it", { skip: skipContinue }, async () => {
  notifications = () => [staleHandoff, ...reported("sent").map(event => handoff("h-2", "t-1", event.at))];
  const updates: AgentUpdate[] = [];
  const event = await continuation()(
    { conversation: conversation("continue"), text: "Yes, ship it.", cwd: workspace },
    update => updates.push(update),
  );
  const sent = reported("sent");
  assert.deepEqual(sent.map(({ text }) => text.trim()), ["Yes, ship it."]);
  assert.deepEqual(event, {
    type: "needs_input",
    summary: "Summary of h-2",
    handoff: { id: "h-2", projectId: "p-1", threadId: "t-1", reason: "needs_input", summary: "Summary of h-2", createdAt: sent[0]!.at },
    conversation: conversation("continue"),
  });
  assert.ok(readHandoffs.has("h-2"), "Handoff should have been marked read");
  assert.ok(!readHandoffs.has("h-stale"));

  assert.deepEqual(updates[0], { type: "identity", harness: "chatgpt-web" });
  const tools = updates.filter(update => update.type === "tool");
  assert.ok(tools.some(update => update.id === "cmd-1" && update.title === "npm test" && update.status === "completed"));
  assert.ok(tools.some(update => update.id === "handoff:h-2" && update.status === "completed"));
  assert.ok(!tools.some(update => update.id === "handoff:h-stale" || update.id === "cmd-x"));
  assert.ok(tools.some(update => update.id === "chatgpt-conversation" && update.status === "completed"
    && update.title === `ChatGPT conversation ${conversation("continue")}`));
  assert.ok(!(await openTabs()).some(url => url.includes("scenario=continue")), "A successful run closes its tab");
});

test("ChatGPT Web continuation keeps assistant text from the page out of the event and reported output", { skip: skipContinue }, async () => {
  notifications = () => reported("sent").map(event => handoff("h-3", "t-1", event.at));
  const updates: AgentUpdate[] = [];
  const event = await continuation({ keepTab: true })(
    { conversation: conversation("page-text"), text: "Carry on.", cwd: workspace },
    update => updates.push(update),
  );
  assert.equal(event.handoff?.id, "h-3");
  assert.ok(!("message" in event));
  assert.ok((await openTabs()).some(url => url.includes("/c/fake-conversation")), "keepTab leaves the tab open");
  // The fake page shows an earlier reply on load and the new reply by the time generation stops.
  const output = JSON.stringify([event, updates]);
  for (const assistantText of ["Earlier assistant reply", "Finished the task", "MACHINES_EVENT", "Working"]) {
    assert.ok(!output.includes(assistantText), `"${assistantText}" leaked from the page`);
  }
  assert.ok(!updates.some(update => update.type === "output"));
});

test("ChatGPT Web continuation does not submit to a conversation that is still generating", { skip: skipContinue }, async () => {
  notifications = now => [handoff("h-busy", "t-1", now)];
  await assert.rejects(
    async () => continuation()({ conversation: conversation("busy"), text: "Are you done?", cwd: workspace }),
    /continuation failed for https:\/\/chatgpt\.com\/c\/fake-conversation\?scenario=busy: the conversation is busy/u,
  );
  assert.deepEqual(pageEvents, []);
  assert.ok((await openTabs()).some(url => url.includes("scenario=busy")), "A failed run keeps its tab");
});

test("ChatGPT Web continuation does not submit when generation starts while the message is entered", { skip: skipContinue }, async () => {
  // The conversation is idle when it opens; a reply starts before the fake send button is ready.
  notifications = now => [handoff("h-delayed-busy", "t-1", now)];
  await assert.rejects(
    async () => continuation()({ conversation: conversation("delayed-busy"), text: "Are you done?", cwd: workspace }),
    /scenario=delayed-busy: The ChatGPT conversation is busy generating a reply; the message was not sent/u,
  );
  assert.deepEqual(pageEvents, []);
  assert.ok(!readHandoffs.has("h-delayed-busy"));
  assert.ok((await openTabs()).some(url => url.includes("scenario=delayed-busy")), "A failed run keeps its tab");
});

test("ChatGPT Web continuation does not submit when the conversation did not open", { skip: skipContinue }, async () => {
  await assert.rejects(
    async () => continuation()({ conversation: conversation("moved"), text: "Hello again", cwd: workspace }),
    /instead of the conversation; the message was not sent/u,
  );
  assert.deepEqual(pageEvents, []);
});

test("ChatGPT Web continuation counts only the given rig-bridge thread's handoff", { skip: skipContinue }, async () => {
  // Another conversation in the same project hands off first; this thread's handoff follows.
  notifications = now => reported("sent").flatMap(event => [
    handoff("h-other", "t-2", event.at),
    ...(now - event.at > 500 ? [handoff("h-mine", "t-1", event.at + 500)] : []),
  ]);
  const updates: AgentUpdate[] = [];
  const event = await continuation()(
    { conversation: conversation("thread"), text: "Use the second option.", cwd: workspace, bridgeThreadId: "t-1" },
    update => updates.push(update),
  );
  assert.equal(event.handoff?.id, "h-mine");
  assert.equal(event.handoff?.threadId, "t-1");
  assert.equal(event.summary, "Summary of h-mine");
  assert.ok(!updates.some(update => update.type === "tool" && update.id === "handoff:h-other"));
  assert.ok(!readHandoffs.has("h-other"));

  // Without the thread id, the other conversation's handoff in this directory is the first to match.
  pageEvents.length = 0;
  const unscoped = await continuation()({ conversation: conversation("thread"), text: "Use the second option.", cwd: workspace });
  assert.equal(unscoped.handoff?.id, "h-other");
});

test("ChatGPT Web continuation ignores a handoff from another directory of the same project", { skip: skipContinue }, async () => {
  // A conversation working in another worktree of the project hands off first; this directory's handoff follows.
  notifications = now => reported("sent").flatMap(event => [
    handoff("h-worktree", "t-worktree", event.at),
    ...(now - event.at > 500 ? [handoff("h-here", "t-1", event.at + 500)] : []),
  ]);
  const updates: AgentUpdate[] = [];
  const event = await continuation()(
    { conversation: conversation("worktree"), text: "Merge it.", cwd: workspace },
    update => updates.push(update),
  );
  assert.equal(event.handoff?.id, "h-here");
  assert.equal(event.handoff?.projectId, "p-1");
  assert.ok(!updates.some(update => update.type === "tool" && update.id === "handoff:h-worktree"));
  assert.ok(!readHandoffs.has("h-worktree"));
});

test("ChatGPT Web continuation ignores a handoff recorded before the message was sent", { skip: skipContinue }, async () => {
  // The fake send button enables a second after the text is entered, and a handoff is recorded during that wait.
  notifications = now => reported("sent").flatMap(event => [
    ...(now - event.at > 300 ? [handoff("h-after", "t-1", event.at + 300)] : []),
    handoff("h-before", "t-1", event.at - 500),
  ]);
  const updates: AgentUpdate[] = [];
  const event = await continuation()(
    { conversation: conversation("slow-send"), text: "Second attempt.", cwd: workspace },
    update => updates.push(update),
  );
  assert.equal(reported("sent").length, 1);
  assert.equal(event.handoff?.id, "h-after");
  assert.ok(!updates.some(update => update.type === "tool" && update.id === "handoff:h-before"));
  assert.ok(!readHandoffs.has("h-before"));
});

test("ChatGPT Web continuation does not send a saved composer draft along with the message", { skip: skipContinue }, async () => {
  notifications = now => [handoff("h-draft", "t-1", now)];
  // The draft is already in the composer when the conversation opens.
  await assert.rejects(
    async () => continuation()({ conversation: conversation("draft"), text: "Yes, ship it.", cwd: workspace }),
    /continuation failed for https:\/\/chatgpt\.com\/c\/fake-conversation\?scenario=draft: the composer already holds unsent text; the message was not sent/u,
  );
  // The draft only appears as the message is entered.
  await assert.rejects(
    async () => continuation()({ conversation: conversation("late-draft"), text: "Yes, ship it.", cwd: workspace }),
    /scenario=late-draft: The ChatGPT composer holds text other than the prompt; the message was not sent/u,
  );
  // The draft appears after the message was entered, while the send button is still becoming ready.
  await assert.rejects(
    async () => continuation()({ conversation: conversation("delayed-draft"), text: "Yes, ship it.", cwd: workspace }),
    /scenario=delayed-draft: The ChatGPT composer holds text other than the prompt; the message was not sent/u,
  );
  assert.deepEqual(pageEvents, []);
  assert.ok(!readHandoffs.has("h-draft"));
  assert.ok((await openTabs()).some(url => url.includes("scenario=draft")), "A failed run keeps its tab");
});

test("ChatGPT Web continuation times out when no new handoff arrives for the workspace", { skip: skipContinue }, async () => {
  // A handoff from before the message, and a new one from a project with no workspace in this directory.
  notifications = now => [staleHandoff, handoff("h-elsewhere", "t-9", now, "p-9")];
  await assert.rejects(
    async () => continuation({ timeoutMs: 1_500 })({ conversation: conversation("timeout"), text: "Any progress?", cwd: workspace }),
    /continuation failed for https:\/\/chatgpt\.com\/c\/fake-conversation\?scenario=timeout: no rig-bridge handoff arrived within 1500 ms/u,
  );
  assert.equal(reported("sent").length, 1);

  // A new handoff does not count while no rig-bridge workspace is open in the requested directory.
  pageEvents.length = 0;
  notifications = now => [handoff("h-unmatched", "t-1", now)];
  await assert.rejects(
    async () => continuation({ timeoutMs: 1_500 })({ conversation: conversation("timeout"), text: "Any progress?", cwd: join(workspace, "missing") }),
    /no rig-bridge handoff arrived within 1500 ms/u,
  );
  assert.equal(reported("sent").length, 1);
  assert.ok(!readHandoffs.has("h-unmatched"));
});

test("ChatGPT Web continuation approves tool confirmations only when allowed", { skip: skipContinue }, async () => {
  notifications = () => reported("approved").map(event => handoff("h-approved", "t-1", event.at));
  const event = await continuation({ approveToolCalls: true })({ conversation: conversation("approve"), text: "Go ahead.", cwd: workspace });
  assert.equal(event.handoff?.id, "h-approved");

  pageEvents.length = 0;
  const updates: AgentUpdate[] = [];
  await assert.rejects(
    async () => continuation({ timeoutMs: 2_000 })(
      { conversation: conversation("approve"), text: "Go ahead.", cwd: workspace },
      update => updates.push(update),
    ),
    /no rig-bridge handoff arrived within 2000 ms/u,
  );
  assert.deepEqual(reported("approved"), []);
  assert.ok(updates.some(update => update.type === "output" && update.text.includes("waiting for tool approval")));
});

test("ChatGPT Web continuation reports uncertain delivery instead of sending again", { skip: skipContinue }, async () => {
  // The fake page registers the click but never clears the composer or starts generating.
  notifications = now => [handoff("h-late", "t-1", now)];
  await assert.rejects(
    async () => continuation()({ conversation: conversation("stuck"), text: "Did this arrive?", cwd: workspace }),
    /continuation failed for https:\/\/chatgpt\.com\/c\/fake-conversation\?scenario=stuck: delivery of the message is uncertain/u,
  );
  assert.equal(reported("sent").length, 1);
  assert.ok(!readHandoffs.has("h-late"));
  assert.ok((await openTabs()).some(url => url.includes("scenario=stuck")), "A failed run keeps its tab");
});
