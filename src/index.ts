import { agentLimitOf, type AgentLimit } from "./agent-limit.ts";
import { terminalHuman } from "./terminal-human.ts";
import { jsonProblem } from "./json.ts";
import { setTimeout as delay } from "node:timers/promises";

import {
  createActor,
  fromPromise,
  raise,
  setup,
  type AnyStateMachine,
  type SnapshotFrom,
  type StateValue,
  type AnyMachineSnapshot,
} from "xstate";

export interface Event {
  readonly type: string;
  readonly [key: string]: unknown;
}

export type HumanOptions =
  | {
    readonly choices: readonly string[];
    readonly suggestions?: never;
    readonly discussion?: boolean;
  }
  | {
    readonly choices?: never;
    readonly suggestions?: readonly string[];
    readonly discussion?: boolean;
  };

export type HumanPrompt = string | (() => string);

export interface HumanRequest {
  /** A separate question channel; never an approval or a restricted choice. */
  readonly discussion?: boolean;
  readonly prompt: string;
  readonly choices?: readonly string[];
  readonly suggestions?: readonly string[];
}

export type HumanResponse = string | { readonly type: "question"; readonly text: string };

export type HumanRunner = (
  request: HumanRequest,
) => HumanResponse | Promise<HumanResponse>;

export interface AgentOptions {
  readonly cwd?: string;
  readonly using?: string;
  /**
   * The transition this state takes when its Agent is at a usage limit. The
   * event is delivered by the runtime and never offered to the Agent. A state
   * that names it decides what a limit means: no fallback preset, no waiting.
   */
  readonly onLimit?: string;
}

export type AgentPrompt = string | (() => string);

export interface AgentRequest {
  readonly prompt: string;
  readonly outcomes: readonly string[];
  readonly cwd?: string;
  /**
   * Set for a state that handles its own usage limit: a limit is to be thrown
   * as it is found, not swapped away from or waited out. Runners that do
   * neither ignore it.
   */
  readonly limits?: "report";
}

interface AgentInvocation extends AgentRequest {
  readonly using: string;
  readonly onLimit?: string;
}

export type AgentUpdate =
  | {
    readonly type: "identity";
    readonly harness: string;
    readonly model?: string;
    readonly thinking?: string;
  }
  | {
    readonly type: "output";
    readonly text: string;
  }
  | {
    readonly type: "tool";
    readonly id: string;
    readonly title?: string;
    readonly status?: "pending" | "in_progress" | "completed" | "failed";
  }
  | {
    /** A usage limit changed which preset runs this Agent, or made it wait. `text` is a ready one-line summary. */
    readonly type: "limit";
    readonly status: "swapped" | "waiting" | "resumed";
    /** The limited preset. */
    readonly agent: string;
    /** The preset that continues the request. */
    readonly to?: string;
    /** ISO time the wait is expected to end. */
    readonly until?: string;
    readonly text: string;
  };

export type AgentReporter = (update: AgentUpdate) => void;

export type { JsonValue } from "./json.ts";

export { AgentLimitError, agentLimitOf, type AgentLimit } from "./agent-limit.ts";

export {
  machineGraph,
  statePaths,
  type RunGraph,
  type RunGraphEdge,
  type RunGraphState,
  type RunTrailStep,
} from "./run-graph.ts";

export type AgentRunner = (
  request: AgentRequest,
  report?: AgentReporter,
) => Event | Promise<Event>;

export interface OperationRetry {
  readonly on: string;
  /** Number of further attempts, from 1 to 10. */
  readonly times: number;
  readonly wait: number | string;
}

interface RetryInvocation {
  readonly run: () => Event | Promise<Event>;
  readonly retry: OperationRetry;
}

export interface StateEntry {
  readonly value: StateValue;
  readonly context: unknown;
  readonly kind: "agent" | "operation" | "human" | "wait" | "final" | "state";
  readonly enteredAt: string;
  readonly due?: string;
  readonly retry?: { readonly attempt: number; readonly of: number };
}

