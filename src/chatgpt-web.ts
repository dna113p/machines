import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import * as v from "valibot";

import { agentPrompt, readAgentEvent } from "./agent-protocol.ts";
import type { AgentReporter, AgentRequest, AgentRunner, Event } from "./index.ts";

/** CSS selectors for the ChatGPT page. Override them when the web UI changes. */
export interface ChatGptWebSelectors {
  readonly composer: string;
  readonly send: string;
  readonly stop: string;
  readonly assistant: string;
  readonly plus: string;
  readonly menuItem: string;
}

export const defaultChatGptWebSelectors: ChatGptWebSelectors = {
  composer: "#prompt-textarea",
  send: 'button[data-testid="send-button"]',
  stop: 'button[data-testid="stop-button"]',
  assistant: '[data-message-author-role="assistant"]',
  plus: 'button[data-testid="composer-plus-btn"]',
  menuItem: '[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="option"]',
};

export interface ChatGptWebBrowserLaunch {
  /** Chromium-family executable. Defaults to `CHATGPT_WEB_BROWSER`, then a PATH search. */
  readonly executable?: string;
  /** Dedicated browser profile holding the ChatGPT login. */
  readonly userDataDir?: string;
  readonly headless?: boolean;
  readonly args?: readonly string[];
}

/** Explicit handoff notification recorded by rig-bridge when an assistant finishes a stretch of work. */
export interface RigBridgeHandoff {
  readonly id: string;
  readonly projectId: string;
  readonly threadId: string;
  readonly runId?: string;
  readonly reason: "completed" | "needs_input" | "blocked" | "failed" | "cancelled" | string;
  readonly summary: string;
  readonly createdAt: number;
}

/** Event returned by the ChatGPT Web runner, enriched with handoff and conversation metadata. */
export interface ChatGptWebEvent extends Event {
  readonly type: string;
  readonly summary?: string;
  readonly message?: string;
  readonly handoff?: RigBridgeHandoff;
  readonly conversation?: string;
}

export interface RigBridgeStatusView {
  readonly version?: string;
  readonly startedAt?: number;
  readonly uptimeSeconds?: number;
  readonly workspacesCount?: number;
  readonly activeCommandsCount?: number;
  readonly workspaces: readonly {
    readonly id: string;
    readonly projectId?: string;
    readonly threadId?: string;
    readonly cwd: string;
    readonly createdAt?: number;
  }[];
  readonly notifications?: readonly RigBridgeHandoff[];
  readonly unreadCount?: number;
}

export interface ChatGptWebAgentOptions {
  readonly env?: Readonly<Record<string, string>>;
  readonly harness?: string;
  /** Start page: ChatGPT, a Project, or a GPT. Defaults to `CHATGPT_WEB_URL` or https://chatgpt.com/. */
  readonly url?: string;
  /** Model slug appended as `?model=`. Defaults to `CHATGPT_WEB_MODEL`. */
  readonly model?: string;
  /** DevTools endpoint. Defaults to `CHATGPT_WEB_CDP_URL` or http://127.0.0.1:9222. */
  readonly cdpUrl?: string;
  /** Launch a persistent, detached browser when the endpoint is unreachable. Defaults to true. */
  readonly launch?: boolean | ChatGptWebBrowserLaunch;
  /** Name of the rig-bridge app in ChatGPT. Defaults to `CHATGPT_WEB_CONNECTOR` or "rig-bridge". */
  readonly connector?: string;
  /** Try to enable the connector from the composer's + menu. Defaults to true. */
  readonly selectConnector?: boolean;
  /** Click visible tool confirmation buttons. Defaults to false. */
  readonly approveToolCalls?: boolean;
  readonly approveLabels?: readonly string[];
  /** rig-bridge status endpoint used for activity, or false. Defaults to `RIG_BRIDGE_STATUS_URL` or :8767. */
  readonly bridgeStatusUrl?: string | false;
  /** Automatically mark handoff notifications read on rig-bridge when completed. Defaults to true. */
  readonly acknowledgeHandoff?: boolean;
  readonly timeoutMs?: number;
  /** Quiet period after generation stops before the reply is treated as final. */
  readonly settleMs?: number;
  readonly pollMs?: number;
  /** Keep the tab after success. Failed runs always keep their tab for inspection. */
  readonly keepTab?: boolean;
  readonly selectors?: Partial<ChatGptWebSelectors>;
  readonly output?: "capture" | "stream";
}

