import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { basename, dirname, join, resolve } from "node:path";

import type { HumanResponse } from "./index.ts";
import { respondToRun } from "./run-inbox.ts";
import { runUiPage } from "./run-ui-page.ts";
import { isProcessAlive, readRunStatuses, type RunStatusRecord } from "./run-status.ts";

/**
 * `machine ui`: a local page that shows every published run as it happens,
 * with its Machine's graph, and the project's own panels beside them. It reads
 * the run-status directory and answers a waiting run through its inbox, as
 * `machine respond` does; nothing else in the page changes anything.
 */
export interface RunUiOptions {
  /** The run-status directory. */
  readonly directory: string;
  /** The project whose `.machines/ui.json` names panels; its name heads the page. */
  readonly projectDir: string;
  readonly port?: number;
  /** How often the directory is read for changes. */
  readonly pollMilliseconds?: number;
}

export interface RunUi {
  readonly url: string;
  close(): Promise<void>;
}

/** A run as the page shows it: `lost` when its record says running or waiting and its process is gone. */
export type UiRun = Omit<RunStatusRecord, "status"> & { readonly status: RunStatusRecord["status"] | "lost" };

/** What a panel command prints: a few lines a person can take in at a glance. */
export interface UiPanel {
  readonly title: string;
  readonly summary?: string;
  readonly items: readonly UiPanelItem[];
  readonly error?: string;
  readonly checkedAt?: string;
}

export interface UiPanelItem {
  readonly text: string;
  readonly detail?: string;
  /** Colours the item: `bad` and `warn` draw the eye, `active` is work under way. */
  readonly status?: "ok" | "warn" | "bad" | "active" | "idle";
  readonly href?: string;
  readonly at?: string;
}

interface PanelSource {
  readonly title: string;
  readonly command: readonly string[];
  readonly refreshSeconds: number;
}

export const defaultUiPort = 4777;
const panelTimeoutMilliseconds = 30_000;
const maxPanelItems = 50;

/** The nearest directory at or above `start` that has a `.machines` directory, or `start` itself. */
export function uiProjectDir(start: string): string {
  let current = resolve(start);
  while (true) {
    if (existsSync(join(current, ".machines")) && statSync(join(current, ".machines")).isDirectory()) return current;
    const parent = dirname(current);
    if (parent === current) return resolve(start);
    current = parent;
  }
}

/** Every published run, with runs whose process is gone shown as lost. */
export function uiRuns(directory: string, isAlive: (pid: number) => boolean = isProcessAlive): UiRun[] {
  return readRunStatuses(directory)
    .map((record): UiRun => ((record.status === "running" || record.status === "waiting") && !isAlive(record.pid)
      ? { ...record, status: "lost" }
      : record))
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
}

/**
 * Reads `.machines/ui.json`: `{ "panels": [{ "title", "command": [...], "refreshSeconds"? }] }`.
 * A missing file is no panels; a malformed one is one panel saying what is wrong.
 */
export function readPanelSources(projectDir: string): { sources: PanelSource[]; error?: string } {
  const file = join(projectDir, ".machines", "ui.json");
  if (!existsSync(file)) return { sources: [] };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { panels?: unknown };
    if (!Array.isArray(parsed.panels)) throw new Error("panels must be an array");
    const sources = parsed.panels.map((panel: unknown, index): PanelSource => {
      const { title, command, refreshSeconds } = (panel ?? {}) as Record<string, unknown>;
      if (typeof title !== "string" || title.trim() === "") throw new Error(`panels[${index}].title must be a non-empty string`);
      if (!Array.isArray(command) || command.length === 0 || !command.every((part) => typeof part === "string")) {
        throw new Error(`panels[${index}].command must be a non-empty array of strings`);
      }
      if (refreshSeconds !== undefined && (typeof refreshSeconds !== "number" || !(refreshSeconds >= 1))) {
        throw new Error(`panels[${index}].refreshSeconds must be a number of at least 1`);
      }
      return { title, command, refreshSeconds: (refreshSeconds as number | undefined) ?? 10 };
    });
    return { sources };
  } catch (cause) {
    return { sources: [], error: `${file}: ${cause instanceof Error ? cause.message : String(cause)}` };
  }
}