export interface RunOptions {
  readonly onEnter?: (entry: StateEntry) => void;
  /** Captures mutable working data before XState evaluates a step's input. */
  readonly onBeforeStep?: (context: unknown) => void;
  readonly continueAt?: { readonly value: StateValue; readonly context: unknown; readonly due?: string; readonly retry?: StateEntry["retry"] };
  /** Stop at a future timed wait, after its entry has been checkpointed. */
  readonly onSleep?: (due: string) => void;
  /** Stop at a Human request, after its entry has been checkpointed. */
  readonly onHumanSleep?: (request: HumanRequest) => void;
  /** Answer to the continued Human request, consumed once and validated normally. */
  readonly answer?: string;
  readonly agents?: Readonly<Record<string, AgentRunner>>;
  readonly human?: HumanRunner;
  readonly onAgentUpdate?: AgentReporter;
  readonly onHumanInput?: (active: boolean) => void;
  readonly onState?: (state: StateValue) => void;
}

interface ActorActionArgs {
  readonly event: { readonly error?: unknown; readonly output?: unknown };
  readonly self: { getSnapshot(): { readonly value: StateValue } };
}

const machines = setup({
  actions: {
    humanInputFinished: () => {},
    humanInputStarted: () => {},
  },
  actors: {
    retry: fromPromise<Event, RetryInvocation>(async () => {
      throw new Error("Operation retries require run()");
    }),
    wait: fromPromise<Event>(async () => {
      throw new Error("Timed waits require run()");
    }),
    agent: fromPromise<Event, AgentInvocation>(async () => {
      throw new Error("This Machine reached an Agent state, but no Agent runner was supplied");
    }),
    human: fromPromise<Event, HumanRequest>(async ({ input }) =>
      submittedHumanEvent(input, terminalHuman)
    ),
  },
});

const agentMetaKey = "machines.agent";
const waitMetaKey = "machines.wait";
const retryMetaKey = "machines.retry";

export const machine: typeof machines.createMachine = (config) => {
  assertRetries(config);
  return machines.createMachine(config);
};

function durationMs(value: unknown): number {
  const units: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  const duration = typeof value === "string" ? /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/u.exec(value) : null;
  const ms = typeof value === "number" ? value
    : duration ? Number(duration[1]) * units[duration[2]!]! : Number.NaN;
  return Number.isFinite(ms) && ms >= 1 && ms <= 8.64e15 - Date.now() ? ms : Number.NaN;
}

/** Validate where state paths are known, including nested definitions. */
function assertRetries(value: unknown, path: string[] = []): void {
  if (value === null || typeof value !== "object") return;
  const state = value as { meta?: Record<string, unknown>; on?: Record<string, unknown>; states?: Record<string, unknown> };
  const retry = state.meta?.[retryMetaKey];
  if (retry !== undefined) {
    const name = `State "${path.join(".")}" retry`;
    if (retry === null || typeof retry !== "object") throw new Error(`${name} must be an object`);
    const option = retry as Partial<OperationRetry>;
    if (typeof option.on !== "string" || option.on === "" || !Object.hasOwn(state.on ?? {}, option.on) || state.on?.[option.on] === undefined) {
      throw new Error(`${name}.on "${option.on}" is not one of its events`);
    }
    if (!Number.isInteger(option.times) || option.times! < 1 || option.times! > 10) {
      throw new Error(`${name}.times must be an integer from 1 to 10`);
    }
    if (Number.isNaN(durationMs(option.wait))) {
      throw new Error(`${name}.wait must be positive milliseconds or a duration such as 10m`);
    }
  }
  for (const [key, child] of Object.entries(state.states ?? {})) assertRetries(child, [...path, key]);
}

/** A timed state whose due event follows a positive interval. */
export function wait<const TTransitions extends Readonly<Record<string, unknown>>>(
  options: { readonly every: number | string },
  on: TTransitions,
) {
  const ms = durationMs(options.every);
  if (Number.isNaN(ms)) {
    throw new Error("Wait every must be positive milliseconds or a duration such as 10m");
  }
  if (!Object.hasOwn(on, "due") || on.due === undefined) {
    throw new Error("Timed waits must handle a due event");
  }
  return {
    meta: { [waitMetaKey]: { ms } },
    invoke: { src: "wait", ...actorLifecycle("Wait", on) },
    on,
  } as const;
}

export function operation<const TTransitions extends Readonly<Record<string, unknown>>>(
  runOperation: () => Event | Promise<Event>,
  on: TTransitions,
  options: { readonly retry?: OperationRetry } = {},
) {
  if (options.retry !== undefined) return {
    meta: { [retryMetaKey]: options.retry },
    invoke: {
      src: "retry",
      input: { run: runOperation, retry: options.retry },
      ...actorLifecycle("Operation", on),
    },
    on,
  } as const;
  return {
    invoke: {
      src: fromPromise(async () => runOperation()),
      ...actorLifecycle("Operation", on),
    },
    on,
  } as const;
}

