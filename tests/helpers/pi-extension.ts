import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import machinesExtension from "../../pi-extension/index.ts";

export interface Result {
  readonly content: readonly [{ readonly type: "text"; readonly text: string }];
  readonly details: unknown;
}

interface RegisteredTool {
  readonly name: string;
  readonly description?: string;
  readonly promptSnippet?: string;
  readonly promptGuidelines?: readonly string[];
  execute(id: string, params: Record<string, unknown>, signal: AbortSignal | undefined,
    update: unknown, context: Context): Promise<Result>;
  renderResult?(result: Result, options: { readonly expanded: boolean }, theme: Theme): { render(width: number): string[] };
}

export interface SessionEntry {
  readonly type: "custom" | "custom_message";
  readonly id: string;
  readonly parentId: string | null;
  readonly timestamp: string;
  readonly customType: string;
  readonly data?: unknown;
  readonly content?: unknown;
  readonly display?: boolean;
  readonly details?: unknown;
}

interface Context {
  readonly cwd: string;
  readonly ui: FakeUi;
  readonly hasUI?: boolean;
  readonly mode?: "tui";
  isIdle?(): boolean;
  hasPendingMessages?(): boolean;
  readonly sessionManager?: {
    getSessionId(): string;
    getEntries(): readonly SessionEntry[];
    getBranch(): readonly SessionEntry[];
  };
}

export interface Theme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

class FakeUi {
  widget: string[] | undefined;
  widgetUpdates = 0;
  widgetPlacement: "aboveEditor" | "belowEditor" | undefined;
  readonly notifications: Array<{ message: string; type?: string }> = [];
  readonly selections: Array<{ title: string; options: string[] }> = [];
  readonly inputs: Array<{ title: string; placeholder?: string }> = [];
  readonly selectionResponses: Array<string | undefined> = [];
  readonly inputResponses: Array<string | undefined> = [];

  async select(title: string, options: string[]) {
    this.selections.push({ title, options });
    return this.selectionResponses.shift();
  }

  async input(title: string, placeholder?: string) {
    this.inputs.push({ title, ...(placeholder === undefined ? {} : { placeholder }) });
    return this.inputResponses.shift();
  }

  notify(message: string, type?: "info" | "warning" | "error") {
    this.notifications.push({ message, ...(type === undefined ? {} : { type }) });
  }

  setWidget(_key: string,
    content: string[] | ((tui: unknown, theme: Theme) => { render(width: number): string[] }) | undefined,
    options?: { readonly placement?: "aboveEditor" | "belowEditor" }) {
    this.widgetUpdates += 1;
    this.widgetPlacement = options?.placement;
    const theme: Theme = { fg: (_color, text) => text, bold: (text) => text };
    this.widget = typeof content === "function" ? content(undefined, theme).render(120) : content;
  }
}

interface CustomMessage {
  readonly customType: string;
  readonly content: string | readonly { readonly type: string; readonly text?: string }[];
  readonly display: boolean;
  readonly details?: unknown;
}

interface DeliveryOptions {
  readonly triggerTurn?: boolean;
  readonly deliverAs?: "steer" | "followUp" | "nextTurn";
}

// This records Pi's public API, not a substitute wake policy. All registration,
// polling, event selection, cancellation, and deduplication run in the extension.
export function setup(cwd = resolve("tests/fixtures/pi-project"), sessionId: string = randomUUID(), entries: SessionEntry[] = []) {
  const tools = new Map<string, RegisteredTool>();
  const handlers = new Map<string, Array<(event: unknown, context: Context) => void | Promise<void>>>();
  const commands = new Map<string, { handler(args: string, context: Context): Promise<void> }>();
  const messages: Array<{ message: CustomMessage; options: DeliveryOptions | undefined; sessionId: string; idle: boolean }> = [];
  const state = { idle: true, sessionId };
  const append = (entry: Omit<SessionEntry, "id" | "parentId" | "timestamp">) => {
    entries.push({ ...entry, id: randomUUID(), parentId: entries.at(-1)?.id ?? null, timestamp: new Date().toISOString() });
  };
  const api: Parameters<typeof machinesExtension>[0] & {
    sendMessage(message: CustomMessage, options?: DeliveryOptions): void;
    appendEntry(customType: string, data?: unknown): void;
  } = {
    registerTool(tool) { tools.set(tool.name, tool as RegisteredTool); },
    registerCommand(name, command) { commands.set(name, command); },
    on(event, handler) {
      const registered = handlers.get(event) ?? [];
      registered.push(handler);
      handlers.set(event, registered);
      return () => { handlers.set(event, registered.filter(item => item !== handler)); };
    },
    sendMessage(message, options) {
      messages.push({ message, options, sessionId: state.sessionId, idle: state.idle });
      append({ type: "custom_message", ...message });
    },
    appendEntry(customType, data) { append({ type: "custom", customType, data }); },
  };
  machinesExtension(api);
  const ui = new FakeUi();
  const context: Context = {
    cwd, ui, hasUI: true, mode: "tui",
    isIdle: () => state.idle,
    hasPendingMessages: () => false,
    sessionManager: {
      getSessionId: () => state.sessionId,
      getEntries: () => entries,
      getBranch: () => entries,
    },
  };
  const emit = async (name: string, event: Record<string, unknown> = {}) => {
    for (const handler of handlers.get(name) ?? []) await handler({ type: name, ...event }, context);
  };
  const execute = (name: string, params: Record<string, unknown> = {}) => {
    const tool = tools.get(name);
    if (tool === undefined) throw new Error(`Tool ${name} was not registered`);
    return tool.execute("test-call", params, undefined, undefined, context);
  };
  return {
    tools, commands, sessionId, ui, context, execute, emit, messages, entries, state,
    start: (reason = "startup") => emit("session_start", { reason }),
    shutdown: (reason = "quit") => emit("session_shutdown", { reason }),
    settle: async () => {
      state.idle = true;
      await emit("agent_settled", { aborted: false });
    },
  };
}