/** Turns a panel command's output into a panel, or says why it could not. */
export function parsePanelOutput(title: string, stdout: string): UiPanel {
  const parsed = JSON.parse(stdout) as Record<string, unknown>;
  if (parsed === null || typeof parsed !== "object" || !Array.isArray(parsed.items)) {
    throw new Error("the command must print a JSON object with an items array");
  }
  const statuses = new Set(["ok", "warn", "bad", "active", "idle"]);
  const text = (value: unknown, limit: number) => typeof value === "string" && value.trim() !== "" ? value.slice(0, limit) : undefined;
  const items = parsed.items.slice(0, maxPanelItems).flatMap((item: unknown): UiPanelItem[] => {
    const entry = (item ?? {}) as Record<string, unknown>;
    const line = text(entry.text, 300);
    if (line === undefined) return [];
    const href = text(entry.href, 2000);
    return [{
      text: line,
      ...(text(entry.detail, 600) === undefined ? {} : { detail: text(entry.detail, 600)! }),
      ...(typeof entry.status === "string" && statuses.has(entry.status) ? { status: entry.status as UiPanelItem["status"] } : {}),
      // Only web links: a panel never gets the page to open anything else.
      ...(href !== undefined && /^https?:\/\//u.test(href) ? { href } : {}),
      ...(text(entry.at, 40) !== undefined && !Number.isNaN(Date.parse(entry.at as string)) ? { at: entry.at as string } : {}),
    }];
  });
  return { title, ...(text(parsed.summary, 300) === undefined ? {} : { summary: text(parsed.summary, 300)! }), items };
}

export async function startRunUi(options: RunUiOptions): Promise<RunUi> {
  const { directory, projectDir } = options;
  const token = randomBytes(24).toString("hex");
  const poll = options.pollMilliseconds ?? 1_000;
  const clients = new Set<ServerResponse>();
  const panels = new Map<string, { panel: UiPanel; checkedAt: number; running: boolean }>();
  let port = 0;
  let last = "";

  const refreshPanels = () => {
    const { sources, error } = readPanelSources(projectDir);
    if (error !== undefined) {
      panels.set("\0config", { panel: { title: "ui.json", items: [], error }, checkedAt: Date.now(), running: false });
    } else panels.delete("\0config");
    const wanted = new Set(sources.map((source) => source.title));
    for (const title of panels.keys()) if (title !== "\0config" && !wanted.has(title)) panels.delete(title);
    for (const source of sources) {
      const known = panels.get(source.title);
      if (known?.running || (known !== undefined && Date.now() - known.checkedAt < source.refreshSeconds * 1_000)) continue;
      const entry = { panel: known?.panel ?? { title: source.title, items: [] }, checkedAt: Date.now(), running: true };
      panels.set(source.title, entry);
      execFile(source.command[0]!, source.command.slice(1), {
        cwd: projectDir, timeout: panelTimeoutMilliseconds, maxBuffer: 4 * 1024 * 1024, encoding: "utf8",
      }, (failure, stdout, stderr) => {
        let panel: UiPanel;
        try {
          if (failure) throw new Error((stderr.trim() || failure.message).split("\n").slice(-3).join(" "));
          panel = parsePanelOutput(source.title, stdout);
        } catch (cause) {
          panel = { ...entry.panel, error: cause instanceof Error ? cause.message : String(cause) };
        }
        panels.set(source.title, { panel: { ...panel, checkedAt: new Date().toISOString() }, checkedAt: Date.now(), running: false });
        broadcast();
      });
    }
  };

  const snapshot = () => ({
    project: { name: basename(projectDir), dir: projectDir },
    directory,
    runs: uiRuns(directory),
    panels: [...panels.values()].map((entry) => entry.panel),
  });

  const broadcast = (force = false) => {
    const state = snapshot();
    const text = JSON.stringify(state);
    if (!force && text === last) return;
    last = text;
    for (const client of clients) client.write(`data: ${text}\n\n`);
  };

  const timer = setInterval(() => {
    refreshPanels();
    broadcast();
  }, poll);
  timer.unref();
  // A quiet connection is closed by some proxies and browsers; a comment keeps it open.
  const heartbeat = setInterval(() => { for (const client of clients) client.write(": ping\n\n"); }, 15_000);
  heartbeat.unref();

  const server: Server = createServer((request, response) => {
    void handle(request, response).catch((cause: unknown) => {
      if (!response.headersSent) send(response, 500, { error: cause instanceof Error ? cause.message : String(cause) });
      else response.end();
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse) {
    // Another site can make the browser send to this port, but not with this host name: a page served
    // from a name that resolves here (DNS rebinding) is refused, and only the page itself holds the token.
    const host = request.headers.host ?? "";
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return send(response, 421, { error: "unexpected host" });
    const url = new URL(request.url ?? "/", `http://${host}`);
    if (request.method === "GET" && url.pathname === "/") {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        "x-content-type-options": "nosniff",
      });
      response.end(runUiPage(token));
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/state") return send(response, 200, snapshot());
    if (request.method === "GET" && url.pathname === "/api/events") {
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
      clients.add(response);
      response.write(`data: ${JSON.stringify(snapshot())}\n\n`);
      request.on("close", () => clients.delete(response));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/respond") {
      if (request.headers["x-machines-ui"] !== token) return send(response, 403, { error: "missing or wrong page token" });
      const body = await readBody(request);
      const { runId, requestId, response: text, question } = body as Record<string, unknown>;
      if (typeof runId !== "string" || typeof requestId !== "string" || typeof text !== "string" || text.trim() === "") {
        return send(response, 400, { error: "runId, requestId, and a non-empty response are required" });
      }
      const answer: HumanResponse = question === true ? { type: "question", text } : text;
      try {
        await respondToRun({ directory, runId, requestId, response: answer });
      } catch (cause) {
        return send(response, 409, { error: cause instanceof Error ? cause.message : String(cause) });
      }
      broadcast(true);
      return send(response, 200, { ok: true });
    }
    send(response, 404, { error: "not found" });
  }

  const start = options.port ?? defaultUiPort;
  // The first free port from the one asked for: a second page for another project is not an error.
  for (let candidate = start; ; candidate += 1) {
    try {
      await new Promise<void>((resolveListen, rejectListen) => {
        server.once("error", rejectListen);
        server.listen(candidate, "127.0.0.1", () => {
          server.off("error", rejectListen);
          resolveListen();
        });
      });
      port = candidate;
      break;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EADDRINUSE" || candidate - start >= 20 || options.port === 0) throw cause;
    }
  }
  const address = server.address();
  if (address !== null && typeof address === "object") port = address.port;
  refreshPanels();

  return {
    url: `http://127.0.0.1:${port}/`,
    close: () => new Promise((resolveClose) => {
      clearInterval(timer);
      clearInterval(heartbeat);
      for (const client of clients) client.end();
      server.close(() => resolveClose());
    }),
  };
}

function send(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  let text = "";
  for await (const chunk of request) {
    text += String(chunk);
    if (text.length > 64 * 1024) throw new Error("request body too large");
  }
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}