export function human<const TTransitions extends Readonly<Record<string, unknown>>>(
  prompt: HumanPrompt,
  on: TTransitions,
  options: HumanOptions = {},
) {
  if (options.choices !== undefined && options.choices.length === 0) {
    throw new Error("Human choices must include at least one value");
  }

  if (options.discussion && !Object.hasOwn(on, "question")) {
    throw new Error("Discussion-enabled Human states must handle a question event");
  }

  return {
    entry: "humanInputStarted",
    exit: "humanInputFinished",
    invoke: {
      src: "human",
      input: () => ({
        prompt: typeof prompt === "function" ? prompt() : prompt,
        ...(options.discussion ? { discussion: true } : {}),
        ...(options.choices === undefined ? {} : { choices: options.choices }),
        ...(options.suggestions === undefined
          ? {}
          : { suggestions: options.suggestions }),
      }),
      ...actorLifecycle("Human", on),
    },
    on,
  } as const;
}

export function agent<const TTransitions extends Readonly<Record<string, unknown>>>(
  prompt: AgentPrompt,
  on: TTransitions,
  options: AgentOptions = {},
) {
  const using = options.using ?? "default";
  if (typeof using !== "string" || using.trim() === "" || using !== using.trim()) {
    throw new Error("Agent runner name must be a non-empty trimmed string");
  }
  const onLimit = options.onLimit;
  if (onLimit !== undefined) {
    if (typeof onLimit !== "string" || onLimit.trim() === "" || onLimit !== onLimit.trim()) {
      throw new Error("Agent onLimit must be a non-empty trimmed event name");
    }
    if (!Object.hasOwn(on, onLimit)) {
      throw new Error(`Agent onLimit event "${onLimit}" must be one of the state's transitions`);
    }
  }
  // The limit event comes from the runtime, so the Agent is never offered it.
  const outcomes = Object.keys(on).filter((outcome) => outcome !== onLimit);
  if (onLimit !== undefined && outcomes.length === 0) {
    throw new Error(
      `Agent onLimit event "${onLimit}" cannot be the state's only transition: the Agent needs an outcome of its own`,
    );
  }

  return {
    meta: {
      [agentMetaKey]: { using, ...(onLimit === undefined ? {} : { onLimit }) },
    },
    invoke: {
      src: "agent",
      input: () => ({
        using,
        prompt: typeof prompt === "function" ? prompt() : prompt,
        outcomes,
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        ...(onLimit === undefined ? {} : { limits: "report" as const, onLimit }),
      }),
      ...actorLifecycle("Agent", on),
    },
    on,
  } as const;
}

function actorLifecycle(
  actorName: "Agent" | "Human" | "Operation" | "Wait",
  on: Readonly<Record<string, unknown>>,
) {
  return {
    onDone: {
      actions: [
        (args: unknown) => {
          const { event, self } = args as ActorActionArgs;
          assertHandledEvent(actorName, event.output, on, self.getSnapshot().value);
        },
        raise<any, any, Event, undefined>(
          ({ event }) => (event as { output: Event }).output,
        ),
      ],
    },
    onError: {
      actions: (args: unknown) => {
        const { event, self } = args as ActorActionArgs;
        throw actorError(actorName, event.error, self.getSnapshot().value);
      },
    },
  } as const;
}

async function submittedHumanEvent(
  request: HumanRequest,
  runner: HumanRunner,
): Promise<Event> {
  // XState can start an initial invoked actor before its parent's entry actions.
  // Let onHumanInput(true) release terminal hotkeys before the runner takes stdin.
  const answer = await Promise.resolve().then(() => runner(request));
  if (typeof answer !== "string") {
    if (answer && request.discussion === true && answer.type === "question" &&
        typeof answer.text === "string" && answer.text.trim() !== "" && answer.text.length <= 8000) {
      return { type: "question", value: answer.text };
    }
    throw new Error("Human runner must return a string or an explicitly supported discussion question");
  }
  if (request.choices !== undefined && !request.choices.includes(answer)) {
    throw new Error(`Expected one of: ${request.choices.join(", ")}`);
  }
  return { type: "submitted", value: answer };
}

export function final() {
  return { type: "final" } as const;
}

