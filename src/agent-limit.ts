/** A provider usage limit that ended an Agent turn. */
export interface AgentLimit {
  /** The runner's harness label, for example "claude" or "codex". */
  readonly harness: string;
  /** The preset name. Runners leave it unset; the caller that selected the preset fills it in. */
  readonly agent?: string;
  /** The provider's name for the limit when known, for example "five_hour", "seven_day_opus", or "usage". */
  readonly kind?: string;
  /** Epoch milliseconds, only when the provider states when the limit resets. */
  readonly resetsAt?: number;
}

// A registered symbol identifies the error across module copies (source, `dist`,
// another package's installed copy), where `instanceof` would not.
const brand = Symbol.for("machines.agent-limit");
const maximumCauseDepth = 8;

/** Thrown by an Agent runner when the provider refuses a turn because a usage limit is reached. */
export class AgentLimitError extends Error {
  readonly limit: AgentLimit;
  /** Every limit behind the failure when several presets were tried, each naming its preset in `agent`. */
  readonly limits?: readonly AgentLimit[];
  readonly [brand] = true;

  constructor(
    message: string,
    limit: AgentLimit,
    options?: ErrorOptions & { readonly limits?: readonly AgentLimit[] },
  ) {
    super(message, options);
    this.name = "AgentLimitError";
    this.limit = limit;
    if (options?.limits !== undefined) this.limits = options.limits;
  }
}

/** Returns the usage limit behind a failure, searching its `cause` chain. */
export function agentLimitOf(cause: unknown): AgentLimit | undefined {
  let current = cause;
  for (let depth = 0; depth < maximumCauseDepth; depth += 1) {
    if (current === null || typeof current !== "object") return undefined;
    if (brand in current && current[brand] === true && "limit" in current && isAgentLimit(current.limit)) {
      return current.limit;
    }
    current = "cause" in current ? current.cause : undefined;
  }
  return undefined;
}

function isAgentLimit(value: unknown): value is AgentLimit {
  return value !== null && typeof value === "object" && "harness" in value && typeof value.harness === "string";
}