const browserCandidates = [
  "google-chrome-stable", "google-chrome", "google-chrome-beta", "chromium", "chromium-browser",
  "brave-browser", "brave", "microsoft-edge", "microsoft-edge-stable", "vivaldi",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
];

/** Finds a Chromium-family browser able to expose the DevTools protocol. */
export async function findChromeExecutable(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<string | undefined> {
  if (env.CHATGPT_WEB_BROWSER !== undefined && env.CHATGPT_WEB_BROWSER !== "") return env.CHATGPT_WEB_BROWSER;
  const directories = (env.PATH ?? "").split(delimiter).filter(entry => entry !== "");
  for (const candidate of browserCandidates) {
    const paths = candidate.startsWith("/") ? [candidate] : directories.map(directory => join(directory, candidate));
    for (const path of paths) {
      try {
        await access(path, constants.X_OK);
        return path;
      } catch { /* try the next candidate */ }
    }
  }
  return undefined;
}

export function defaultChatGptWebProfile(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const state = env.XDG_STATE_HOME !== undefined && env.XDG_STATE_HOME !== ""
    ? env.XDG_STATE_HOME
    : join(homedir(), ".local", "state");
  return join(state, "machines", "chatgpt-web-profile");
}

/** Builds the conversation opener that points ChatGPT at the local workspace through rig-bridge. */
export function chatGptWebPrompt(request: AgentRequest & { readonly cwd: string }, connector: string): string {
  return [
    `You are working on my local computer through the "${connector}" connector (MCP tools such as workspace_open, read, ls, find, grep, write, edit, and bash).`,
    `First call workspace_open with cwd ${JSON.stringify(request.cwd)} and follow the project instructions it returns.`,
    "Do every file read, edit, and command through that workspace's tools. Nobody is watching this conversation, so do not ask me to run anything or wait for replies.",
    `Immediately before returning control in your final reply, call work_handoff with workspace_id, a fresh request_key, reason matching one of: ${request.outcomes.join(", ")} (or completed, needs_input, blocked, failed, cancelled), and a short summary.`,
    "Close the workspace with workspace_close when you are finished.",
    "",
    agentPrompt(request),
    "Write the MACHINES_EVENT line as plain text on its own line, not inside a code block.",
  ].join("\n");
}

export type ChatGptWebAgentRunner = (
  request: AgentRequest,
  report?: AgentReporter,
) => Promise<ChatGptWebEvent>;

/** Runs one fresh ChatGPT web conversation that works in the request's directory via rig-bridge. */
export function chatGptWebAgent(options: ChatGptWebAgentOptions = {}): ChatGptWebAgentRunner {
  return async (request, report): Promise<ChatGptWebEvent> => {
    if (request.cwd === undefined) throw new Error("ChatGPT Web Agent requires a working directory");
    if (request.outcomes.length === 0) throw new Error("ChatGPT Web Agent requires at least one allowed outcome");

    const env = { ...process.env, ...options.env };
    const cwd = resolve(request.cwd);
    const connector = options.connector ?? env.CHATGPT_WEB_CONNECTOR ?? "rig-bridge";
    const model = options.model ?? env.CHATGPT_WEB_MODEL;
    const cdpUrl = (options.cdpUrl ?? env.CHATGPT_WEB_CDP_URL ?? "http://127.0.0.1:9222").replace(/\/+$/u, "");
    const statusUrl = options.bridgeStatusUrl === false ? undefined
      : options.bridgeStatusUrl ?? env.RIG_BRIDGE_STATUS_URL ?? "http://127.0.0.1:8767/api/status";
    const selectors = { ...defaultChatGptWebSelectors, ...options.selectors };
    const outputMode = options.output ?? "stream";
    const timeoutMs = options.timeoutMs ?? 60 * 60_000;
    const settleMs = options.settleMs ?? 5_000;
    const pollMs = options.pollMs ?? 1_000;
    const start = new URL(options.url ?? env.CHATGPT_WEB_URL ?? "https://chatgpt.com/");
    if (model !== undefined) start.searchParams.set("model", model);

    report?.({
      type: "identity",
      harness: options.harness ?? "chatgpt-web",
      ...(model === undefined ? {} : { model }),
    });
    const emit = (text: string) => {
      const line = text.endsWith("\n") ? text : `${text}\n`;
      report?.({ type: "output", text: line });
      if (outputMode === "stream") process.stdout.write(line);
    };

    let page: CdpPage | undefined;
    let targetId: string | undefined;
    let conversation: string | undefined;
    let succeeded = false;
    try {
      await ensureBrowser(cdpUrl, options.launch ?? true, env);
      targetId = await createTarget(cdpUrl, start.href);
      page = await CdpPage.connect(await targetSocket(cdpUrl, targetId));
      await page.send("Runtime.enable");
      await page.send("Page.enable");
      await page.send("Page.bringToFront");

      const ready = await waitFor(page, selectors, snapshot => snapshot.composer, 45_000, pollMs);
      if (ready === undefined) {
        const url = (await snapshot(page, selectors)).url;
        throw new Error(`ChatGPT composer did not appear at ${url}. Sign in to ChatGPT in the automation browser profile and retry`);
      }
      if (options.selectConnector ?? true) {
        if (!await selectConnector(page, selectors, connector)) {
          emit(`Could not enable "${connector}" from the composer menu; relying on the prompt to invoke it.`);
        }
      }

      const baseline = (await snapshot(page, selectors)).assistantCount;
      await submitPrompt(page, selectors, chatGptWebPrompt({ ...request, cwd }, connector), pollMs);

      const bridge = statusUrl === undefined ? undefined : new BridgeActivity(statusUrl, cwd, Date.now() - 2_000, report);
      const deadline = Date.now() + timeoutMs;
      const approveLabels = (options.approveLabels ?? ["Confirm", "Allow", "Approve", "Allow once"]).map(label => label.toLowerCase());
      let lastText = "";
      let changedAt = Date.now();
      let waitingReported = false;
      let finalText: string | undefined;
      while (Date.now() < deadline) {
        const current = await snapshot(page, selectors, approveLabels);
        if (conversation === undefined && /\/c\/[\w-]+/u.test(current.url)) {
          conversation = current.url;
          report?.({ type: "tool", id: "chatgpt-conversation", title: `ChatGPT conversation ${conversation}`, status: "in_progress" });
        }
        const busyBridge = await bridge?.poll() ?? false;
        const handoff = bridge?.latestHandoff;
        if (current.approval !== undefined) {
          if (options.approveToolCalls === true) {
            await click(page, current.approval);
            changedAt = Date.now();
          } else if (!waitingReported) {
            waitingReported = true;
            emit(`ChatGPT is waiting for tool approval in the browser tab${conversation === undefined ? "" : ` (${conversation})`}.`);
          }
        }
        const text = current.assistantCount > baseline ? current.lastAssistant : "";
        if (text !== lastText || current.generating || busyBridge || current.approval !== undefined) {
          if (text !== lastText) lastText = text;
          changedAt = Date.now();
        } else if (text !== "") {
          const quiet = Date.now() - changedAt;
          const hasEvent = /^MACHINES_EVENT /mu.test(text);
          // When rig-bridge notifies a handoff, the assistant has completed work; use a brief quiet window.
          const minQuiet = handoff !== undefined ? Math.min(settleMs, 1_000) : (hasEvent ? settleMs : settleMs * 4);
          if (quiet >= minQuiet) {
            finalText = text;
            break;
          }
        }
        await sleep(pollMs);
      }
      if (finalText === undefined) throw new Error(`ChatGPT did not finish within ${timeoutMs} ms`);
      await bridge?.poll();
      if (conversation !== undefined) {
        report?.({ type: "tool", id: "chatgpt-conversation", title: `ChatGPT conversation ${conversation}`, status: "completed" });
      }
      emit(finalText);

      const handoff = bridge?.latestHandoff;
      let event: Event;
      const hasMachinesEvent = /^MACHINES_EVENT /mu.test(finalText);
      if (hasMachinesEvent) {
        event = readAgentEvent(finalText, { adapter: "ChatGPT Web", includeMessage: outputMode === "capture" });
        if (handoff !== undefined) {
          event = {
            ...event,
            summary: (event.summary as string | undefined) ?? handoff.summary,
            handoff,
          };
        }
      } else if (handoff !== undefined) {
        // Fallback: ChatGPT signaled work_handoff via MCP without adding a MACHINES_EVENT line in chat.
        const type = request.outcomes.includes(handoff.reason) ? handoff.reason
          : request.outcomes.length === 1 && (handoff.reason === "completed" || handoff.reason === "done")
          ? request.outcomes[0]!
          : handoff.reason;
        event = {
          type,
          summary: handoff.summary,
          handoff,
          ...(outputMode === "capture" && finalText.trim() !== "" ? { message: finalText.trim() } : {}),
        };
      } else {
        event = readAgentEvent(finalText, { adapter: "ChatGPT Web", includeMessage: outputMode === "capture" });
      }

      if (conversation !== undefined) {
        event = { ...event, conversation };
      }

      if (handoff !== undefined && (options.acknowledgeHandoff ?? true)) {
        await bridge?.acknowledge(handoff.id);
      }

      succeeded = true;
      return event;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      throw new Error(
        `ChatGPT Web Agent failed for "${cwd}": ${message}${conversation === undefined ? "" : `\nConversation: ${conversation}`}`,
        { cause },
      );
    } finally {
      page?.close();
      if (targetId !== undefined && succeeded && options.keepTab !== true) {
        await fetch(`${cdpUrl}/json/close/${targetId}`).catch(() => undefined);
      }
    }
  };
}

// ---------------------------------------------------------------------------
// Browser and DevTools protocol

const versionSchema = v.object({ webSocketDebuggerUrl: v.string() });
const targetListSchema = v.array(v.object({ id: v.string(), webSocketDebuggerUrl: v.optional(v.string()) }));

async function browserVersion(cdpUrl: string): Promise<v.InferOutput<typeof versionSchema> | undefined> {
  try {
    const response = await fetch(`${cdpUrl}/json/version`, { signal: AbortSignal.timeout(2_000) });
    if (!response.ok) return undefined;
    const parsed = v.safeParse(versionSchema, await response.json());
    return parsed.success ? parsed.output : undefined;
  } catch {
    return undefined;
  }
}

async function ensureBrowser(
  cdpUrl: string,
  launch: boolean | ChatGptWebBrowserLaunch,
  env: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  if (await browserVersion(cdpUrl) !== undefined) return;
  if (launch === false) throw new Error(`No browser DevTools endpoint at ${cdpUrl}`);
  const endpoint = new URL(cdpUrl);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname)) {
    throw new Error(`No browser DevTools endpoint at ${cdpUrl}; only local endpoints can be launched`);
  }
  const settings = launch === true ? {} : launch;
  const executable = settings.executable ?? await findChromeExecutable(env);
  if (executable === undefined) {
    throw new Error("No Chromium-family browser found; set CHATGPT_WEB_BROWSER or launch.executable");
  }
  const profile = settings.userDataDir ?? env.CHATGPT_WEB_PROFILE ?? defaultChatGptWebProfile(env);
  await mkdir(profile, { recursive: true, mode: 0o700 });
  // The browser is a shared, persistent resource holding the login. Detach it so
  // terminating one Machine run does not close other conversations or sign out.
  const child = spawn(executable, [
    `--remote-debugging-port=${endpoint.port === "" ? "9222" : endpoint.port}`,
    `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check",
    ...(settings.headless === true ? ["--headless=new"] : []),
    ...(settings.args ?? []),
  ], { detached: true, stdio: "ignore" });
  const failed = new Promise<never>((_, reject) => child.once("error", reject));
  child.unref();
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const ready = await Promise.race([browserVersion(cdpUrl), failed]);
    if (ready !== undefined) return;
    await sleep(250);
  }
  throw new Error(`Browser "${executable}" did not expose DevTools at ${cdpUrl}`);
}

async function createTarget(cdpUrl: string, url: string): Promise<string> {
  const version = await browserVersion(cdpUrl);
  if (version === undefined) throw new Error(`No browser DevTools endpoint at ${cdpUrl}`);
  const browser = await CdpPage.connect(version.webSocketDebuggerUrl);
  try {
    const created = await browser.send("Target.createTarget", { url });
    if (typeof created.targetId !== "string") throw new Error("Browser did not create a tab");
    return created.targetId;
  } finally {
    browser.close();
  }
}

async function targetSocket(cdpUrl: string, targetId: string): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await fetch(`${cdpUrl}/json/list`);
    const targets = v.parse(targetListSchema, await response.json());
    const url = targets.find(target => target.id === targetId)?.webSocketDebuggerUrl;
    if (url !== undefined) return url;
    await sleep(100);
  }
  throw new Error("Browser tab is not available for automation");
}

type CdpResult = Record<string, unknown>;

class CdpPage {
  readonly #socket: WebSocket;
  readonly #pending = new Map<number, { resolve: (value: CdpResult) => void; reject: (error: Error) => void }>();
  #next = 1;

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.addEventListener("message", message => {
      let data: { id?: number; result?: CdpResult; error?: { message?: string } };
      try { data = JSON.parse(String(message.data)); } catch { return; }
      if (data.id === undefined) return;
      const pending = this.#pending.get(data.id);
      if (pending === undefined) return;
      this.#pending.delete(data.id);
      if (data.error !== undefined) pending.reject(new Error(data.error.message ?? "DevTools request failed"));
      else pending.resolve(data.result ?? {});
    });
    socket.addEventListener("close", () => {
      for (const pending of this.#pending.values()) pending.reject(new Error("Browser connection closed"));
      this.#pending.clear();
    });
  }

  static connect(url: string): Promise<CdpPage> {
    return new Promise((resolveConnect, reject) => {
      const socket = new WebSocket(url);
      socket.addEventListener("open", () => resolveConnect(new CdpPage(socket)), { once: true });
      socket.addEventListener("error", () => reject(new Error(`Could not connect to ${url}`)), { once: true });
    });
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<CdpResult> {
    const id = this.#next++;
    return new Promise((resolveSend, reject) => {
      this.#pending.set(id, { resolve: resolveSend, reject });
      this.#socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async call<A, R>(fn: (arg: A) => R, arg: A): Promise<Awaited<R>> {
    const result = await this.send("Runtime.evaluate", {
      expression: `(${fn.toString()})(${JSON.stringify(arg)})`,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails !== undefined) {
      const details = result.exceptionDetails as { exception?: { description?: string }; text?: string };
      throw new Error(details.exception?.description ?? details.text ?? "Page script failed");
    }
    return (result.result as { value?: Awaited<R> } | undefined)?.value as Awaited<R>;
  }

  close(): void {
    this.#socket.close();
  }
}

// ---------------------------------------------------------------------------
// Page interaction. Functions passed to `call` run inside the page and must be self-contained.

interface Point { readonly x: number; readonly y: number }
interface PageSnapshot {
  readonly url: string;
  readonly composer: boolean;
  readonly composerText: string;
  readonly generating: boolean;
  readonly sendEnabled: boolean;
  readonly assistantCount: number;
  readonly lastAssistant: string;
  readonly approval?: Point;
}

function pageSnapshot(arg: { selectors: ChatGptWebSelectors; approveLabels: string[] }): PageSnapshot {
  const { selectors, approveLabels } = arg;
  const composer = document.querySelector(selectors.composer);
  const send = document.querySelector(selectors.send);
  const assistants = document.querySelectorAll(selectors.assistant);
  const last = assistants[assistants.length - 1] as HTMLElement | undefined;
  let approval: { x: number; y: number } | undefined;
  if (approveLabels.length > 0) {
    for (const button of Array.from(document.querySelectorAll("button"))) {
      if (composer !== null && button.closest("form")?.contains(composer)) continue;
      if (!approveLabels.includes(button.innerText.trim().toLowerCase()) || button.disabled) continue;
      const rect = button.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      button.scrollIntoView({ block: "center" });
      const moved = button.getBoundingClientRect();
      approval = { x: moved.left + moved.width / 2, y: moved.top + moved.height / 2 };
      break;
    }
  }
  return {
    url: location.href,
    composer: composer !== null,
    composerText: composer instanceof HTMLTextAreaElement ? composer.value : (composer as HTMLElement | null)?.innerText ?? "",
    generating: document.querySelector(selectors.stop) !== null,
    sendEnabled: send instanceof HTMLButtonElement && !send.disabled,
    assistantCount: assistants.length,
    lastAssistant: last?.innerText ?? "",
    ...(approval === undefined ? {} : { approval }),
  };
}

function locate(arg: { selector: string; text?: string }): { x: number; y: number } | undefined {
  const candidates = Array.from(document.querySelectorAll(arg.selector)) as HTMLElement[];
  const pattern = arg.text?.toLowerCase();
  const element = candidates.find(candidate => {
    const rect = candidate.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    return pattern === undefined || candidate.innerText.toLowerCase().includes(pattern);
  });
  if (element === undefined) return undefined;
  element.scrollIntoView({ block: "center" });
  const rect = element.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

function pasteText(arg: { selector: string; text: string }): boolean {
  const composer = document.querySelector(arg.selector) as HTMLElement | null;
  if (composer === null) return false;
  composer.focus();
  if (composer instanceof HTMLTextAreaElement) {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(composer, arg.text);
    composer.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  }
  // ChatGPT's ProseMirror composer keeps paragraphs from a pasted plain-text payload.
  const data = new DataTransfer();
  data.setData("text/plain", arg.text);
  composer.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  return true;
}

function snapshot(page: CdpPage, selectors: ChatGptWebSelectors, approveLabels: string[] = []): Promise<PageSnapshot> {
  return page.call(pageSnapshot, { selectors, approveLabels });
}

async function waitFor(
  page: CdpPage,
  selectors: ChatGptWebSelectors,
  predicate: (snapshot: PageSnapshot) => boolean,
  timeoutMs: number,
  pollMs: number,
): Promise<PageSnapshot | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const current = await snapshot(page, selectors);
      if (predicate(current)) return current;
    } catch { /* the page may be navigating */ }
    await sleep(Math.min(pollMs, 250));
  }
  return undefined;
}

async function click(page: CdpPage, point: Point): Promise<void> {
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
  await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
  await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
}

async function locateWithin(page: CdpPage, selector: string, text: string | undefined, timeoutMs: number): Promise<Point | undefined> {
  const deadline = Date.now() + timeoutMs;
  do {
    const point = await page.call(locate, text === undefined ? { selector } : { selector, text });
    if (point !== undefined) return point;
    await sleep(100);
  } while (Date.now() < deadline);
  return undefined;
}

async function selectConnector(page: CdpPage, selectors: ChatGptWebSelectors, connector: string): Promise<boolean> {
  const plus = await locateWithin(page, selectors.plus, undefined, 2_000);
  if (plus === undefined) return false;
  await click(page, plus);
  let item = await locateWithin(page, selectors.menuItem, connector, 1_000);
  for (const submenu of ["Developer mode", "More"]) {
    if (item !== undefined) break;
    const parent = await locateWithin(page, selectors.menuItem, submenu, 300);
    if (parent === undefined) continue;
    await click(page, parent);
    item = await locateWithin(page, selectors.menuItem, connector, 1_000);
  }
  if (item !== undefined) await click(page, item);
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  return item !== undefined;
}

const normalize = (text: string) => text.replace(/\s+/gu, " ").trim();

async function submitPrompt(page: CdpPage, selectors: ChatGptWebSelectors, prompt: string, pollMs: number): Promise<void> {
  const probe = normalize(prompt).slice(0, 60);
  const typed = (current: PageSnapshot) => normalize(current.composerText).includes(probe);
  await page.call(pasteText, { selector: selectors.composer, text: prompt });
  if (await waitFor(page, selectors, typed, 1_500, pollMs) === undefined) {
    const composer = await locateWithin(page, selectors.composer, undefined, 1_000);
    if (composer === undefined) throw new Error("ChatGPT composer is unavailable");
    await click(page, composer);
    await page.send("Input.insertText", { text: prompt });
    if (await waitFor(page, selectors, typed, 3_000, pollMs) === undefined) {
      throw new Error("Could not enter the prompt into the ChatGPT composer");
    }
  }

  const ready = await waitFor(page, selectors, current => current.sendEnabled, 10_000, pollMs);
  const send = ready === undefined ? undefined : await locateWithin(page, selectors.send, undefined, 500);
  if (send !== undefined) await click(page, send);
  else {
    await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
    await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  }
  const accepted = await waitFor(page, selectors, current => current.generating || !typed(current), 15_000, pollMs);
  if (accepted === undefined) throw new Error("ChatGPT did not accept the prompt");
}

// ---------------------------------------------------------------------------
// rig-bridge activity and handoffs

const commandSchema = v.object({
  id: v.string(),
  tool: v.string(),
  description: v.optional(v.string()),
  startedAt: v.number(),
  success: v.optional(v.boolean()),
});

const handoffSchema = v.object({
  id: v.string(),
  projectId: v.string(),
  threadId: v.string(),
  runId: v.optional(v.string()),
  reason: v.string(),
  summary: v.string(),
  createdAt: v.number(),
  readAt: v.optional(v.nullable(v.number())),
});

const statusSchema = v.object({
  version: v.optional(v.string()),
  startedAt: v.optional(v.number()),
  uptimeSeconds: v.optional(v.number()),
  workspacesCount: v.optional(v.number()),
  activeCommandsCount: v.optional(v.number()),
  workspaces: v.array(v.object({
    id: v.string(),
    projectId: v.optional(v.string()),
    threadId: v.optional(v.string()),
    cwd: v.string(),
    createdAt: v.optional(v.number()),
    activeCommands: v.optional(v.array(commandSchema)),
    recentCommands: v.optional(v.array(commandSchema)),
  })),
  notifications: v.optional(v.array(handoffSchema)),
  unreadCount: v.optional(v.number()),
});

/** Mirrors commands and tracks handoffs that ChatGPT runs through rig-bridge in the target directory. */
class BridgeActivity {
  readonly #reported = new Map<string, string>();
  readonly #url: string;
  readonly #readUrl: string;
  readonly #cwd: string;
  readonly #since: number;
  readonly #report: AgentReporter | undefined;
  readonly #knownWorkspaceIds = new Set<string>();
  readonly #knownThreadIds = new Set<string>();
  readonly #knownProjectIds = new Set<string>();
  #latestHandoff: RigBridgeHandoff | undefined;

  constructor(url: string, cwd: string, since: number, report: AgentReporter | undefined) {
    this.#url = url;
    this.#readUrl = url.replace(/\/api\/status\/?$/u, "/api/handoffs/read");
    this.#cwd = cwd;
    this.#since = since;
    this.#report = report;
  }

  get latestHandoff(): RigBridgeHandoff | undefined {
    return this.#latestHandoff;
  }

  /** Returns true while a matching workspace has an active command. */
  async poll(): Promise<boolean> {
    let status: v.InferOutput<typeof statusSchema>;
    try {
      const response = await fetch(this.#url, { signal: AbortSignal.timeout(2_000) });
      if (!response.ok) return false;
      const parsed = v.safeParse(statusSchema, await response.json());
      if (!parsed.success) return false;
      status = parsed.output;
    } catch {
      return false;
    }
    let busy = false;
    for (const workspace of status.workspaces) {
      if (resolve(workspace.cwd) !== this.#cwd) continue;
      this.#knownWorkspaceIds.add(workspace.id);
      if (workspace.threadId) this.#knownThreadIds.add(workspace.threadId);
      if (workspace.projectId) this.#knownProjectIds.add(workspace.projectId);

      if ((workspace.createdAt ?? 0) >= this.#since) {
        this.#update(`workspace:${workspace.id}`, `workspace_open ${workspace.cwd}`, "completed");
      }
      for (const command of workspace.recentCommands ?? []) {
        if (command.startedAt < this.#since) continue;
        this.#update(command.id, command.description ?? command.tool, command.success === false ? "failed" : "completed");
      }
      for (const command of workspace.activeCommands ?? []) {
        if (command.startedAt < this.#since) continue;
        busy = true;
        this.#update(command.id, command.description ?? command.tool, "in_progress");
      }
    }

    for (const notification of status.notifications ?? []) {
      if (notification.createdAt < this.#since) continue;
      const matchesThread = this.#knownThreadIds.has(notification.threadId);
      const matchesProject = this.#knownProjectIds.has(notification.projectId);
      if ((this.#knownThreadIds.size > 0 || this.#knownProjectIds.size > 0) && !matchesThread && !matchesProject) continue;

      if (this.#latestHandoff === undefined || this.#latestHandoff.id !== notification.id) {
        this.#latestHandoff = {
          id: notification.id,
          projectId: notification.projectId,
          threadId: notification.threadId,
          ...(notification.runId ? { runId: notification.runId } : {}),
          reason: notification.reason,
          summary: notification.summary,
          createdAt: notification.createdAt,
        };
        this.#update(`handoff:${notification.id}`, `work_handoff (${notification.reason}): ${notification.summary}`, "completed");
      }
    }

    return busy;
  }

  async acknowledge(handoffId: string): Promise<boolean> {
    try {
      const response = await fetch(this.#readUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ handoff_id: handoffId }),
        signal: AbortSignal.timeout(3_000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  #update(id: string, title: string, status: "in_progress" | "completed" | "failed"): void {
    const previous = this.#reported.get(id);
    if (previous === status || previous === "completed" || previous === "failed") return;
    this.#reported.set(id, status);
    this.#report?.({ type: "tool", id, title, status });
  }
}

/** Fetches the latest bridge status from rig-bridge. */
export async function fetchRigBridgeStatus(
  statusUrl = process.env.RIG_BRIDGE_STATUS_URL ?? "http://127.0.0.1:8767/api/status",
): Promise<RigBridgeStatusView | undefined> {
  try {
    const response = await fetch(statusUrl, { signal: AbortSignal.timeout(3_000) });
    if (!response.ok) return undefined;
    const parsed = v.safeParse(statusSchema, await response.json());
    return parsed.success ? parsed.output : undefined;
  } catch {
    return undefined;
  }
}

/** Finds the most recent handoff notification from rig-bridge matching the given directory or thread. */
export async function fetchLatestRigBridgeHandoff(
  options: {
    readonly cwd?: string;
    readonly threadId?: string;
    readonly statusUrl?: string;
    readonly since?: number;
  } = {},
): Promise<RigBridgeHandoff | undefined> {
  const status = await fetchRigBridgeStatus(options.statusUrl);
  if (!status || !status.notifications || status.notifications.length === 0) return undefined;
  const targetCwd = options.cwd ? resolve(options.cwd) : undefined;
  const threadIds = new Set<string>();
  const projectIds = new Set<string>();
  if (targetCwd !== undefined) {
    let matched = false;
    for (const ws of status.workspaces) {
      if (resolve(ws.cwd) === targetCwd) {
        matched = true;
        if (ws.threadId) threadIds.add(ws.threadId);
        if (ws.projectId) projectIds.add(ws.projectId);
      }
    }
    if (!matched && !options.threadId) return undefined;
  }

  for (const notification of status.notifications) {
    if (options.since !== undefined && notification.createdAt < options.since) continue;
    if ((threadIds.size > 0 || projectIds.size > 0) && !threadIds.has(notification.threadId) && !projectIds.has(notification.projectId)) {
      continue;
    }
    return {
      id: notification.id,
      projectId: notification.projectId,
      threadId: notification.threadId,
      ...(notification.runId ? { runId: notification.runId } : {}),
      reason: notification.reason,
      summary: notification.summary,
      createdAt: notification.createdAt,
    };
  }
  return undefined;
}

/** Acknowledges / marks read a handoff on rig-bridge. */
export async function acknowledgeRigBridgeHandoff(
  handoffId: string,
  options: { readonly statusUrl?: string } = {},
): Promise<boolean> {
  const base = (options.statusUrl ?? process.env.RIG_BRIDGE_STATUS_URL ?? "http://127.0.0.1:8767/api/status")
    .replace(/\/api\/status\/?$/u, "/api/handoffs/read");
  try {
    const response = await fetch(base, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ handoff_id: handoffId }),
      signal: AbortSignal.timeout(3_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Creates an Operation for a Machine that inspects rig-bridge for the latest handoff notification,
 * returning an Event with `type = handoff.reason` and attaching `summary` and `handoff`.
 */
export function rigBridgeHandoffOperation(
  options: {
    readonly cwd?: string;
    readonly threadId?: string;
    readonly statusUrl?: string;
    readonly since?: number;
    readonly acknowledge?: boolean;
  } = {},
): () => Promise<ChatGptWebEvent> {
  return async () => {
    const handoff = await fetchLatestRigBridgeHandoff(options);
    if (handoff === undefined) {
      throw new Error("No rig-bridge handoff notification found");
    }
    if (options.acknowledge ?? true) {
      await acknowledgeRigBridgeHandoff(handoff.id, options);
    }
    return {
      type: handoff.reason,
      summary: handoff.summary,
      handoff,
    };
  };
}
