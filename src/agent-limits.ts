import { randomUUID } from "node:crypto";
import { closeSync, existsSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { agentLimitsFile } from "./discovery.ts";
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
  readonly model?: string;
}

export interface RememberedLimit {
  readonly preset: string;
  readonly harness?: string;
  readonly family?: string;
  readonly scope: NonNullable<AgentLimit["scope"]>;
  readonly recordedAt: number;
  readonly run: string;
  readonly revision: string;
  readonly lastProbeAt?: number;
  readonly limit: AgentLimit;
  /** When the preset is worth trying again. */
  readonly until: number;
  /** Whether `until` is the provider's stated reset rather than the next probe. */
  readonly known: boolean;
}

/** The Map remains available for isolated evaluations and direct wrapper callers. */
export type LimitMemory = Map<string, RememberedLimit> | FileLimitMemory;

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

export function createLimitMemory(): Map<string, RememberedLimit> {
  return new Map();
}

/** Launcher default; resolution happens at preparation, identity at execution. */
export function launcherLimitMemory(): LimitMemory {
  const file = agentLimitsFile();
  return file === undefined ? createLimitMemory() : new FileLimitMemory(file);
}

function modelFamily(model: string | undefined): string | undefined {
  return model?.toLowerCase().match(/opus|sonnet|haiku/u)?.[0] ?? model?.toLowerCase();
}

function scopeOf(candidate: LimitCandidate, limit: AgentLimit): RememberedLimit["scope"] {
  if (limit.scope !== undefined) return limit.scope;
  if (candidate.harness === "claude") {
    if (["five_hour", "seven_day", "overage"].includes(limit.kind ?? "")) return "provider";
    if (["seven_day_opus", "seven_day_sonnet"].includes(limit.kind ?? "")) return "model";
  }
  if (candidate.harness === "codex" && limit.kind === "usage") return "provider";
  return "preset";
}

export function limitCovers(entry: RememberedLimit, candidate: Pick<LimitCandidate, "name" | "harness" | "model">): boolean {
  if (entry.harness !== candidate.harness) return false;
  if (entry.preset === candidate.name) return true;
  if (entry.harness === undefined) return false;
  return entry.scope === "provider" || (entry.scope === "model"
    && entry.family !== undefined && entry.family === modelFamily(candidate.model));
}

function covering(entries: Map<string, RememberedLimit>, candidate: LimitCandidate): RememberedLimit[] {
  return [...entries.values()].filter((entry) => limitCovers(entry, candidate));
}

function entryKey(entry: RememberedLimit): string {
  // Preserve legacy Map keys for presets without a declared harness. Reserve a prefix
  // for tuples, escaping preset names with that prefix to avoid collisions.
  return entry.harness === undefined && !entry.preset.startsWith("\0")
    ? entry.preset : `\0${JSON.stringify([entry.preset, entry.harness ?? null])}`;
}

function transaction<T>(memory: LimitMemory, at: number, change: (entries: Map<string, RememberedLimit>) => T): Promise<T> {
  return memory instanceof Map ? Promise.resolve(change(memory)) : memory.transaction(at, change);
}

export function readLimits(memory: LimitMemory, at = Date.now()): Promise<RememberedLimit[]> {
  return transaction(memory, at, (entries) => [...entries.values()]);
}

export function forgetLimits(memory: LimitMemory, preset?: string): Promise<void> {
  return transaction(memory, Date.now(), (entries) => {
    if (preset === undefined) entries.clear();
    else for (const [key, entry] of entries) if (entry.preset === preset) entries.delete(key);
  });
}

/** All mutations, including probe claims, merge under a cross-process lock. */
export class FileLimitMemory {
  readonly file: string;
  readonly run: () => string;
  readonly warn: (message: string) => void;
  private entries = createLimitMemory();
  private localOnly = false;
  private pending = Promise.resolve();

