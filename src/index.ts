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
  }
  | {
    readonly choices?: never;
    readonly suggestions?: readonly string[];
  };

export type HumanPrompt = string | (() => string);

export interface HumanRequest {
  readonly prompt: string;
  readonly choices?: readonly string[];
  readonly suggestions?: readonly string[];
}

export type HumanRunner = (
  request: HumanRequest,
) => string | Promise<string>;

export interface AgentOptions {
  readonly cwd?: string;
  readonly using?: string;
}

export type AgentPrompt = string | (() => string);

export interface AgentRequest {
  readonly prompt: string;
  readonly outcomes: readonly string[];
  readonly cwd?: string;
}

interface AgentInvocation extends AgentRequest {
  readonly using: string;
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
  };

export type AgentReporter = (update: AgentUpdate) => void;

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

  return {
    entry: "humanInputStarted",
    exit: "humanInputFinished",
    invoke: {
      src: "human",
      input: () => ({
        prompt: typeof prompt === "function" ? prompt() : prompt,
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

  return {
    meta: {
      [agentMetaKey]: { using },
    },
    invoke: {
      src: "agent",
      input: () => ({
        using,
        prompt: typeof prompt === "function" ? prompt() : prompt,
        outcomes: Object.keys(on),
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
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
    throw new Error("Human runner must return a string");
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
                const { using, ...request } = input;
                const runner = agentRunners[using];
                if (runner === undefined) {
                  throw new Error(`Agent runner "${using}" was not supplied`);
                }
                return runner(request, options.onAgentUpdate);
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
