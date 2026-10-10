import { randomUUID } from "node:crypto";
import { linkSync, readFileSync, renameSync, rmSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import type { HumanRequest, HumanResponse, HumanRunner } from "./index.ts";
import {
  deliveryRetentionMilliseconds,
  isFileSafeId,
  isProcessAlive,
  readRunStatuses,
  runDeliveryPath,
  runInboxPath,
  type RunStatusHuman,
  type RunStatusRecord,
} from "./run-status.ts";
import { TerminalInputClosed, terminalHuman } from "./terminal-human.ts";

/** The content of `<MACHINES_RUN_STATUS_DIR>/<id>.inbox`: one response to one request. */
interface InboxMessage {
  /**
   * Tells one delivery from another that carries the same response. A response
   * without one can be neither confirmed nor taken back.
   */
  readonly delivery?: string;
  readonly requestId: string;
  readonly response: HumanResponse;
}

type PendingRequest = Pick<RunStatusHuman, "choices" | "discussion"> & { readonly requestId: string };

const pollMilliseconds = 100;
const confirmationMilliseconds = 5_000;

export interface RunResponse {
  readonly directory: string;
  readonly runId: string;
  readonly requestId: string;
  readonly response: HumanResponse;
  /** How long to wait for the run to take the response. */
  readonly timeoutMilliseconds?: number;
}

/**
 * Answers a waiting run from another process of the same user. Resolves once
 * the run has left the request and named this delivery among the responses it
 * took; otherwise throws, having taken the response back unless the run
 * already has it.
 */
export async function respondToRun(options: RunResponse): Promise<void> {
  const { directory, runId, requestId, response } = options;
  const published = () => (isFileSafeId(runId)
    ? readRunStatuses(directory).find((record) => record.id === runId)
    : undefined);
  const record = published();
  if (record === undefined) throw new Error(`Machine run "${runId}" is not published in ${directory}`);
  const request = pendingRequest(record);
  if (request === undefined) throw new Error(`Machine run "${runId}" is not waiting for Human input`);
  if (request.requestId === undefined) {
    throw new Error(`Machine run "${runId}" does not take a response from outside its host`);
  }
  if (request.requestId !== requestId) {
    throw new Error(`Machine run "${runId}" is waiting on request "${request.requestId}", not "${requestId}"`);
  }
  const refusal = responseRefusal(request, response);
  if (refusal !== undefined) throw new Error(refusal);

  const delivery = randomUUID();
  const withdraw = deliver(directory, runId, { delivery, requestId, response });
  const timeout = options.timeoutMilliseconds ?? confirmationMilliseconds;
  const delivered = Date.now();
  while (true) {
    const current = published();
    const left = pendingRequest(current)?.requestId !== requestId;
    // The run also removes a response it discards, so only its record says which ones it took.
    if (left && current?.deliveries?.includes(delivery) === true) return;
    const waited = Date.now() - delivered;
    // A record still names every response its run took since this one was delivered.
    if (left && waited < deliveryRetentionMilliseconds) {
      withdraw();
      throw new Error(
        `Response to Machine run "${runId}" was not confirmed: the run left request "${requestId}" without taking it`,
      );
    }
    if (left || waited >= timeout) {
      throw new Error(
        `Response to Machine run "${runId}" was not confirmed within ${timeout / 1_000}s${
          withdraw() ? "; it was withdrawn and will not be applied" : ""
        }`,
      );
    }
    await sleep(Math.min(pollMilliseconds / 2, timeout));
  }
}

/**
 * Hands `accept` the first valid inbox response to a request, then stops; the
 * returned function stops earlier. Start watching before the request is
 * published: whatever is already in the inbox predates it and is dropped.
 * The run's record must name the `delivery` it applies before leaving the
 * request, or the sender is told its response was not taken.
 */
export function watchRunInbox(
  directory: string,
  runId: string,
  request: PendingRequest,
  accept: (response: HumanResponse, delivery: string | undefined) => void,
): () => void {
  takeRunResponse(directory, runId);
  const timer = setInterval(() => {
    const message = takeRunResponse(directory, runId);
    // A response to another request, or one this request does not allow, is discarded.
    if (message === undefined || message.requestId !== request.requestId) return;
    if (responseRefusal(request, message.response) !== undefined) return;
    clearInterval(timer);
    accept(message.response, message.delivery);
  }, pollMilliseconds);
  return () => clearInterval(timer);
}

export interface InboxHumanOptions {
  readonly directory: string;
  readonly runId: string;
  /** Publishes the request in the run's record so that others can answer it. */
  publish(request: RunStatusHuman & { readonly requestId: string }): void;
  /** Names, in the run's record, the inbox response that answered the request. */
  acknowledge(delivery: string): void;
  readonly terminal?: (request: HumanRequest, signal: AbortSignal) => Promise<string>;
  /** The terminal cannot answer this request; only the inbox can. */
  readonly onTerminalClosed?: (requestId: string) => void;
  /** The terminal gave an answer the request does not allow, and is asked again. */
  readonly onTerminalRefused?: (reason: string) => void;
}

/**
 * A Human runner for a published run: asks on the terminal and watches the
 * run's inbox, and whichever answers first wins.
 */
export function inboxHuman(options: InboxHumanOptions): HumanRunner {
  const { directory, runId } = options;
  const terminal = options.terminal ?? askTerminal;
  return (request) => new Promise<HumanResponse>((resolve, reject) => {
    const requestId = randomUUID();
    const asked = new AbortController();
    let settled = false;
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      stopWatching();
      asked.abort();
      finish();
    };
    const stopWatching = watchRunInbox(directory, runId, { ...request, requestId }, (response, delivery) => {
      settle(() => {
        if (delivery !== undefined) options.acknowledge(delivery);
        resolve(response);
      });
    });
    options.publish({ ...request, requestId });
    const ask = () => new Promise<string>((answer) => answer(terminal(request, asked.signal))).then(
      (answer) => {
        if (settled) return;
        // Only a valid answer wins: one the request does not allow leaves it waiting on both sources.
        const refusal = responseRefusal(request, answer);
        if (refusal === undefined) return settle(() => resolve(answer));
        options.onTerminalRefused?.(refusal);
        void ask();
      },
      (cause: unknown) => {
        if (settled) return;
        // Without terminal input the published request is the only way to
        // answer. When nobody can see it either, fail as an unpublished run does.
        const visible = readRunStatuses(directory)
          .some((record) => record.id === runId && record.human?.requestId === requestId);
        if (cause instanceof TerminalInputClosed && visible) options.onTerminalClosed?.(requestId);
        else settle(() => reject(cause));
      },
    );
    void ask();
  });
}