  constructor(file: string, options: { run?: () => string; warn?: (message: string) => void } = {}) {
    this.file = file;
    const identity = randomUUID();
    this.run = options.run ?? (() => process.env.MACHINES_RUN_PARENT ?? identity);
    this.warn = options.warn ?? console.warn;
  }

  async transaction<T>(at: number, change: (entries: Map<string, RememberedLimit>) => T): Promise<T> {
    // Serialize this instance too: after storage fails, queued callers must use
    // the same local memory instead of replacing it with an older disk snapshot.
    const previous = this.pending;
    let finish!: () => void;
    this.pending = new Promise<void>((resolve) => { finish = resolve; });
    await previous;
    try {
      return await this.apply(at, change);
    } finally { finish(); }
  }

  private degrade(cause: unknown): void {
    if (this.localOnly) return;
    this.localOnly = true;
    this.warn(`Cannot persist usage-limit memory at ${this.file}; using memory for this run only: ${cause instanceof Error ? cause.message : String(cause)}`);
  }

  private async apply<T>(at: number, change: (entries: Map<string, RememberedLimit>) => T): Promise<T> {
    let release: (() => void) | undefined;
    let original: string | undefined;
    try {
      if (!this.localOnly) {
        try {
          mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
          release = await acquireLock(this.file);
          try {
            original = readFileSync(this.file, "utf8");
          } catch (cause) {
            if (!hasCode(cause, "ENOENT")) throw cause;
          }
          try {
            const parsed: unknown = original === undefined ? [] : JSON.parse(original);
            if (!Array.isArray(parsed) || !parsed.every(validEntry)) throw new Error("Invalid usage-limit entries");
            this.entries = new Map(parsed.map((entry) => [entryKey(entry), entry]));
          } catch {
            const aside = `${this.file}.corrupt-${randomUUID()}`;
            renameSync(this.file, aside);
            this.warn(`Corrupt usage-limit memory moved to ${aside}; starting empty.`);
            original = undefined;
            this.entries = createLimitMemory();
          }
        } catch (cause) { this.degrade(cause); }
      }
      for (const [name, entry] of this.entries) if (entry.known && entry.until <= at) this.entries.delete(name);
      // Keep callback failures visible. Only storage is best effort, and a
      // failed write must neither discard nor reapply this local mutation.
      const result = change(this.entries);
      if (!this.localOnly) {
        try {
          const serialized = JSON.stringify([...this.entries.values()], null, 2) + "\n";
          if (serialized !== original && (original !== undefined || this.entries.size > 0)) {
            const temporary = `${this.file}.${randomUUID()}.tmp`;
            try {
              writeFileSync(temporary, serialized, { mode: 0o600, flag: "wx" });
              renameSync(temporary, this.file);
            } finally {
              if (existsSync(temporary)) unlinkSync(temporary);
            }
          }
        } catch (cause) { this.degrade(cause); }
      }
      return result;
    } finally {
      try { release?.(); } catch (cause) { this.degrade(cause); }
    }
  }
}

function validEntry(value: unknown): value is RememberedLimit {
  if (value === null || typeof value !== "object") return false;
  const entry = value as RememberedLimit;
  return typeof entry.preset === "string" && typeof entry.run === "string" && typeof entry.revision === "string"
    && Number.isFinite(entry.recordedAt) && Number.isFinite(entry.until) && typeof entry.known === "boolean"
    && ["preset", "provider", "model"].includes(entry.scope)
    && (entry.harness === undefined || typeof entry.harness === "string")
    && (entry.family === undefined || typeof entry.family === "string")
    && (entry.lastProbeAt === undefined || Number.isFinite(entry.lastProbeAt))
    && entry.limit !== null && typeof entry.limit === "object" && typeof entry.limit.harness === "string"
    && (entry.limit.kind === undefined || typeof entry.limit.kind === "string")
    && (entry.limit.resetsAt === undefined || Number.isFinite(entry.limit.resetsAt));
}

function hasCode(cause: unknown, code: string): boolean {
  return cause instanceof Error && "code" in cause && cause.code === code;
}

