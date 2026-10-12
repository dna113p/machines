import { execFileSync, fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

import * as v from "valibot";
import { assertJsonValue, isJsonValue, type JsonValue } from "./json.ts";
import type { StateValue } from "xstate";

import type { AgentUpdate, HumanRequest, HumanResponse } from "./index.ts";
import {
  prepareMachineRun,
  type PrepareMachineRunOptions,
} from "./launcher.ts";
import {
  createRunStatusPublisher,
  runStatusDirectory,
  runStatusObserver,
  type RunStatusPublisher,
} from "./run-status.ts";

export interface HostedHumanRequest extends HumanRequest {
  readonly requestId: string;
}

export interface MachineHostOptions extends PrepareMachineRunOptions {
  readonly signal?: AbortSignal;
  /** What the run is for, in its published run status. `MACHINES_RUN_LABEL` applies when absent. */
  readonly label?: string;
  /** The session that owns the run in its published run status. The environment's owner applies when absent. */
  readonly owner?: string;
  /** Set to false by a caller that publishes the run's status itself, as the MCP server does. */
  readonly publishRunStatus?: boolean;
  readonly onAgentUpdate?: (update: AgentUpdate) => void;
  readonly onHumanRequest?: (request: HostedHumanRequest) => void;
  readonly onState?: (state: StateValue) => void;
}

export interface MachineHostResult {
  readonly state: StateValue;
  readonly output?: JsonValue;
}

export interface MachineHostRun {
  /** Names the run. Its published run status, when there is one, is recorded under this id. */
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly path: string;
  readonly agentRoles: Readonly<Record<string, string>>;
  readonly result: Promise<MachineHostResult>;
  respond(response: string, requestId: string): Promise<void>;
  ask(question: string, requestId: string): Promise<void>;
  terminate(): void;
}

const childArgument = "--machines-child-host";

const humanRequestSchema = v.strictObject({
  discussion: v.optional(v.boolean()),
  prompt: v.string(),
  choices: v.optional(v.array(v.string())),
  suggestions: v.optional(v.array(v.string())),
});

const agentIdentity = {
  harness: v.string(),
  model: v.optional(v.string()),
  thinking: v.optional(v.string()),
};

const agentUpdateSchema = v.variant("type", [
  v.strictObject({ type: v.literal("identity"), ...agentIdentity }),
  v.strictObject({
    type: v.literal("output"),
    text: v.string(),
  }),
  v.strictObject({
    type: v.literal("tool"),
    id: v.string(),
    title: v.optional(v.string()),
    status: v.optional(v.picklist(["pending", "in_progress", "completed", "failed"])),
  }),
  v.strictObject({
    type: v.literal("limit"),
    status: v.picklist(["swapped", "waiting", "resumed"]),
    agent: v.string(),
    to: v.optional(v.string()),
    until: v.optional(v.string()),
    text: v.string(),
  }),
]);

const stateValueSchema = v.union([
  v.string(),
  v.record(v.string(), v.unknown()),
]);

const parentMessageSchema = v.variant("type", [
  v.strictObject({
    type: v.literal("launch"),
    machine: v.string(),
    input: v.optional(v.custom<JsonValue>(isJsonValue)),
    agents: v.optional(v.record(v.string(), v.string())),
    cwd: v.string(),
    home: v.optional(v.string()),
    // Present while run status is published, by the host or by its caller, under this id.
    runId: v.optional(v.string()),
    // The host publishes the record itself and needs each change to it.
    reportStatus: v.optional(v.boolean()),
  }),
  v.strictObject({
    type: v.literal("ask"),
    requestId: v.string(),
    question: v.pipe(v.string(), v.minLength(1), v.maxLength(8000)),
  }),
  v.strictObject({
    type: v.literal("respond"),
    requestId: v.string(),
    response: v.string(),
  }),
]);

const childMessageSchema = v.variant("type", [
  v.strictObject({
    type: v.literal("started"),
    name: v.string(),
    description: v.string(),
    path: v.string(),
    agentRoles: v.record(v.string(), v.string()),
  }),
  v.strictObject({ type: v.literal("state"), state: stateValueSchema }),
  v.strictObject({ type: v.literal("agentUpdate"), update: agentUpdateSchema }),
  v.strictObject({
    type: v.literal("status"),
    // A change to the published record. Null clears a field: IPC drops a key that holds undefined.
    change: v.strictObject({
      state: v.optional(stateValueSchema),
      agent: v.optional(v.nullable(v.object(agentIdentity))),
      limit: v.optional(v.nullable(v.strictObject({ text: v.string(), until: v.optional(v.string()) }))),
    }),
  }),
  v.strictObject({
    type: v.literal("humanRequest"),
    requestId: v.string(),
    request: humanRequestSchema,
  }),
  v.strictObject({
    type: v.literal("completed"),
    state: stateValueSchema,
    output: v.optional(v.custom<JsonValue>(isJsonValue)),
  }),
  v.strictObject({ type: v.literal("failed"), message: v.string() }),
]);

type ParentMessage = v.InferOutput<typeof parentMessageSchema>;
type ChildMessage = v.InferOutput<typeof childMessageSchema>;

export function startMachineHost(
  options: MachineHostOptions,
): Promise<MachineHostRun> {
  if (options.signal?.aborted) return Promise.reject(new Error("Machine host was terminated"));
  if (options.input !== undefined) {
    try {
      assertJsonValue(options.input, "Machine input");
    } catch (cause) {
      return Promise.reject(cause);
    }
  }
  const cwd = options.cwd ?? process.cwd();
  // Run status is published here, by the host, and not by the hosted child.
  // Only the host sees every ending: it stops the child with SIGKILL, and a
  // child that crashed cannot record its own death. The record therefore
  // carries this process's pid. While the host lives it settles the record
  // itself; when the host dies the child stops with it (see "disconnect"
  // below), so a reader that finds the pid gone rightly shows the run as lost.
  const id = randomUUID();
  const publication = runStatusDirectory() !== undefined;
  const publishes = publication && options.publishRunStatus !== false;
  let published: RunStatusPublisher | undefined;
  const child = fork(fileURLToPath(import.meta.url), [childArgument], {
    cwd,
    execArgv: [],
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  child.stdout?.resume();
  child.stderr?.resume();

  let phase: "starting" | "running" | "completed" | "failed" = "starting";
  let pendingHuman:
    | { readonly requestId: string; readonly request: HumanRequest }
    | undefined;
  let resolveResult!: (result: MachineHostResult) => void;
  let rejectResult!: (error: Error) => void;
  const result = new Promise<MachineHostResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  void result.catch(() => {});

  return new Promise((resolveStarted, rejectStarted) => {
    let observersReady = false;
    const pendingObservations: Array<() => void> = [];
    const observe = (observation: () => void) => {
      if (observersReady) observation();
      else pendingObservations.push(observation);
    };
    let disposed = false;
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      options.signal?.removeEventListener("abort", abort);
      terminateProcessTree(child);
    };
    const abort = () => fail(new Error("Machine host was terminated"));
    const fail = (error: Error) => {
      if (phase === "completed" || phase === "failed") return;
      const wasStarting = phase === "starting";
      phase = "failed";
      pendingHuman = undefined;
      published?.finish({ error: error.message });
      rejectResult(error);
      if (wasStarting) rejectStarted(error);
      dispose();
    };

    options.signal?.addEventListener("abort", abort, { once: true });

    child.on("message", (value) => {
      if (phase === "completed" || phase === "failed") return;
      let message: ChildMessage;
      try {
        message = parseMessage(childMessageSchema, value, "child");
      } catch (cause) {
        fail(asError(cause));
        return;
      }

      if (message.type === "started") {
        if (phase !== "starting") {
          fail(new Error("Machine host sent an unexpected started message"));
          return;
        }
        phase = "running";
        if (publishes) {
          published = createRunStatusPublisher({
            id,
            machine: message.name,
            path: message.path,
            cwd: resolvePath(cwd),
            ...(options.label === undefined ? {} : { label: options.label }),
            ...(options.owner === undefined ? {} : { owner: options.owner }),
            // Responses reach this run through `respond` and `ask` below, never through an inbox.
            answeredBy: "host",
          });
        }
        resolveStarted({
          id,
          name: message.name,
          description: message.description,
          path: message.path,
          agentRoles: message.agentRoles,
          result,
          async respond(response, requestId) {
            if (phase !== "running" || pendingHuman === undefined) {
              throw new Error("Machine host is not waiting for Human input");
            }
            if (pendingHuman.requestId !== requestId) {
              throw new Error("Machine Human request is stale; read the current requestId");
            }
            if (
              pendingHuman.request.choices !== undefined
              && !pendingHuman.request.choices.includes(response)
            ) {
              throw new Error(
                `Expected one of: ${pendingHuman.request.choices.join(", ")}`,
              );
            }
            // Claim before yielding: no second caller can send this request again.
            pendingHuman = undefined;
            published?.update({ status: "running", human: undefined });
            try {
              await sendChild(child, { type: "respond", requestId, response });
            } catch (cause) {
              fail(asError(cause));
              throw cause;
            }
          },
          async ask(question, requestId) {
            if (phase !== "running" || !pendingHuman || pendingHuman.requestId !== requestId) {
              throw new Error("Machine Human request is stale or no longer waiting");
            }
            if (!pendingHuman.request.discussion) throw new Error("This Human request does not support discussion");
            if (typeof question !== "string" || !question.trim() || question.length > 8000) {
              throw new Error("Question must contain 1–8000 characters");
            }
            pendingHuman = undefined;
            published?.update({ status: "running", human: undefined });
            try { await sendChild(child, { type: "ask", requestId, question }); }
            catch (cause) { fail(asError(cause)); throw cause; }
          },
          terminate() {
            fail(new Error("Machine host was terminated"));
          },
        });
        queueMicrotask(() => {
          observersReady = true;
          pendingObservations.splice(0).forEach((observation) => observation());
        });
      } else if (message.type === "state") {
        observe(() => options.onState?.(message.state as StateValue));
      } else if (message.type === "agentUpdate") {
        observe(() => options.onAgentUpdate?.(message.update as AgentUpdate));
      } else if (message.type === "status") {
        const { state, agent, limit } = message.change;
        published?.update({
          ...(state === undefined ? {} : { state: state as StateValue }),
          ...(agent === undefined ? {} : { agent: agent ?? undefined }),
          ...(limit === undefined ? {} : { limit: limit ?? undefined }),
        });
      } else if (message.type === "humanRequest") {
        if (phase !== "running" || pendingHuman !== undefined) {
          fail(new Error("Machine host sent an unexpected Human request"));
          return;
        }
        pendingHuman = {
          requestId: message.requestId,
          request: message.request,
        };
        // Published without its request id, which only this host can use.
        published?.update({ status: "waiting", human: message.request });
        observe(() => options.onHumanRequest?.({ ...message.request, requestId: message.requestId }));
      } else if (message.type === "completed") {
        if (phase !== "running") {
          fail(new Error("Machine host completed before it started"));
          return;
        }
        phase = "completed";
        pendingHuman = undefined;
        published?.finish({ state: message.state as StateValue });
        dispose();
        resolveResult({
          state: message.state as StateValue,
          ...(message.output === undefined ? {} : { output: message.output }),
        });
      } else {
        fail(new Error(message.message));
      }
    });

    child.once("error", (cause) => fail(asError(cause)));
    child.once("exit", () => {
      // Exit can precede delivery of buffered completion IPC. Stop descendants
      // now so inherited stdout/stderr cannot keep the close event open forever.
      if (phase !== "completed" && phase !== "failed") terminateProcessTree(child);
    });
    child.once("close", (code, signal) => {
      if (phase === "completed" || phase === "failed") return;
      fail(new Error(
        `Machine host exited before completion (${signal ?? `code ${String(code)}`})`,
      ));
    });
    child.once("spawn", () => {
      if (phase !== "starting") return;
      const launch: ParentMessage = {
        type: "launch",
        machine: options.machine,
        cwd,
        ...(options.input === undefined ? {} : { input: options.input }),
        ...(options.agents === undefined ? {} : { agents: options.agents }),
        ...(options.home === undefined ? {} : { home: options.home }),
        // A caller that publishes the record itself still publishes it under this id.
        ...(publication ? { runId: id } : {}),
        ...(publishes ? { reportStatus: true } : {}),
      };
      void sendChild(child, launch).catch((cause: unknown) => fail(asError(cause)));
    });
  });
}

// Hosts own the subprocesses started by Operations and Agent harnesses. A separate
// process group lets disposal include descendants even after the host has exited.
// Machine-specific cleanup belongs to explicit workflow states, not termination.
function terminateProcessTree(child: Pick<ChildProcess, "pid" | "kill">): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
    } else {
      process.kill(-child.pid, "SIGKILL");
    }
  } catch (cause) {
    if (process.platform !== "win32" && (cause as NodeJS.ErrnoException).code !== "ESRCH") {
      child.kill("SIGKILL");
    }
  }
}

