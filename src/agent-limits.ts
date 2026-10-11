import { AgentLimitError, agentLimitOf, type AgentLimit } from "./agent-limit.ts";
import type { AgentReporter, AgentRequest, AgentRunner, AgentUpdate, Event } from "./index.ts";

export interface LimitPolicy {
  /** Longest one invocation waits for a reset, from its first wait. `0` never waits. */
  readonly maxWaitMs: number;
  /** How long a limit with no stated reset is trusted before the request is tried again. */
  readonly probeMs: number;
  readonly now?: () => number;
  /** A replacement must let `now` advance by about the time it was asked to sleep. */
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface LimitCandidate {
  /** The preset name. */
  readonly name: string;
  readonly runner: AgentRunner;
  readonly harness?: string;
}

interface RememberedLimit {
  readonly limit: AgentLimit;
  /** When the preset is worth trying again. */
  readonly until: number;
  /** Whether `until` is the provider's stated reset rather than the next probe. */
  readonly known: boolean;
}

/** Presets known to be at a limit, by name. One per prepared run, shared by its roles, never stored. */
export type LimitMemory = Map<string, RememberedLimit>;

export const defaultProbeMs = 15 * 60_000;
// A provider's reset time is when its window ends, not when it accepts requests again.
const resetMarginMs = 60_000;
// Short sleeps measured against the clock notice a reset that passed while the computer was suspended.
const tickMs = 60_000;
const handoffNote = [
  "Note: a previous Agent working on this assignment was interrupted by a usage limit and may have",
  "left partial work in the workspace. Inspect the current state and continue the same assignment",
  "rather than starting over.",
].join(" ");

export function createLimitMemory(): LimitMemory {
  return new Map();
}

/**
 * Runs one role's request on the first candidate that is not at a usage limit.
 * A limited candidate hands the same request to the next one; when all are
 * limited the request waits for a reset within the policy, or fails.
 * A request with `limits: "report"` is tried on the bound candidate alone, and
 * its limit is thrown at once.
 */
export function limitAwareRunner(
  role: string,
  candidates: readonly LimitCandidate[],
  memory: LimitMemory,
  policy: LimitPolicy,
): AgentRunner {
  const bound = candidates[0];
  if (bound === undefined) throw new Error(`Agent role "${role}" needs at least one preset`);
  const now = policy.now ?? Date.now;
  const sleep = policy.sleep ?? timerSleep;
  const named = (name: string) => name === role ? name : `${name} (role ${role})`;
  const limited = (name: string, retrying?: ReadonlySet<RememberedLimit>) => {
    const remembered = memory.get(name);
    return remembered !== undefined && remembered.until > now() && retrying?.has(remembered) !== true;
  };

  // The state decides what its limit means, so nothing is swapped, waited for, or reported as an update.
  const reported = async (request: AgentRequest, report?: AgentReporter): Promise<Event> => {
    const known = memory.get(bound.name);
    if (known !== undefined && known.until > now()) {
      throw new AgentLimitError(`${named(bound.name)} is at its usage limit (${resetText(known)})`, known.limit);
    }
    try {
      const event = await bound.runner(request, report);
      if (known !== undefined && memory.get(bound.name) === known) memory.delete(bound.name);
      return event;
    } catch (cause) {
      const limit = agentLimitOf(cause);
      if (limit === undefined) throw cause;
      // The run's other roles skip this preset, and the limit names it.
      throw new AgentLimitError(cause instanceof Error ? cause.message : String(cause), remember(bound, limit).limit, { cause });
    }
  };

  return async (request, report) => {
    if (request.limits === "report") return reported(request, report);

    // A state is announced after its Agent starts, in the same tick. Observers
    // attach an update to the announced state, so none is reported before then.
    const tell = async (update: Extract<AgentUpdate, { type: "limit" }>) => {
      await Promise.resolve();
      report?.(update);
    };
    let interrupted = false;
    let lastFailure: unknown;
    let deadline: number | undefined;
    // A wait is reported once, and lasts until a candidate gets past its limit.
    let waiting = false;
    let retrying: ReadonlySet<RememberedLimit> = new Set();

    for (;;) {
      let passedOver: LimitCandidate | undefined;
      for (const [index, candidate] of candidates.entries()) {
        if (limited(candidate.name, retrying)) {
          passedOver ??= candidate;
          continue;
        }
        if (passedOver !== undefined && !interrupted && !waiting) {
          // Another role of this run found the limit, so this one names the preset it runs on instead.
          // After a wait the preset is named when the Agent resumes.
          await tell(swapped(named(passedOver.name), "is at", memory.get(passedOver.name), passedOver, candidate));
        }
        passedOver = undefined;

        const resume = () => {
          if (!waiting) return;
          waiting = false;
          report?.({
            type: "limit",
            status: "resumed",
            agent: bound.name,
            ...(candidate === bound ? {} : { to: candidate.name }),
            text: `${named(bound.name)} waited for a usage limit to reset; continuing${
              candidate === bound ? "" : ` with ${candidate.name}`}`,
          });
        };
        const tried = memory.get(candidate.name);
        let limit: AgentLimit | undefined;
        try {
          const event = await candidate.runner(
            interrupted ? withHandoffNote(request) : request,
            // A limited turn can still report its identity and the provider's message; a tool call is work.
            !waiting ? report : (update) => {
              if (update.type === "tool") resume();
              report?.(update);
            },
          );
          resume();
          // What was remembered for a preset that answers is out of date, also for the run's other roles.
          if (tried !== undefined && memory.get(candidate.name) === tried) memory.delete(candidate.name);
          return event;
        } catch (cause) {
          limit = agentLimitOf(cause);
          if (limit === undefined) throw cause;
          lastFailure = cause;
        }
        interrupted = true;
        const remembered = remember(candidate, limit);
        const next = candidates.slice(index + 1).find((later) => !limited(later.name, retrying));
        // Also while a wait is reported: each probe that moves on to another preset is a swap.
        if (next !== undefined) await tell(swapped(named(candidate.name), "reached", remembered, candidate, next));
      }

      const limits = candidates.flatMap((candidate) => {
        const remembered = memory.get(candidate.name);
        return remembered === undefined ? [] : [{ candidate, remembered }];
      });
      const started = now();
      deadline ??= started + policy.maxWaitMs;
      const closes = deadline;
      const wakes = policy.maxWaitMs <= 0 ? [] : limits.flatMap(({ remembered }) => {
        if (remembered.known) {
          return remembered.until <= closes ? [{ remembered, at: remembered.until + resetMarginMs }] : [];
        }
        // The last probe of a limit with no stated reset is at the deadline.
        return started < closes ? [{ remembered, at: Math.min(remembered.until, closes) }] : [];
      });
      if (wakes.length === 0) throw exhausted(role, limits, policy.maxWaitMs, lastFailure);

      const wakeAt = Math.min(...wakes.map((wake) => wake.at));
      // A reset that passed while a later candidate was working needs no wait.
      if (!waiting && wakeAt > now()) {
        waiting = true;
        const resets = wakes.filter((wake) => wake.remembered.known).map((wake) => wake.remembered.until);
        const until = timestamp(resets.length === 0 ? closes : Math.min(...resets));
        const others = candidates.slice(1).map((candidate) => candidate.name);
        await tell({
          type: "limit",
          status: "waiting",
          agent: bound.name,
          until,
          text: `${named(bound.name)}${
            others.length === 0
              ? " reached its usage limit"
              : ` and its fallback${others.length === 1 ? "" : "s"} (${others.join(", ")}) reached their usage limits`
          }; ${resets.length === 0 ? `no reset is stated, retrying until ${until}` : `waiting for the reset at ${until}`}`,
        });
      }
      for (let remaining = wakeAt - now(); remaining > 0; remaining = wakeAt - now()) {
        await sleep(Math.min(remaining, tickMs));
      }
      retrying = new Set(wakes.filter((wake) => wake.at <= wakeAt).map((wake) => wake.remembered));
    }
  };

  function remember(candidate: LimitCandidate, limit: AgentLimit): RememberedLimit {
    const at = now();
    // A reset that has already passed says nothing about when to try again.
    const known = limit.resetsAt !== undefined && limit.resetsAt > at;
    const remembered = {
      limit: { ...limit, agent: candidate.name },
      until: known ? limit.resetsAt : at + policy.probeMs,
      known,
    };
    memory.set(candidate.name, remembered);
    return remembered;
  }
}

function withHandoffNote(request: AgentRequest): AgentRequest {
  return { ...request, prompt: `${request.prompt}\n\n${handoffNote}` };
}

function swapped(
  subject: string,
  verb: "reached" | "is at",
  remembered: RememberedLimit | undefined,
  from: LimitCandidate,
  to: LimitCandidate,
): Extract<AgentUpdate, { type: "limit" }> {
  return {
    type: "limit",
    status: "swapped",
    agent: from.name,
    to: to.name,
    text: `${subject} ${verb} its usage limit (${resetText(remembered)}); continuing with ${to.name}`,
  };
}

function exhausted(
  role: string,
  limits: readonly { readonly candidate: LimitCandidate; readonly remembered: RememberedLimit }[],
  maxWaitMs: number,
  cause: unknown,
): AgentLimitError {
  const described = limits.map(({ candidate, remembered }) => {
    const details = [candidate.harness ?? remembered.limit.harness, remembered.limit.kind, resetText(remembered)];
    return `${candidate.name} (${details.filter((detail) => detail !== undefined).join(", ")})`;
  });
  const reason = maxWaitMs <= 0
    ? "waiting for a reset is off"
    : `none is available within the ${formatMinutes(maxWaitMs)} wait limit`;
  const known = limits.filter(({ remembered }) => remembered.known)
    .sort((left, right) => left.remembered.until - right.remembered.until);
  const earliest = (known[0] ?? limits[0])?.remembered.limit ?? { harness: "unknown" };
  return new AgentLimitError(
    `Agent role "${role}" is at a usage limit on every allowed preset: ${described.join("; ")}; ${reason}`,
    earliest,
    { limits: limits.map(({ remembered }) => remembered.limit), ...(cause === undefined ? {} : { cause }) },
  );
}

function resetText(remembered: RememberedLimit | undefined): string {
  return remembered?.known === true ? `resets ${timestamp(remembered.until)}` : "reset unknown";
}

function timestamp(time: number): string {
  return new Date(time).toISOString().replace(/\.\d{3}Z$/u, "Z");
}

function formatMinutes(milliseconds: number): string {
  const minutes = Math.round(milliseconds / 6_000) / 10;
  return `${minutes}-minute`;
}

// The timer stays referenced: a waiting run is working, and must keep its process alive.
function timerSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, milliseconds); });
}
