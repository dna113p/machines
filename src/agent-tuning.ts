import type { AgentRunner } from "./index.ts";
import { jsonProblem, type JsonValue } from "./json.ts";

/** Model tuning only. Authentication, tools, commands, environment and billing belong to presets. */
export interface AgentTuning {
  readonly model?: string;
  readonly options?: Readonly<Record<string, JsonValue>>;
}

export interface TunedAgent {
  readonly runner: AgentRunner;
  /** Effective identity, including adapter defaults. Labels alone never configure a runner. */
  readonly model?: string;
  readonly thinking?: string;
}

/** An adapter validates every option and model combination before constructing a fresh runner. */
export interface AgentTuningAdapter {
  configure(tuning: AgentTuning): TunedAgent;
}

// Shared across installed/source module copies, like the usage-limit contract.
const capability = Symbol.for("@dna113p/machines/agent-tuning/v1");

/** Explicit opt-in for custom or wrapped runners. Never mutates the supplied runner. */
export function withAgentTuning(runner: AgentRunner, adapter: AgentTuningAdapter): AgentRunner {
  if (typeof runner !== "function" || typeof adapter?.configure !== "function") {
    throw new Error("withAgentTuning requires a runner and a configure adapter");
  }
  const wrapped: AgentRunner = (request, report) => runner(request, report);
  Object.defineProperty(wrapped, capability, { value: adapter });
  return wrapped;
}

export function configureAgentTuning(runner: AgentRunner, tuning: AgentTuning): TunedAgent {
  if (tuning === null || typeof tuning !== "object" || Array.isArray(tuning)) throw new Error("Agent tuning must be a JSON object");
  const problem = jsonProblem(tuning, "Agent tuning");
  if (problem) throw new Error(problem);
  if (Object.keys(tuning).some((key) => key !== "model" && key !== "options")) throw new Error("Unknown Agent tuning field");
  if (tuning.model !== undefined && !validModel(tuning.model)) throw new Error("Agent tuning model must be a nonempty, trimmed, one-line string");
  if (tuning.options !== undefined && (tuning.options === null || typeof tuning.options !== "object" || Array.isArray(tuning.options))) {
    throw new Error("Agent tuning options must be a JSON object");
  }
  const adapter = typeof runner !== "function" ? undefined
    : (runner as unknown as Record<symbol, AgentTuningAdapter | undefined>)[capability];
  if (typeof adapter?.configure !== "function") {
    throw new Error("Runner does not support profile tuning; use an adapter runner or explicitly opt in with withAgentTuning");
  }
  const configured = adapter.configure(freezeJson(structuredClone(tuning)));
  if (typeof configured?.runner !== "function"
    || (configured.model !== undefined && !validModel(configured.model))
    || (configured.thinking !== undefined && !validModel(configured.thinking))) {
    throw new Error("Agent tuning adapter returned an invalid runner or identity");
  }
  return configured;
}

export function validModel(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value === value.trim() && !Array.from(value).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
}

export function freezeJson<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) freezeJson(item);
    Object.freeze(value);
  }
  return value;
}

/** Shipped adapters accept only their declared tuning keys; never print supplied values. */
export function tuningChoices(options: AgentTuning["options"], choices: Readonly<Record<string, readonly string[]>>, adapter: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(options ?? {})) {
    const allowed = Object.hasOwn(choices, key) ? choices[key] : undefined;
    if (allowed === undefined) throw new Error(`${adapter}: unsupported profile option ${JSON.stringify(key)}; supported options: ${Object.keys(choices).join(", ")}`);
    if (typeof value !== "string" || !allowed.includes(value)) throw new Error(`${adapter}: profile option ${key} must be one of: ${allowed.join(", ")}`);
    result[key] = value;
  }
  return result;
}