/** Initialize working data. The launcher's factory-scoped version also restores it. */
export function data<T extends object>(initial: T): T {
  if (initial === null || typeof initial !== "object" || Array.isArray(initial)
    || (Object.getPrototypeOf(initial) !== Object.prototype && Object.getPrototypeOf(initial) !== null)) {
    throw new Error("p.data() requires a plain object");
  }
  const problem = jsonProblem(initial, "data");
  if (problem) throw new Error(`Cannot save ${problem}`);
  return initial;
}

export interface MachinePrimitives {
  readonly data: typeof data;
  readonly agent: typeof agent;
  readonly final: typeof final;
  readonly human: typeof human;
  readonly machine: typeof machine;
  readonly operation: typeof operation;
  readonly wait: typeof wait;
}

export function requiredAgentNames(
  definition: AnyStateMachine,
): readonly string[] {
  const names = new Set<string>();
  collectAgentNames(
    (definition as unknown as { readonly config?: unknown }).config,
    names,
  );
  return [...names].sort((left, right) => left.localeCompare(right));
}

export function run<TMachine extends AnyStateMachine>(
  definition: TMachine,
  options: RunOptions = {},
): Promise<SnapshotFrom<TMachine>> {
  return new Promise((resolve, reject) => {
    assertRetries(definition.config);
    const agentRunners = options.agents ?? {};
    assertAgentRunners(agentRunners);
    assertRequiredAgentRunners(definition, agentRunners);
    let waitDue: string | undefined;
    let currentEntry: StateEntry;
    const waitUntil = async (due: string, signal: AbortSignal): Promise<void> => {
      if (options.onSleep && Date.parse(due) > Date.now()) {
        options.onSleep(due);
        queueMicrotask(() => actor.stop());
        await new Promise<void>((done) => signal.addEventListener("abort", () => done(), { once: true }));
      } else {
        // Node timers cap at about 25 days. Recheck after each chunk.
        while (Date.parse(due) > Date.now()) {
          await delay(Math.min(Date.parse(due) - Date.now(), 2_147_483_647), undefined, { signal });
        }
      }
    };
    let answer: string | undefined;
    const runnable = definition.provide({
      actions: {
        humanInputFinished: () => options.onHumanInput?.(false),
        humanInputStarted: () => options.onHumanInput?.(true),
      },
      actors: {
        retry: fromPromise<Event, RetryInvocation>(async ({ input, signal }) => {
          // Entry has checkpointed the saved count before a restored invoke runs.
          await Promise.resolve();
          signal.throwIfAborted();
          const entry = currentEntry;
          const of = input.retry.times + 1;
          let attempt = Math.min(entry.retry?.attempt ?? 1, of);
          if (entry.retry && entry.due) await waitUntil(entry.due, signal);
          for (;;) {
            signal.throwIfAborted();
            const event = await input.run();
            if (event?.type !== input.retry.on || attempt >= of) return event;
            signal.throwIfAborted();
            attempt += 1;
            const enteredAt = new Date().toISOString();
            const due = new Date(Date.parse(enteredAt) + durationMs(input.retry.wait)).toISOString();
            options.onEnter?.({ ...entry, enteredAt, due, retry: { attempt, of } });
            await waitUntil(due, signal);
          }
        }),
        wait: fromPromise<Event>(async ({ signal }) => {
          // Initial invokes and restored invokes start before entry actions.
          // The entry observer has set and saved the due time by this microtask.
          await Promise.resolve();
          signal.throwIfAborted();
          const due = waitDue;
          if (due === undefined) throw new Error("Timed wait has no due time");
          await waitUntil(due, signal);
          return { type: "due" };
        }),
        human: fromPromise<Event, HumanRequest>(async ({ input, signal }) => {
          if (answer !== undefined) {
            const submitted = answer;
            answer = undefined;
            return submittedHumanEvent(input, () => submitted);
          }
          if (options.onHumanSleep) {
            // As with timed waits, let the entry observer save the checkpoint first.
            await Promise.resolve();
            signal.throwIfAborted();
            options.onHumanSleep(input);
            queueMicrotask(() => actor.stop());
            await new Promise<void>((done) => signal.addEventListener("abort", () => done(), { once: true }));
            return { type: "submitted" };
          }
          return submittedHumanEvent(input, options.human ?? terminalHuman);
        }),
        ...(Object.keys(agentRunners).length === 0
          ? {}
          : {
            agent: fromPromise<Event, AgentInvocation>(
              async ({ input }) => {
                const { using, onLimit, ...request } = input;
                const runner = agentRunners[using];
                if (runner === undefined) {
                  throw new Error(`Agent runner "${using}" was not supplied`);
                }
                if (onLimit === undefined) return runner(request, options.onAgentUpdate);

                let event: Event;
                try {
                  event = await runner(request, options.onAgentUpdate);
                } catch (cause) {
                  const limit = agentLimitOf(cause);
                  if (limit === undefined) throw cause;
                  return limitEvent(onLimit, using, limit, cause);
                }
                // Only the runtime may say that the Agent is at a limit.
                if (event !== null && typeof event === "object" && event.type === onLimit) {
                  throw new Error(
                    `the runner returned "${onLimit}", which this state reserves for its usage-limit event`,
                  );
                }
                return event;
              },
            ),
          }),
      },
    }) as TMachine;
    // XState evaluates invoke inputs during the transition, before its microstep
    // notification. Capture working data first without changing input timing.
    if (options.onBeforeStep) {
      const visit = (node: AnyStateMachine["root"]) => {
        for (const invocation of node.invoke) {
          const input = invocation.input as unknown;
          invocation.input = (args: { context: unknown; event: Event; self: unknown }) => {
            options.onBeforeStep?.(args.context);
            return typeof input === "function" ? input(args) : input;
          };
        }
        Object.values(node.states).forEach(visit);
      };
      visit(runnable.root);
    }
    let firstEntry = true;
    const enter = (snapshot: AnyMachineSnapshot) => {
      const nodes = snapshot._nodes;
      const leaf = nodes.at(-1);
      const kind: StateEntry["kind"] = snapshot.status === "done" ? "final"
        : leaf?.meta?.[agentMetaKey] ? "agent"
        : leaf?.invoke.some((invoke) => invoke.src === "human") ? "human"
        : leaf?.meta?.[waitMetaKey] ? "wait"
        : leaf?.invoke.length ? "operation" : "state";
      const enteredAt = new Date().toISOString();
      const ms = (leaf?.meta?.[waitMetaKey] as { ms: number } | undefined)?.ms;
      waitDue = kind === "wait" ? (firstEntry ? options.continueAt?.due : undefined)
        ?? new Date(Date.parse(enteredAt) + ms!).toISOString() : undefined;
      const retryOption = leaf?.meta?.[retryMetaKey] as OperationRetry | undefined;
      const savedRetry = firstEntry && retryOption ? options.continueAt?.retry : undefined;
      const of = retryOption ? retryOption.times + 1 : undefined;
      const retry = savedRetry && of ? { attempt: Math.min(savedRetry.attempt, of), of } : undefined;
      firstEntry = false;
      currentEntry = { value: snapshot.value, context: snapshot.context, kind, enteredAt,
        ...(waitDue === undefined ? {} : { due: waitDue }),
        ...(retry === undefined ? {} : { retry, due: options.continueAt?.due }) };
      options.onEnter?.(currentEntry);
    };
    let entered: string | undefined;
    const actor = createActor(runnable as AnyStateMachine, {
      ...(options.continueAt ? { snapshot: continuationSnapshot(runnable, options.continueAt) } : {}),
      inspect(event) {
        if (event.type !== "@xstate.microstep" || (event.actorRef as { logic?: unknown }).logic !== runnable) return;
        const snapshot = event.snapshot as AnyMachineSnapshot;
        const key = JSON.stringify(snapshot.value);
        // Include reentry transitions, even when the state value stays the same.
        if (key !== entered || event._transitions.some((transition) => transition.reenter)) {
          enter(snapshot);
          entered = key;
        }
      },
    });
    const initialSnapshot = actor.getSnapshot();
    if (initialSnapshot.status === "error") {
      reject(initialSnapshot.error);
      return;
    }
    const initialValue = (
      initialSnapshot as unknown as { readonly value: StateValue }
    ).value;
    let previousState = JSON.stringify(initialValue);

    actor.subscribe({
      next: (snapshot) => {
        const value = (snapshot as unknown as { readonly value: StateValue }).value;
        const state = JSON.stringify(value);

        if (state === previousState) return;

        previousState = state;
        options.onState?.(value);
      },
      complete: () => resolve(actor.getSnapshot() as SnapshotFrom<TMachine>),
      error: reject,
    });

    if (entered === undefined) enter(actor.getSnapshot());
    entered = JSON.stringify(initialValue);
    options.onState?.(initialValue);
    if (options.continueAt && actor.getSnapshot()._nodes.some((node) => node.invoke.some((invoke) => invoke.src === "human"))) {
      answer = options.answer;
      options.onHumanInput?.(true);
    }
    actor.start();
    // xstate.init runs eventless transitions without selecting an external event
    // handler. This also continues a checkpoint taken in a transient plain state.
    if (options.continueAt && actor.getSnapshot().status === "active") actor.send({ type: "xstate.init" });
  });
}

