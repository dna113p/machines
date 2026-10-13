import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, beforeEach, test } from "node:test";

import {
  chatGptWebAgent,
  chatGptWebContinue,
  chatGptWebPrompt,
  fetchLatestRigBridgeHandoff,
  fetchRigBridgeStatus,
  rigBridgeHandoffOperation,
  type ChatGptWebAgentOptions,
} from "../src/chatgpt-web.ts";
import type { AgentUpdate } from "../src/index.ts";
import { listAgentPresets } from "../src/launcher.ts";
import { startFakeBrowser, type FakeBrowser } from "./fixtures/fake-browser.ts";

const page = await readFile(resolve("tests/fixtures/fake-chatgpt.html"), "utf8");
const earlierPage = page.replace('data-markup="current"', 'data-markup="earlier"');
const workspace = await mkdtemp(join(tmpdir(), "machines-chatgpt-web-"));
const request = { prompt: "Fix the failing test", outcomes: ["completed", "blocked"], cwd: workspace };

let server: Server;
let browser: FakeBrowser;
let base: string;
let cdpUrl: string;
const readHandoffs = new Set<string>();
const started = Date.now();
/** What the fake page reported: each send click, tool approval, and change of address. */
const pageEvents: { kind: string; text: string; at: number }[] = [];
const reported = (kind: string) => pageEvents.filter(event => event.kind === kind);

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
/** The fake page has ChatGPT's markup as it is today, or as it was before. */
let markup: "current" | "earlier" = "current";

beforeEach(() => {
  pageEvents.length = 0;
  readHandoffs.clear();
  notifications = defaultNotifications;
  markup = "current";
});

/** Runs a test against both markups, since a rollout may not have reached every account. */
function onBothPages(name: string, run: () => Promise<void>): void {
  for (const served of ["current", "earlier"] as const) {
    test(`${name} (${served} page)`, async () => {
      markup = served;
      await run();
    });
  }
}

before(async () => {
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
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // No browser is started. Tabs open in a fake DevTools endpoint that loads the fake page whatever
  // their address, so the chatgpt.com addresses in these tests are never contacted.
  browser = await startFakeBrowser({
    page: () => markup === "earlier" ? earlierPage : page,
    fetch: (url, init) => {
      if (url.pathname !== "/page-events") return;
      const body = JSON.parse(init.body ?? "") as { kind: string; text: string };
      pageEvents.push({ kind: body.kind, text: body.text, at: Date.now() });
    },
  });
  cdpUrl = browser.cdpUrl;
});

after(async () => {
  await browser.close();
  await new Promise(done => server.close(done));
  await rm(workspace, { recursive: true, force: true });
});

