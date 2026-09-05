import { randomUUID } from "node:crypto";
import type { StateValue } from "xstate";

import { startMachineHost, type HostedHumanRequest, type MachineHostRun } from "./host.ts";
import type { AgentUpdate } from "./index.ts";
import type { PrepareMachineRunOptions } from "./launcher.ts";

export type RunStatus = "running" | "waiting" | "completed" | "failed";

export interface RunSnapshot {
  readonly id: string;
  readonly machine: string;
  readonly description: string;
  readonly path: string;
  readonly cwd: string;
  readonly status: RunStatus;
  readonly state?: StateValue;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly elapsedSeconds: number;
  readonly agent?: Extract<AgentUpdate, { type: "identity" }>;
  readonly human?: HostedHumanRequest;
  readonly error?: string;
}

interface RunRecord {
  readonly id: string;
  readonly cwd: string;
  readonly host: MachineHostRun;
  readonly startedAt: number;
  updatedAt: number;
  status: RunStatus;
  state?: StateValue;
  human?: HostedHumanRequest;
  agent?: Extract<AgentUpdate, { type: "identity" }>;
  error?: string;
}

export interface SessionEvent {
  readonly type: "updated" | "human" | "finished";
  readonly run: RunSnapshot;
}

/** Owns runs from startup to disposal. Presentation belongs to its subscribers. */
export class MachineSession {
  readonly #runs = new Map<string, RunRecord>();
  readonly #starting = new Set<AbortController>();
  readonly #listeners = new Set<(event: SessionEvent) => void>();
  #closed = false;

  subscribe(listener: (event: SessionEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async start(options: PrepareMachineRunOptions): Promise<RunSnapshot> {
    if (this.#closed) throw new Error("Machine session is closed");
    const cancellation = new AbortController();
    this.#starting.add(cancellation);
    const id = randomUUID();
    const startedAt = Date.now();
    const update = (type: SessionEvent["type"], change: (run: RunRecord) => void) => {
      const run = this.#runs.get(id);
      if (run === undefined || !isActive(run.status)) return;
      change(run);
      run.updatedAt = Date.now();
      this.#emit(type, run);
    };
    let host: MachineHostRun;
    try {
      host = await startMachineHost({
        ...options,
        signal: cancellation.signal,
        onState: (state) => update("updated", (run) => {
          if (JSON.stringify(run.state) !== JSON.stringify(state)) run.agent = undefined;
          run.state = state;
        }),
        onAgentUpdate: (agent) => {
          if (agent.type === "identity") update("updated", (run) => { run.agent = agent; });
        },
        onHumanRequest: (request) => update("human", (run) => {
          run.status = "waiting";
          run.human = request;
        }),
      });
    } finally {
      this.#starting.delete(cancellation);
    }
    if (this.#closed) {
      host.terminate();
      throw new Error("Machine session is closed");
    }
    const run: RunRecord = {
      id,
      cwd: options.cwd ?? process.cwd(),
      host,
      startedAt,
      updatedAt: Date.now(),
      status: "running",
    };
    this.#runs.set(id, run);
    void host.result.then(
      ({ state }) => this.#finish(run, { state }),
      (cause: unknown) => this.#finish(run, { error: errorMessage(cause) }),
    );
    this.#emit("updated", run);
    return snapshot(run);
  }

  status(runId?: string): RunSnapshot[] {
    const runs = runId === undefined
      ? [...this.#runs.values()].sort((left, right) => right.updatedAt - left.updatedAt)
      : [this.#requireRun(runId)];
    return runs.map(snapshot);
  }

  async respond(input: {
    readonly runId: string;
    readonly requestId: string;
    readonly response: string;
  }): Promise<RunSnapshot> {
    const run = this.#requireRun(input.runId);
    if (run.status !== "waiting" || run.human === undefined) {
      throw new Error(`Machine run "${input.runId}" is not waiting for Human input`);
    }
    if (run.human.requestId !== input.requestId) {
      throw new Error("Machine Human request is stale; read the current requestId");
    }
    if (run.human.choices !== undefined && !run.human.choices.includes(input.response)) {
      throw new Error(`Expected one of: ${run.human.choices.join(", ")}`);
    }
    // Claim synchronously in the session as well as in the host. New requests or
    // terminal events arriving during IPC must never be overwritten by this reply.
    run.status = "running";
    run.human = undefined;
    run.updatedAt = Date.now();
    const sent = run.host.respond(input.response, input.requestId);
    this.#emit("updated", run);
    await sent;
    return snapshot(run);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#listeners.clear();
    for (const cancellation of this.#starting) cancellation.abort();
    this.#starting.clear();
    for (const run of this.#runs.values()) run.host.terminate();
    this.#runs.clear();
  }

  #requireRun(id: string): RunRecord {
    const run = this.#runs.get(id);
    if (run === undefined) throw new Error(`Machine run "${id}" not found in this session`);
    return run;
  }

  #finish(run: RunRecord, outcome: { state: StateValue } | { error: string }): void {
    if (this.#closed || !isActive(run.status)) return;
    run.status = "state" in outcome ? "completed" : "failed";
    if ("state" in outcome) run.state = outcome.state;
    else run.error = outcome.error;
    run.human = undefined;
    run.agent = undefined;
    run.updatedAt = Date.now();
    const terminal = [...this.#runs.values()]
      .filter((item) => !isActive(item.status))
      .sort((left, right) => right.updatedAt - left.updatedAt);
    for (const item of terminal.slice(5)) this.#runs.delete(item.id);
    this.#emit("finished", run);
  }

  #emit(type: SessionEvent["type"], run: RunRecord): void {
    for (const listener of this.#listeners) {
      try {
        listener({ type, run: snapshot(run) });
      } catch (cause) {
        // Rendering and notifications cannot change the outcome of an owned run.
        process.emitWarning(errorMessage(cause), { type: "MachineSessionObserverError" });
      }
    }
  }
}

export function isActive(status: RunStatus): boolean {
  return status === "running" || status === "waiting";
}

function snapshot(run: RunRecord): RunSnapshot {
  return {
    id: run.id,
    machine: run.host.name,
    description: run.host.description,
    path: run.host.path,
    cwd: run.cwd,
    status: run.status,
    ...(run.state === undefined ? {} : { state: structuredClone(run.state) }),
    startedAt: new Date(run.startedAt).toISOString(),
    updatedAt: new Date(run.updatedAt).toISOString(),
    elapsedSeconds: Math.floor(((isActive(run.status) ? Date.now() : run.updatedAt) - run.startedAt) / 1_000),
    ...(run.agent === undefined ? {} : { agent: { ...run.agent } }),
    ...(run.human === undefined ? {} : { human: structuredClone(run.human) }),
    ...(run.error === undefined ? {} : { error: run.error }),
  };
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