/** Rebuild only active invokes. Restoring an active promise restarts it, without entry actions. */
function continuationSnapshot(definition: AnyStateMachine, saved: NonNullable<RunOptions["continueAt"]>): AnyMachineSnapshot {
  const snapshot = definition.resolveState({ value: saved.value, context: saved.context });
  const persisted = definition.getPersistedSnapshot(snapshot) as unknown as { children: Record<string, unknown> };
  for (const node of snapshot._nodes) {
    for (const invocation of node.invoke) {
      const input = typeof invocation.input === "function"
        ? invocation.input({ context: saved.context, event: { type: "xstate.init" }, self: undefined as never })
        : invocation.input;
      persisted.children[invocation.id] = {
        src: invocation.src,
        snapshot: { status: "active", input },
        syncSnapshot: false,
      };
    }
  }
  return persisted as unknown as AnyMachineSnapshot;
}

/** The event a state that names `onLimit` receives. It is plain JSON, so a Machine can keep or publish it. */
function limitEvent(type: string, role: string, limit: AgentLimit, cause: unknown): Event {
  const resets = typeof limit.resetsAt === "number" ? new Date(limit.resetsAt) : undefined;
  return {
    type,
    limit: {
      role,
      ...(typeof limit.agent === "string" ? { agent: limit.agent } : {}),
      harness: limit.harness,
      ...(typeof limit.kind === "string" ? { kind: limit.kind } : {}),
      // A reset outside the range of a date has no ISO form.
      ...(resets === undefined || Number.isNaN(resets.getTime()) ? {} : { resetsAt: resets.toISOString() }),
    },
    message: cause instanceof Error ? cause.message : String(cause),
  };
}

