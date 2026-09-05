import { execFileSync, fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

import * as v from "valibot";
import type { StateValue } from "xstate";

import type { AgentUpdate, HumanRequest } from "./index.ts";
import {
  prepareMachineRun,
  type PrepareMachineRunOptions,
} from "./launcher.ts";

export interface HostedHumanRequest extends HumanRequest {
  readonly requestId: string;
}

export interface MachineHostOptions extends PrepareMachineRunOptions {
  readonly signal?: AbortSignal;
  readonly onAgentUpdate?: (update: AgentUpdate) => void;
  readonly onHumanRequest?: (request: HostedHumanRequest) => void;
  readonly onState?: (state: StateValue) => void;
}

export interface MachineHostResult {
  readonly state: StateValue;
}

export interface MachineHostRun {
  readonly name: string;
  readonly description: string;
  readonly path: string;
  readonly agentRoles: Readonly<Record<string, string>>;
  readonly result: Promise<MachineHostResult>;
  respond(response: string, requestId: string): Promise<void>;
  terminate(): void;
}

const childArgument = "--machines-child-host";

const humanRequestSchema = v.strictObject({
  prompt: v.string(),
  choices: v.optional(v.array(v.string())),
  suggestions: v.optional(v.array(v.string())),
});

const agentUpdateSchema = v.variant("type", [
  v.strictObject({
    type: v.literal("identity"),
    harness: v.string(),
    model: v.optional(v.string()),
    thinking: v.optional(v.string()),
  }),
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
]);

const stateValueSchema = v.union([
  v.string(),
  v.record(v.string(), v.unknown()),
]);

const parentMessageSchema = v.variant("type", [
  v.strictObject({
    type: v.literal("launch"),
    machine: v.string(),
    input: v.optional(v.string()),
    agents: v.optional(v.record(v.string(), v.string())),
    cwd: v.string(),
    home: v.optional(v.string()),
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
    type: v.literal("humanRequest"),
    requestId: v.string(),
    request: humanRequestSchema,
  }),
  v.strictObject({ type: v.literal("completed"), state: stateValueSchema }),
  v.strictObject({ type: v.literal("failed"), message: v.string() }),
]);

type ParentMessage = v.InferOutput<typeof parentMessageSchema>;
type ChildMessage = v.InferOutput<typeof childMessageSchema>;

export function startMachineHost(
  options: MachineHostOptions,
): Promise<MachineHostRun> {
  if (options.signal?.aborted) return Promise.reject(new Error("Machine host was terminated"));
  const cwd = options.cwd ?? process.cwd();
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
        resolveStarted({
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
            try {
              await sendChild(child, { type: "respond", requestId, response });
            } catch (cause) {
              fail(asError(cause));
              throw cause;
            }
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
      } else if (message.type === "humanRequest") {
        if (phase !== "running" || pendingHuman !== undefined) {
          fail(new Error("Machine host sent an unexpected Human request"));
          return;
        }
        pendingHuman = {
          requestId: message.requestId,
          request: message.request,
        };
        observe(() => options.onHumanRequest?.({ ...message.request, requestId: message.requestId }));
      } else if (message.type === "completed") {
        if (phase !== "running") {
          fail(new Error("Machine host completed before it started"));
          return;
        }
        phase = "completed";
        pendingHuman = undefined;
        dispose();
        resolveResult({ state: message.state as StateValue });
      } else {
        fail(new Error(message.message));
      }
    });

    child.once("error", (cause) => fail(asError(cause)));
    child.once("exit", (code, signal) => {
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
    | { readonly requestId: string; readonly resolve: (response: string) => void }
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

    if (message.type === "respond") {
      if (pendingHuman === undefined || pendingHuman.requestId !== message.requestId) {
        send({ type: "failed", message: "Machine host received an unexpected Human response" });
        return;
      }
      const { resolve } = pendingHuman;
      pendingHuman = undefined;
      resolve(message.response);
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
      const prepared = await prepareMachineRun(message);
      send({
        type: "started",
        name: prepared.name,
        description: prepared.description,
        path: prepared.path,
        agentRoles: prepared.agentRoles,
      });
      const result = await prepared.start({
        onAgentUpdate: (update) => send({ type: "agentUpdate", update }),
        onState: (state) => send({ type: "state", state }),
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
      send({ type: "completed", state: result.value });
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