function askTerminal(request: HumanRequest, signal: AbortSignal): Promise<string> {
  // Input that ended during an earlier request never closes a new prompt, so say it is closed.
  return process.stdin.readableEnded ? Promise.reject(new TerminalInputClosed()) : terminalHuman(request, signal);
}

function pendingRequest(record: RunStatusRecord | undefined): RunStatusHuman | undefined {
  // A record whose process is gone can no longer be answered.
  return record?.status === "waiting" && isProcessAlive(record.pid) ? record.human : undefined;
}

/** Why a request does not allow a response, checked before delivery and again on receipt. */
function responseRefusal(request: Pick<RunStatusHuman, "choices" | "discussion">, response: HumanResponse): string | undefined {
  if (typeof response === "string") {
    return request.choices === undefined || request.choices.includes(response)
      ? undefined
      : `Expected one of: ${request.choices.join(", ")}`;
  }
  if (request.discussion !== true) return "This Human request does not support discussion";
  return response.text.trim() === "" || response.text.length > 8000
    ? "Question must contain 1–8000 characters"
    : undefined;
}

/**
 * Puts a response in the run's inbox, which holds one at a time. Returns a
 * function that takes it back and tells whether it did: false means the run
 * already has it.
 *
 * The inbox's name is shared by every sender, so nothing can be learned from it
 * and then acted on: it may hold a later response by then. A response therefore
 * has a second name that carries its delivery, and removing that name, which
 * only one process can do, decides who owns it. Only the run removes a file
 * from the inbox.
 */
function deliver(directory: string, runId: string, message: InboxMessage & { readonly delivery: string }): () => boolean {
  const sent = runDeliveryPath(directory, runId, message.delivery);
  try {
    writeFileSync(sent, `${JSON.stringify(message)}\n`, { mode: 0o600 });
    // The run only ever sees a whole response, and a link, unlike a rename,
    // cannot replace one that is already pending.
    linkSync(sent, runInboxPath(directory, runId));
  } catch (cause) {
    rmSync(sent, { force: true });
    if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
    throw new Error(`Machine run "${runId}" already has a response pending`);
  }
  return () => {
    try {
      // Emptied through its own name first, so that what stays in the inbox until
      // the run next reads it, and discards it, no longer holds the response.
      truncateSync(sent);
      unlinkSync(sent);
      return true;
    } catch {
      return false;
    }
  };
}

/** Removes whatever is pending from the inbox and returns it if it is a response the run now owns. */
function takeRunResponse(directory: string, runId: string): InboxMessage | undefined {
  const taken = join(directory, `.${runId}.${randomUUID()}.inbox.taken`);
  try {
    // Moved out before it is read, so what is read is what was removed, whatever arrives next.
    renameSync(runInboxPath(directory, runId), taken);
  } catch {
    return undefined;
  }
  try {
    const message: unknown = JSON.parse(readFileSync(taken, "utf8"));
    if (!isInboxMessage(message)) return undefined;
    // Fails when the sender has taken the response back.
    if (message.delivery !== undefined) unlinkSync(runDeliveryPath(directory, runId, message.delivery));
    return message;
  } catch {
    return undefined;
  } finally {
    rmSync(taken, { force: true });
  }
}

function isInboxMessage(value: unknown): value is InboxMessage {
  if (value === null || typeof value !== "object") return false;
  const { delivery, requestId, response } = value as Record<string, unknown>;
  if (typeof requestId !== "string") return false;
  // The delivery becomes part of a file name.
  if (delivery !== undefined && (typeof delivery !== "string" || !/^[A-Za-z0-9_-]+$/u.test(delivery))) return false;
  if (typeof response === "string") return true;
  if (response === null || typeof response !== "object") return false;
  const question = response as Record<string, unknown>;
  return question.type === "question" && typeof question.text === "string";
}