const runner = (scenario: string, options: ChatGptWebAgentOptions = {}) => chatGptWebAgent({
  url: `https://chatgpt.com/?scenario=${scenario}`,
  cdpUrl,
  // Without the fake endpoint a run fails; it never starts a browser of its own.
  launch: false,
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

onBothPages("ChatGPT Web enables the connector, submits the task, captures handoff, and returns the final event", async () => {
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

onBothPages("ChatGPT Web falls back to work_handoff reason when MACHINES_EVENT line is omitted", async () => {
  const event = await runner("handoff-no-event")(request);
  assert.equal(event.type, "completed");
  assert.equal(event.summary, "Fixed test and passed verification");
  assert.equal(event.handoff?.id, "h-1");
});

onBothPages("ChatGPT Web falls back to typed input when paste is not handled", async () => {
  const event = await runner("no-paste", { selectConnector: false })(request);
  assert.equal(event.type, "completed");
  assert.equal(event.connector, false);
  assert.ok(typeof event.prompt === "string" && event.prompt.includes("Fix the failing test"));
});

onBothPages("ChatGPT Web approves tool confirmations only when allowed", async () => {
  const event = await runner("approve", { approveToolCalls: true })(request);
  assert.equal(event.type, "completed");
  const updates: AgentUpdate[] = [];
  await assert.rejects(
    async () => runner("approve", { timeoutMs: 2_000 })(request, update => updates.push(update)),
    /did not finish within 2000 ms[\s\S]*Conversation: .*\/c\/fake-conversation/u,
  );
  assert.ok(updates.some(update => update.type === "output" && update.text.includes("waiting for tool approval")));
});

onBothPages("ChatGPT Web reports replies without a Machines event and without a handoff", async () => {
  // If statusUrl is disabled, no handoff is observed and missing MACHINES_EVENT fails as expected
  await assert.rejects(async () => runner("no-event", { bridgeStatusUrl: false })(request), /finished without returning a Machines event/u);
});

test("ChatGPT Web returns the lasting address of a chat that first shows a temporary one", async () => {
  const updates: AgentUpdate[] = [];
  const event = await runner("temporary-address")(request, update => updates.push(update));
  assert.deepEqual(reported("address").map(({ text }) => text), [
    "/c/local-chatgpt%3A570c498e-7d4a-48a1-8e7a-d7367e869bf0",
    "/c/fake-conversation",
  ]);
  assert.equal(event.type, "completed");
  assert.equal(event.conversation, "https://chatgpt.com/c/fake-conversation");
  assert.equal(event.summary, "Fixed test and passed verification");
  assert.ok(!JSON.stringify([event.conversation, updates]).includes("local-chatgpt"), "the temporary address was reported");
  const tools = updates.filter(update => update.type === "tool").filter(update => update.id === "chatgpt-conversation");
  assert.ok(tools.length > 0 && tools.every(update => update.title === "ChatGPT conversation https://chatgpt.com/c/fake-conversation"));
  assert.equal(tools.at(-1)?.status, "completed");
});

test("ChatGPT Web returns no conversation when the chat never shows a lasting address", async () => {
  const updates: AgentUpdate[] = [];
  const event = await runner("no-lasting-address")(request, update => updates.push(update));
  assert.deepEqual(reported("address").map(({ text }) => text), ["/c/local-chatgpt%3A570c498e-7d4a-48a1-8e7a-d7367e869bf0"]);
  assert.equal(event.type, "completed");
  assert.ok(!("conversation" in event));
  assert.equal(event.handoff?.id, "h-1");
  assert.match(event.summary ?? "", /^Fixed test and passed verification\nChatGPT did not show the chat's lasting address/u);
  assert.ok(updates.some(update => update.type === "output" && update.text.includes("did not show the chat's lasting address")));
  assert.ok(!updates.some(update => update.type === "tool" && update.id === "chatgpt-conversation"));
  assert.ok(!JSON.stringify([event.summary, event.handoff, updates.filter(update => update.type === "tool")]).includes("local-chatgpt"));

  // A failed run does not name the temporary address either.
  await assert.rejects(
    async () => runner("no-lasting-address", { timeoutMs: 400 })(request),
    (error: Error) => {
      assert.match(error.message, /did not finish within 400 ms/u);
      assert.ok(!error.message.includes("Conversation:"));
      return true;
    },
  );
});

test("ChatGPT Web does not return a conversation address the assistant wrote in its event", async () => {
  const updates: AgentUpdate[] = [];
  const event = await runner("written-address")(request, update => updates.push(update));
  // The reply's event line carried the temporary address, and the page never showed a lasting one.
  assert.ok(updates.some(update => update.type === "output"
    && update.text.includes('"conversation":"https://chatgpt.com/c/local-chatgpt%3A570c498e-7d4a-48a1-8e7a-d7367e869bf0"')));
  assert.equal(event.type, "completed");
  assert.equal(event.connector, true);
  assert.ok(!("conversation" in event));
  assert.ok(!JSON.stringify(event).includes("local-chatgpt"));
  assert.match(event.summary ?? "", /ChatGPT did not show the chat's lasting address/u);
});

test("ChatGPT Web tells a signed-out page from out-of-date selectors when the composer does not appear", async () => {
  await assert.rejects(
    async () => runner("signed-out", { composerTimeoutMs: 1_000 })(request),
    (error: Error) => {
      assert.match(error.message, /composer did not appear at .*scenario=signed-out: the page shows a sign-in control, so the browser is not signed in\. Sign in to ChatGPT/u);
      assert.ok(!error.message.includes("selectors"));
      return true;
    },
  );
  // The page is signed in and has a composer, but not where the selectors look for it.
  await assert.rejects(
    async () => runner("normal", { composerTimeoutMs: 1_000, selectors: { composer: "#composer-of-another-day" } })(request),
    /composer did not appear at .*scenario=normal, and the page shows no sign-in control\. The page selectors are most likely out of date: .*override `selectors`/u,
  );
  assert.deepEqual(reported("sent"), []);
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

const conversation = (scenario: string) => `https://chatgpt.com/c/fake-conversation?scenario=${scenario}`;
const continuation = (options: ChatGptWebAgentOptions = {}) => chatGptWebContinue({
  cdpUrl,
  launch: false,
  bridgeStatusUrl: `${base}/api/status`,
  pollMs: 100,
  timeoutMs: 20_000,
  output: "capture",
  ...options,
});
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

test("ChatGPT Web continuation refuses a temporary address before it opens a tab", async () => {
  const send = chatGptWebContinue({ cdpUrl: "http://127.0.0.1:9", launch: false, bridgeStatusUrl: `${base}/api/status` });
  for (const temporary of [
    "https://chatgpt.com/c/local-chatgpt%3A570c498e-7d4a-48a1-8e7a-d7367e869bf0",
    "https://chatgpt.com/c/local-chatgpt:570c498e-7d4a-48a1-8e7a-d7367e869bf0",
    "https://chatgpt.com/g/g-p-project/c/local-chatgpt%3A570c498e-7d4a-48a1-8e7a-d7367e869bf0",
  ]) {
    await assert.rejects(async () => send({ conversation: temporary, text: "Yes, ship it.", cwd: workspace }), (error: Error) => {
      assert.match(error.message, /requires the chat's lasting https:\/\/chatgpt\.com\/c\/<id> address: "local-chatgpt(%3A|:)570c498e-7d4a-48a1-8e7a-d7367e869bf0" is a temporary identifier/u);
      // Reaching the browser would fail on the missing DevTools endpoint instead.
      assert.ok(!error.message.includes("DevTools"));
      return true;
    });
  }
});

test("ChatGPT Web continuation reports a signed-out page when the composer does not appear", async () => {
  await assert.rejects(
    async () => continuation({ composerTimeoutMs: 1_000 })({ conversation: conversation("signed-out"), text: "Hello again", cwd: workspace }),
    /continuation failed for https:\/\/chatgpt\.com\/c\/fake-conversation\?scenario=signed-out: ChatGPT composer did not appear at .*: the page shows a sign-in control, so the browser is not signed in/u,
  );
  assert.deepEqual(pageEvents, []);
});

onBothPages("ChatGPT Web continuation sends one message and returns the handoff created after it", async () => {
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

onBothPages("ChatGPT Web continuation keeps assistant text from the page out of the event and reported output", async () => {
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

onBothPages("ChatGPT Web continuation does not submit to a conversation that is still generating", async () => {
  notifications = now => [handoff("h-busy", "t-1", now)];
  await assert.rejects(
    async () => continuation()({ conversation: conversation("busy"), text: "Are you done?", cwd: workspace }),
    /continuation failed for https:\/\/chatgpt\.com\/c\/fake-conversation\?scenario=busy: the conversation is busy/u,
  );
  assert.deepEqual(pageEvents, []);
  assert.ok((await openTabs()).some(url => url.includes("scenario=busy")), "A failed run keeps its tab");
});

onBothPages("ChatGPT Web continuation does not submit when generation starts while the message is entered", async () => {
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

onBothPages("ChatGPT Web continuation does not submit when the conversation did not open", async () => {
  await assert.rejects(
    async () => continuation()({ conversation: conversation("moved"), text: "Hello again", cwd: workspace }),
    /instead of the conversation; the message was not sent/u,
  );
  assert.deepEqual(pageEvents, []);
});

onBothPages("ChatGPT Web continuation counts only the given rig-bridge thread's handoff", async () => {
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

onBothPages("ChatGPT Web continuation ignores a handoff from another directory of the same project", async () => {
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

onBothPages("ChatGPT Web continuation ignores a handoff recorded before the message was sent", async () => {
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

onBothPages("ChatGPT Web continuation does not send a saved composer draft along with the message", async () => {
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

onBothPages("ChatGPT Web continuation times out when no new handoff arrives for the workspace", async () => {
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

onBothPages("ChatGPT Web continuation approves tool confirmations only when allowed", async () => {
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

onBothPages("ChatGPT Web continuation reports uncertain delivery instead of sending again", async () => {
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
