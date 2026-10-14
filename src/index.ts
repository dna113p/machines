import { agentLimitOf, type AgentLimit } from "./agent-limit.ts";
import { terminalHuman } from "./terminal-human.ts";

import {
  createActor,
  fromPromise,
  raise,
  setup,
  type AnyStateMachine,
  type SnapshotFrom,
  type StateValue,
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

export interface RunOptions {
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
    agent: fromPromise<Event, AgentInvocation>(async () => {
      throw new Error("This Machine reached an Agent state, but no Agent runner was supplied");
    }),
    human: fromPromise<Event, HumanRequest>(async ({ input }) =>
      submittedHumanEvent(input, terminalHuman)
    ),
  },
});

const agentMetaKey = "machines.agent";

export const machine = machines.createMachine;

export function operation<const TTransitions extends Readonly<Record<string, unknown>>>(
  runOperation: () => Event | Promise<Event>,
  on: TTransitions,
) {
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
  actorName: "Agent" | "Human" | "Operation",
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

export interface MachinePrimitives {
  readonly agent: typeof agent;
  readonly final: typeof final;
  readonly human: typeof human;
  readonly machine: typeof machine;
  readonly operation: typeof operation;
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
    const agentRunners = options.agents ?? {};
    assertAgentRunners(agentRunners);
    assertRequiredAgentRunners(definition, agentRunners);
    const runnable = definition.provide({
      actions: {
        humanInputFinished: () => options.onHumanInput?.(false),
        humanInputStarted: () => options.onHumanInput?.(true),
      },
      actors: {
        human: fromPromise<Event, HumanRequest>(async ({ input }) =>
          submittedHumanEvent(input, options.human ?? terminalHuman)
        ),
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
    const actor = createActor(runnable);
    const initialValue = (
      actor.getSnapshot() as unknown as { readonly value: StateValue }
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
      complete: () => resolve(actor.getSnapshot()),
      error: reject,
    });

    options.onState?.(initialValue);
    actor.start();
  });
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
  actorName: "Agent" | "Human" | "Operation",
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
  actorName: "Agent" | "Human" | "Operation",
  cause: unknown,
  state: StateValue,
): Error {
  const message = cause instanceof Error ? cause.message : String(cause);
  return new Error(`${actorName} failed in state "${formatState(state)}": ${message}`, { cause });
}

function formatState(state: StateValue): string {
  return typeof state === "string" ? state : JSON.stringify(state);
}
