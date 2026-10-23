import type { RunSnapshot } from "../src/session.ts";
import { readRunStatuses, type RunStatusRecord } from "../src/run-status.ts";
import { runWatch, runWatchMatches, sameRunWatch, type RunWatch } from "../src/run-watch.ts";

export interface WakeContext {
  isIdle?(): boolean;
  hasPendingMessages?(): boolean;
  readonly sessionManager?: {
    getSessionId(): string;
    getEntries?(): readonly unknown[];
  };
}

export interface WakeApi {
  sendMessage?(message: {
    customType: string;
    content: string;
    display: boolean;
    details: unknown;
  }, options: { triggerTurn: boolean; deliverAs: "followUp" }): void;
  appendEntry?(customType: string, data: unknown): void;
}

type Snapshot = RunSnapshot | RunStatusRecord;
const receiptType = "machines-wake-delivered";
const messageType = "machines-wake";

interface WakeEvent {
  readonly key: string;
  readonly run: Snapshot;
  readonly event: "completed" | "failed" | "human";
  readonly requestId?: string;
}

/** Snapshot timestamps change on progress; only execution and request identities name events. */
function actionable(run: Snapshot): WakeEvent | undefined {
  const execution = "continued" in run ? run.continued?.at : undefined;
  const identity = [run.id, run.startedAt, execution ?? null];
  if (run.status === "completed" || run.status === "failed") {
    return { key: JSON.stringify([...identity, run.status]), run, event: run.status };
  }
  const requestId = run.human?.requestId ?? ("humanEventId" in run ? run.humanEventId : undefined);
  if ((run.status === "waiting" || run.status === "sleeping") && requestId !== undefined
    && run.human !== undefined
    && !("answer" in run.human && run.human.answer !== undefined)) {
    return {
      key: JSON.stringify([...identity, "human", requestId]), run,
      event: "human", requestId,
    };
  }
  return undefined;
}

/** One Pi runtime and session. Observation never takes MachineSession ownership. */
export class PiWake {
  readonly #pi: WakeApi;
  readonly #context: WakeContext;
  readonly #sessionId: string;
  readonly #spawned = new Set<string>();
  readonly #attachments: Array<{ directory: string; watch: RunWatch }> = [];
  readonly #delivered = new Set<string>();
  readonly #pending = new Map<string, WakeEvent>();
  readonly #terminal = new Map<string, RunSnapshot>();
  #closed = false;
  // Only known non-agent work permits idle recovery without settlement.
  // Agent work always waits for settlement, including after tree navigation.
  #barrier: "busy" | "agent" | "manual-compaction" | "tree" | undefined;

  constructor(pi: WakeApi, context: WakeContext) {
    const sessionId = context.sessionManager?.getSessionId();
    if (!sessionId) throw new Error("Pi did not provide a session id for wake registration");
    if (pi.sendMessage === undefined || pi.appendEntry === undefined || context.isIdle === undefined) {
      throw new Error("Machine wake registration requires Pi sendMessage, appendEntry, and isIdle APIs");
    }
    this.#pi = pi;
    this.#context = context;
    this.#sessionId = sessionId;
    // Receipts are session-wide delivery facts, including across tree navigation.
    // A fork inherits entries but has another session id, so inherits no receipts.
    for (const value of context.sessionManager?.getEntries?.() ?? []) {
      if (value === null || typeof value !== "object") continue;
      const entry = value as { type?: string; customType?: string; data?: unknown; details?: unknown };
      const data = entry.type === "custom" && entry.customType === receiptType ? entry.data
        : entry.type === "custom_message" && entry.customType === messageType ? entry.details : undefined;
      if (data === null || typeof data !== "object") continue;
      const receipt = data as { sessionId?: string; key?: unknown };
      if (receipt.sessionId === sessionId && typeof receipt.key === "string") this.#delivered.add(receipt.key);
    }
  }