async function acquireLock(file: string): Promise<() => void> {
  const lock = `${file}.lock`;
  const owner = `${lock}.${process.pid}.${randomUUID()}`;
  // Linking a complete owner file avoids a crash leaving an empty, unidentifiable lock.
  writeFileSync(owner, JSON.stringify({ pid: process.pid }), { flag: "wx", mode: 0o600 });
  const deadline = Date.now() + 10_000;
  try {
    for (;;) {
      try {
        linkSync(owner, lock);
        return () => { unlinkSync(lock); unlinkSync(owner); };
      } catch (cause) {
        if (!hasCode(cause, "EEXIST")) throw cause;
      }
      // Only a dead process's lock is recoverable; a slow live writer is never evicted.
      // A separate recovery lock prevents two readers from removing a newly acquired lock.
      let recovery: number | undefined;
      try {
        recovery = openSync(`${lock}.recovery`, "wx", 0o600);
        const { pid } = JSON.parse(readFileSync(lock, "utf8")) as { pid: number };
        if (Number.isInteger(pid) && pid > 0) {
          try { process.kill(pid, 0); } catch (cause) {
            if (hasCode(cause, "ESRCH")) unlinkSync(lock);
          }
        }
      } catch (cause) {
        if (!hasCode(cause, "ENOENT") && !hasCode(cause, "EEXIST")) throw cause;
      } finally {
        if (recovery !== undefined) { closeSync(recovery); unlinkSync(`${lock}.recovery`); }
      }
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for usage-limit memory lock: ${lock}`);
      await timerSleep(10);
    }
  } catch (cause) {
    unlinkSync(owner);
    throw cause;
  }
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
  const isLimited = (entry: RememberedLimit, retrying?: ReadonlySet<RememberedLimit>) =>
    entry.until > now() && retrying?.has(entry) !== true;
  const withinResetMargin = (entry: RememberedLimit) =>
    entry.known && entry.until <= now() && entry.until + resetMarginMs > now();
  const snapshot = () => transaction(memory, now(), (entries) => new Map(entries));
  const attempt = (candidate: LimitCandidate, retrying?: ReadonlySet<RememberedLimit>) =>
    transaction(memory, now(), (entries) => {
      const observed = covering(entries, candidate);
      const blocked = observed.find((entry) => isLimited(entry, memory instanceof Map ? retrying : undefined));
      if (blocked !== undefined) return { blocked, observed };
      const claimed = observed.map((entry) => {
        if (memory instanceof Map || entry.known) return entry;
        const claim = { ...entry, until: now() + policy.probeMs, lastProbeAt: now(), revision: randomUUID() };
        entries.set(entryKey(entry), claim);
        return claim;
      });
      return { blocked: undefined, observed: claimed };
    });
  const succeeded = (observed: RememberedLimit[]) => transaction(memory, now(), (entries) => {
    for (const entry of observed) {
      const key = entryKey(entry);
      if (entries.get(key)?.revision === entry.revision) entries.delete(key);
    }
  });

  // The state decides what its limit means, so nothing is swapped, waited for, or reported as an update.
  const reported = async (request: AgentRequest, report?: AgentReporter): Promise<Event> => {
    const { blocked: known, observed } = await attempt(bound);
    if (known !== undefined) {
      throw new AgentLimitError(`${named(bound.name)} is at its usage limit (${resetText(known)})`, known.limit);
    }
    try {
      const event = await bound.runner(request, report);
      await succeeded(observed);
      return event;
    } catch (cause) {
      const limit = agentLimitOf(cause);
      if (limit === undefined) throw cause;
      // The run's other roles skip this preset, and the limit names it.
      throw new AgentLimitError(cause instanceof Error ? cause.message : String(cause), (await remember(bound, limit)).limit, { cause });
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
      const seen = new Map<string, RememberedLimit>();
      let passedOver: { candidate: LimitCandidate; remembered: RememberedLimit } | undefined;
      for (const [index, candidate] of candidates.entries()) {
        const { blocked, observed } = await attempt(candidate, retrying);
        for (const entry of observed) seen.set(entryKey(entry), entry);
        if (blocked !== undefined) {
          passedOver ??= { candidate, remembered: blocked };
          continue;
        }
        if (passedOver !== undefined && !interrupted && !waiting) {
          // Another role or run found the limit; name its origin and the replacement.
          // After a wait the preset is named when the Agent resumes.
          await tell(swapped(named(passedOver.candidate.name), "is at", passedOver.remembered, passedOver.candidate, candidate));
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
          await succeeded(observed);
          return event;
        } catch (cause) {
          limit = agentLimitOf(cause);
          if (limit === undefined) throw cause;
          lastFailure = cause;
        }
        interrupted = true;
        const remembered = await remember(candidate, limit);
        seen.set(entryKey(remembered), remembered);
        const current = await snapshot();
        const next = candidates.slice(index + 1).find((later) => !covering(current, later).some((entry) => isLimited(entry, retrying)));
        // Also while a wait is reported: each probe that moves on to another preset is a swap.
        if (next !== undefined) await tell(swapped(named(candidate.name), "reached", remembered, candidate, next));
      }

      const current = await snapshot();
      // Disk reads prune expired entries. Keep resets observed during this pass
      // until their safety margin ends, even if a fallback ran past the reset.
      for (const [key, entry] of seen) {
        if (!current.has(key) && withinResetMargin(entry)) current.set(key, entry);
      }
      if (candidates.some((candidate) => !covering(current, candidate).some((entry) =>
        isLimited(entry, memory instanceof Map ? retrying : undefined) || withinResetMargin(entry)))) continue;
      const limits = candidates.flatMap((candidate) => covering(current, candidate)
        .filter((entry) => isLimited(entry) || withinResetMargin(entry)).map((remembered) => ({ candidate, remembered })));
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
        if (!(memory instanceof Map)) {
          const refreshed = await snapshot();
          const ready = candidates.some((candidate) => {
            if (covering(refreshed, candidate).some((entry) => isLimited(entry))) return false;
            // Reading prunes a reset that just passed; retain the provider's safety margin.
            return !covering(current, candidate).some(withinResetMargin);
          });
          if (ready) break;
        }
      }
      retrying = new Set(wakes.filter((wake) => wake.at <= wakeAt).map((wake) => wake.remembered));
    }
  };

  async function remember(candidate: LimitCandidate, limit: AgentLimit): Promise<RememberedLimit> {
    const at = now();
    // A reset that has already passed says nothing about when to try again.
    const known = limit.resetsAt !== undefined && limit.resetsAt > at;
    const family = limit.scope === undefined && candidate.harness === "claude"
      && (limit.kind === "seven_day_opus" || limit.kind === "seven_day_sonnet")
      ? limit.kind.slice("seven_day_".length) : modelFamily(candidate.model);
    const remembered: RememberedLimit = {
      preset: candidate.name,
      ...(candidate.harness === undefined ? {} : { harness: candidate.harness }),
      ...(family === undefined ? {} : { family }),
      scope: scopeOf(candidate, limit),
      recordedAt: at,
      run: memory instanceof Map ? "local" : memory.run(),
      revision: randomUUID(),
      ...(!known ? { lastProbeAt: at } : {}),
      limit: { ...limit, agent: candidate.name },
      until: known ? limit.resetsAt : at + policy.probeMs,
      known,
    };
    await transaction(memory, at, (entries) => { entries.set(entryKey(remembered), remembered); });
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
  const origin = remembered !== undefined && remembered.preset !== from.name
    ? `, remembered from ${remembered.preset} (${remembered.limit.kind ?? "unknown"}, ${remembered.scope})` : "";
  return {
    type: "limit",
    status: "swapped",
    agent: from.name,
    to: to.name,
    text: `${subject} ${verb} its usage limit (${resetText(remembered)})${origin}; continuing with ${to.name}`,
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