function collectAgentNames(value: unknown, names: Set<string>): void {
  if (value === null || typeof value !== "object") return;

  const state = value as {
    readonly meta?: Readonly<Record<string, unknown>>;
    readonly states?: Readonly<Record<string, unknown>>;
  };
  const metadata = state.meta?.[agentMetaKey];
  if (
    metadata !== null
    && typeof metadata === "object"
    && "using" in metadata
    && typeof metadata.using === "string"
  ) {
    names.add(metadata.using);
  }

  if (state.states !== undefined) {
    for (const child of Object.values(state.states)) collectAgentNames(child, names);
  }
}

function assertAgentRunners(
  runners: Readonly<Record<string, AgentRunner>>,
): void {
  for (const [name, runner] of Object.entries(runners)) {
    if (name.trim() === "" || name !== name.trim()) {
      throw new Error("Agent runner names must be non-empty trimmed strings");
    }
    if (typeof runner !== "function") {
      throw new Error(`Agent runner "${name}" must be a function`);
    }
  }
}

function assertRequiredAgentRunners(
  definition: AnyStateMachine,
  runners: Readonly<Record<string, AgentRunner>>,
): void {
  const missing = requiredAgentNames(definition)
    .filter((name) => !Object.hasOwn(runners, name));
  if (missing.length === 0) return;

  const noun = missing.length === 1 ? "runner" : "runners";
  throw new Error(`Machine requires missing Agent ${noun}: ${missing.join(", ")}`);
}

function assertHandledEvent(
  actorName: "Agent" | "Human" | "Operation" | "Wait",
  event: unknown,
  transitions: Readonly<Record<string, unknown>>,
  state: StateValue,
): asserts event is Event {
  if (
    event === null
    || typeof event !== "object"
    || !("type" in event)
    || typeof event.type !== "string"
  ) {
    throw new Error(`${actorName} in state "${formatState(state)}" returned an invalid event`);
  }

  if (!Object.hasOwn(transitions, event.type)) {
    throw new Error(`State "${formatState(state)}" does not handle event "${event.type}"`);
  }
}

function actorError(
  actorName: "Agent" | "Human" | "Operation" | "Wait",
  cause: unknown,
  state: StateValue,
): Error {
  const message = cause instanceof Error ? cause.message : String(cause);
  return new Error(`${actorName} failed in state "${formatState(state)}": ${message}`, { cause });
}

function formatState(state: StateValue): string {
  return typeof state === "string" ? state : JSON.stringify(state);
}