  registerSpawned(id: string): void {
    if (this.#current()) this.#spawned.add(id);
  }

  attach(target: string, directory: string): void {
    const watch = runWatch({ text: target });
    if (!this.#current()) throw new Error("Machine wake registration is closed or stale");
    if (!this.#attachments.some(entry => entry.directory === directory && sameRunWatch(entry.watch, watch))) {
      this.#attachments.push({ directory, watch });
    }
  }

  detach(target: string): void {
    const watch = runWatch({ text: target });
    for (let index = this.#attachments.length - 1; index >= 0; index -= 1) {
      if (sameRunWatch(this.#attachments[index]!.watch, watch)) this.#attachments.splice(index, 1);
    }
    for (const id of this.#spawned) if (id.startsWith(target.trim())) this.#spawned.delete(id);
    for (const [id, run] of this.#terminal) if (!this.#registered(run)) this.#terminal.delete(id);
    // A remaining overlapping registration still explicitly authorizes delivery.
    const external = new Set(this.records().map(run => run.id));
    for (const [key, event] of this.#pending) {
      if (!this.#spawned.has(event.run.id) && !external.has(event.run.id)) this.#pending.delete(key);
    }
  }

  registrations(): readonly { directory: string; watch: RunWatch }[] {
    return this.#attachments.map(entry => ({ ...entry, watch: { ...entry.watch } }));
  }

  /** Final owned snapshots remain authoritative after MachineSession evicts its recent history. */
  retained(): RunSnapshot[] {
    return this.#current() ? [...this.#terminal.values()] : [];
  }

  get hasPending(): boolean {
    return this.#current() && this.#pending.size > 0;
  }

  agentStarting(): void {
    if (this.#current()) this.#barrier = "agent";
  }

  treeNavigationStarting(): void {
    // Pi clears branch-summary busy state in finally, with no outcome event on
    // failure/cancellation. The observer can recover on idle for every outcome.
    if (this.#current() && this.#barrier !== "agent") this.#barrier = "tree";
  }

  manualCompactionFinished(): void {
    // Success is emitted before Pi clears its busy state; failure/cancellation
    // comes after. In either case the next idle refresh must still recheck it.
    if (this.#current() && this.#barrier !== "agent") this.#barrier = "manual-compaction";
  }

  /** No widget visibility window, count limit, implicit owner match, or status-file writes. */
  records(): RunStatusRecord[] {
    if (!this.#current()) return [];
    const records = new Map<string, RunStatusRecord>();
    for (const directory of new Set(this.#attachments.map(entry => entry.directory))) {
      const watches = this.#attachments.filter(entry => entry.directory === directory);
      for (const run of readRunStatuses(directory)) {
        if (watches.some(entry => runWatchMatches(entry.watch, run))) records.set(run.id, run);
      }
    }
    return [...records.values()];
  }

  /** Reconcile before sending, including requests answered by native dialogs while Pi was busy. */
  refresh(owned: readonly RunSnapshot[], settled = false): void {
    if (!this.#current()) return;
    for (const run of owned) {
      if (this.#registered(run) && (run.status === "completed" || run.status === "failed")) {
        this.#terminal.set(run.id, run);
      }
    }
    const retained = new Map(this.retained().map(run => [run.id, run]));
    for (const run of owned) retained.set(run.id, run);
    const snapshots: Snapshot[] = [
      ...[...retained.values()].filter(run => this.#registered(run)),
      ...this.records().filter(run => !retained.has(run.id)),
    ];
    const events = snapshots.flatMap(run => actionable(run) ?? []);
    const current = new Set(events.map(event => event.key));
    for (const key of this.#pending.keys()) if (!current.has(key)) this.#pending.delete(key);
    for (const event of events) if (!this.#delivered.has(event.key)) this.#pending.set(event.key, event);
    if (settled) this.#barrier = undefined;
    this.#flush();
  }

  close(): void {
    this.#closed = true;
    this.#spawned.clear();
    this.#attachments.length = 0;
    this.#pending.clear();
    this.#terminal.clear();
  }

  #registered(run: Snapshot): boolean {
    return this.#spawned.has(run.id) || this.#attachments.some(entry => runWatchMatches(entry.watch, run));
  }

  #current(): boolean {
    if (this.#closed) return false;
    if (this.#context.sessionManager?.getSessionId() === this.#sessionId) return true;
    this.close();
    return false;
  }

  #flush(): void {
    for (const [key, event] of this.#pending) {
      if (!this.#current()) return;
      if (!this.#context.isIdle?.() || this.#context.hasPendingMessages?.()) {
        this.#barrier ??= "busy";
        return;
      }
      if (this.#barrier === "busy" || this.#barrier === "agent") return;
      this.#barrier = undefined;
      const details = { sessionId: this.#sessionId, key };
      const subject = event.event === "human" ? `needs Human input (Human event ${event.requestId})` : event.event;
      // These APIs are synchronous handoffs. Pi owns turn startup and reports async failures.
      this.#pi.sendMessage!({
        customType: messageType, display: true, details,
        content: `Machine ${event.run.machine} ${subject}. Run id: ${event.run.id}. `
          + `Retrieve the authoritative snapshot with machine_status({ runId: ${JSON.stringify(event.run.id)} }). `
          + "Report the result or seek the Human's answer. This notification does not authorize a Human decision or response. "
          + "Only respond when the Human's answer is clear; external runs remain with their owner.",
      }, { triggerTurn: true, deliverAs: "followUp" });
      this.#delivered.add(key);
      this.#pending.delete(key);
      this.#pi.appendEntry!(receiptType, details);
    }
  }
}
