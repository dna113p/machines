import type { AgentSessionRequest, AgentUpdate } from "./index.ts";

/** The native session the latest call naming a workflow session kept. */
export interface AgentSessionRecord {
  /** The workflow's session name, from the Agent state's `session` option. */
  readonly name: string;
  /** The runner's own session id. */
  readonly id: string;
  /** The role that answered the call. */
  readonly role: string;
  /** The preset that answered, when the launcher selected one. */
  readonly agent?: string;
  readonly cwd?: string;
}

export type AgentSessionUpdate = Extract<AgentUpdate, { type: "session" }>;

/** What one Agent call asks its runner, and why it starts fresh when it does not ask to resume. */
export interface AgentSessionPlan {
  readonly name: string;
  readonly request: AgentSessionRequest;
  readonly reason?: string;
}

const maximumSessions = 50;

/** Well-formed records only: a checkpoint that lacks or garbles one leaves that session to start fresh. */
export function readSessionRecords(value: unknown): AgentSessionRecord[] {
  if (!Array.isArray(value)) return [];
  const records = new Map<string, AgentSessionRecord>();
  for (const item of value as unknown[]) {
    if (item === null || typeof item !== "object") continue;
    const { name, id, role, agent, cwd } = item as Record<string, unknown>;
    if (typeof name !== "string" || typeof id !== "string" || typeof role !== "string"
      || name === "" || id === "" || (agent !== undefined && typeof agent !== "string")
      || (cwd !== undefined && typeof cwd !== "string")) continue;
    records.delete(name);
    records.set(name, { name, id, role,
      ...(agent === undefined ? {} : { agent }), ...(cwd === undefined ? {} : { cwd }) });
  }
  return [...records.values()].slice(-maximumSessions);
}

/** Keeps the latest record per name, oldest first, within the bound a checkpoint carries. */
export function keepSession(records: Map<string, AgentSessionRecord>, record: AgentSessionRecord): void {
  records.delete(record.name);
  records.set(record.name, record);
  for (const name of records.keys()) {
    if (records.size <= maximumSessions) break;
    records.delete(name);
  }
}

export function planSession(
  name: string,
  role: string,
  cwd: string | undefined,
  recorded: AgentSessionRecord | undefined,
  restored: boolean,
  prompt: string,
  /** Who answered the latest earlier call without keeping a session. */
  cleared?: string,
): AgentSessionPlan {
  const fresh = (reason: string): AgentSessionPlan => ({ name, request: {}, reason });
  if (recorded === undefined) {
    return fresh(cleared !== undefined
      ? `${cleared} answered the latest earlier call and kept no session`
      : restored
      ? "the run continued from a checkpoint that holds no such session"
      : "no earlier call in this run kept it");
  }
  if (recorded.role !== role) return fresh(`role "${recorded.role}" answered the earlier call, and role "${role}" answers this one`);
  if (recorded.cwd !== cwd) return fresh(`the earlier call worked in ${recorded.cwd ?? "no set directory"}, and this one in ${cwd ?? "no set directory"}`);
  return { name, request: { resume: { id: recorded.id, prompt, ...(recorded.agent === undefined ? {} : { agent: recorded.agent }) } } };
}

/** The runtime's evidence for one call: the runner's report, named and explained. */
export function sessionEvidence(
  plan: AgentSessionPlan,
  update: Omit<AgentSessionUpdate, "type"> | undefined,
  role: string,
  failed = false,
  /** The preset that answered, when its runner reported no session. */
  agent?: string,
): AgentSessionUpdate {
  const status = update?.status ?? "fresh";
  const reason = status === "continued" ? undefined
    : update === undefined
      ? failed ? "the call failed before its runner reported a session" : "the runner keeps no session it can continue"
    : update.reason ?? plan.reason ?? "the runner started a new session instead of resuming";
  const id = update?.id;
  const preset = update?.agent ?? agent;
  const who = preset ?? role;
  return {
    type: "session",
    name: plan.name,
    status,
    ...(id === undefined ? {} : { id }),
    ...(preset === undefined ? {} : { agent: preset }),
    ...(reason === undefined ? {} : { reason }),
    text: status === "continued"
      ? `Agent session "${plan.name}" continued ${id ?? "its earlier session"} with ${who}`
      : `Agent session "${plan.name}" started fresh${id === undefined ? "" : ` as ${id}`} with ${who}: ${reason}`,
  };
}

/** Appends recovery text to the prompt a resumed session would receive. */
export function withSessionNote(request: AgentSessionRequest | undefined, note: string): AgentSessionRequest | undefined {
  if (request?.resume === undefined || note === "") return request;
  return { ...request, resume: { ...request.resume, prompt: `${request.resume.prompt}${note}` } };
}
