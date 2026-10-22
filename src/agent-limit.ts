/** Percent remaining in the provider's tightest allowance window. */
export interface AgentQuota {
  /** Percent left in the tightest window, from 0 to 100. */
  readonly remaining: number;
  /** That window's reset in epoch milliseconds. */
  readonly resetsAt?: number;
  /** The provider's name for that window, such as seven_day. */
  readonly kind?: string;
}

/** Read a configured hook with a bounded lifetime; Machines supplies no provider reader. */
export async function readAgentQuota(quota: () => Promise<AgentQuota | undefined>): Promise<{
  readonly reading?: AgentQuota;
  readonly error?: string;
}> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const reading = await Promise.race([
      Promise.resolve().then(quota),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timed out after 10 seconds")), 10_000);
      }),
    ]);
    if (reading === undefined) throw new Error("no reading available");
    if (!Number.isFinite(reading.remaining) || reading.remaining < 0 || reading.remaining > 100
      || (reading.resetsAt !== undefined && !Number.isFinite(reading.resetsAt))
      || (reading.kind !== undefined && typeof reading.kind !== "string")) throw new Error("invalid quota reading");
    return { reading: {
      remaining: reading.remaining,
      ...(reading.resetsAt === undefined ? {} : { resetsAt: reading.resetsAt }),
      ...(reading.kind === undefined ? {} : { kind: reading.kind }),
    } };
  } catch (cause) {
    return { error: (cause instanceof Error ? cause.message : String(cause)).replace(/[\r\n]+/gu, " ") };
  } finally { clearTimeout(timer); }
}

/** A provider usage limit found before or during an Agent turn. */
export interface AgentLimit {
  /** The runner's harness label, for example "claude" or "codex". */
  readonly harness: string;
  /** Present only for a limit discovered before a turn by its quota hook. */
  readonly quota?: AgentQuota;
  readonly reserve?: number;
  /** The preset name. Runners leave it unset; the caller that selected the preset fills it in. */
  readonly agent?: string;
  /** The provider's name for the limit when known, for example "five_hour", "seven_day_opus", or "usage". */
  readonly kind?: string;
  /** Which other presets this limit covers. The launcher infers this when omitted. */
  readonly scope?: "provider" | "model" | "preset";
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