function runChildHost(): void {
  let launched = false;
  let closing = false;
  let pendingHuman:
    | { readonly requestId: string; readonly resolve: (response: HumanResponse) => void }
    | undefined;
  let outgoing = Promise.resolve();
  const send = (message: ChildMessage) => {
    outgoing = outgoing.then(() => sendParent(message));
  };

  process.on("message", (value) => {
    let message: ParentMessage;
    try {
      message = parseMessage(parentMessageSchema, value, "parent");
    } catch (cause) {
      send({ type: "failed", message: asError(cause).message });
      return;
    }

    if (message.type === "respond" || message.type === "ask") {
      if (pendingHuman === undefined || pendingHuman.requestId !== message.requestId) {
        send({ type: "failed", message: "Machine host received an unexpected Human response" });
        return;
      }
      const { resolve } = pendingHuman;
      pendingHuman = undefined;
      resolve(message.type === "ask" ? { type: "question", text: message.question } : message.response);
      return;
    }

    if (launched) {
      send({ type: "failed", message: "Machine host can launch only one Machine" });
      return;
    }
    launched = true;
    void launch(message);
  });

  process.once("disconnect", () => {
    if (!closing) {
      terminateProcessTree({ pid: process.pid, kill: () => { process.exit(1); } });
      process.exit(1);
    }
  });

  async function launch(message: Extract<ParentMessage, { type: "launch" }>) {
    try {
      const { runId, reportStatus, ...launched } = message;
      const prepared = await prepareMachineRun(launched);
      send({
        type: "started",
        name: prepared.name,
        description: prepared.description,
        path: prepared.path,
        agentRoles: prepared.agentRoles,
      });
      // Machines started by this run's Operations and Agents are its sub-runs.
      if (runId !== undefined) process.env.MACHINES_RUN_PARENT = runId;
      // Only this process can tell which state an Agent identity belongs to, so
      // it works out each change to the record and the host publishes it.
      const observed = reportStatus !== true ? undefined : runStatusObserver((change) => send({
        type: "status",
        change: {
          ...(change.state === undefined ? {} : { state: change.state }),
          ...("agent" in change ? { agent: change.agent ?? null } : {}),
          ...("limit" in change ? { limit: change.limit ?? null } : {}),
        },
      }));
      const result = await prepared.start({
        onAgentUpdate(update) {
          send({ type: "agentUpdate", update });
          observed?.onAgentUpdate(update);
        },
        onState(state) {
          send({ type: "state", state });
          observed?.onState(state);
        },
        human: (request) => new Promise((resolve) => {
          if (pendingHuman !== undefined) {
            throw new Error("Machine host cannot wait for two Human responses at once");
          }
          const requestId = crypto.randomUUID();
          pendingHuman = { requestId, resolve };
          send({
            type: "humanRequest",
            requestId,
            request: {
              prompt: request.prompt,
              ...(request.discussion ? { discussion: true } : {}),
              ...(request.choices === undefined
                ? {}
                : { choices: [...request.choices] }),
              ...(request.suggestions === undefined
                ? {}
                : { suggestions: [...request.suggestions] }),
            },
          });
        }),
      });
      if (result.output !== undefined) assertJsonValue(result.output, "Machine output");
      send({
        type: "completed",
        state: result.value,
        ...(result.output === undefined ? {} : { output: result.output }),
      });
    } catch (cause) {
      send({ type: "failed", message: asError(cause).message });
    } finally {
      await outgoing;
      closing = true;
      if (process.connected) process.disconnect();
    }
  }
}

function parseMessage<TSchema extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>>(
  schema: TSchema,
  value: unknown,
  sender: "child" | "parent",
): v.InferOutput<TSchema> {
  const result = v.safeParse(schema, value);
  if (!result.success) throw new Error(`Machine host received an invalid ${sender} message`);
  return result.output;
}

function sendChild(child: ChildProcess, message: ParentMessage): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!child.connected) {
      reject(new Error("Machine host IPC is closed"));
      return;
    }
    child.send(message, (error) => error === null ? resolve() : reject(error));
  });
}

function sendParent(message: ChildMessage): Promise<void> {
  return new Promise((resolve, reject) => {
    if (process.send === undefined || !process.connected) {
      reject(new Error("Machine host parent IPC is closed"));
      return;
    }
    process.send(message, (error) => error === null ? resolve() : reject(error));
  });
}

function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

if (process.argv[2] === childArgument) runChildHost();
