import type { AnyStateMachine } from "xstate";
import { runEnding, type EndingKind, type MachineEndings } from "./endings.ts";

/**
 * A Machine's states and transitions as data, for a surface that draws them.
 * Ids are state paths joined by dots, with the root left out: `plan`, or
 * `review.round` for a state nested in `review`.
 */
export interface RunGraph {
  readonly initial?: string;
  readonly states: readonly RunGraphState[];
  readonly edges: readonly RunGraphEdge[];
}

export interface RunGraphState {
  readonly id: string;
  /** The compound state this one is nested in. */
  readonly parent?: string;
  /** What runs in the state. `group` holds nested states; `state` runs nothing itself. */
  readonly kind: "agent" | "human" | "operation" | "final" | "group" | "state";
  /** The Agent role an Agent state runs. */
  readonly role?: string;
  /** The declared kind of a top-level final state. */
  readonly ending?: EndingKind;
}

export interface RunGraphEdge {
  readonly from: string;
  readonly to: string;
  /** The event the transition takes: an outcome, `done` when a group finishes, or `always`/`after`. */
  readonly event: string;
}

/** One state the run entered, and when. */
export interface RunTrailStep {
  readonly state: string;
  readonly at: string;
}

/** Past this a Machine is not drawn: its record would grow past what a reader can take in at once. */
const maxStates = 300;
const maxEdges = 1_000;

interface Node {
  readonly path: readonly string[];
  readonly type: string;
  readonly meta?: Record<string, unknown>;
  readonly invoke: ReadonlyArray<{ readonly src: unknown }>;
  readonly states: Readonly<Record<string, Node>>;
  readonly initial?: { readonly target?: ReadonlyArray<Node> };
  readonly transitions: ReadonlyMap<string, ReadonlyArray<{ readonly target?: ReadonlyArray<Node> }>>;
  readonly always?: ReadonlyArray<{ readonly target?: ReadonlyArray<Node> }>;
}

/**
 * Reads the graph out of a Machine definition, or returns undefined for one too
 * large to draw or one whose shape this cannot read. Never throws: a picture of
 * the workflow is never worth the run.
 */
export function machineGraph(definition: AnyStateMachine, endings?: MachineEndings): RunGraph | undefined {
  try {
    const root = (definition as unknown as { readonly root: Node }).root;
    const states: RunGraphState[] = [];
    const edges: RunGraphEdge[] = [];
    const id = (node: Node) => node.path.join(".");
    const visit = (node: Node, parent: string | undefined) => {
      const using = (node.meta?.["machines.agent"] as { readonly using?: unknown } | undefined)?.using;
      const src = node.invoke[0]?.src;
      const kind: RunGraphState["kind"] = node.type === "final" ? "final"
        : node.type === "compound" || node.type === "parallel" || node.meta?.["machines.use"] ? "group"
        : typeof using === "string" ? "agent"
        : src === "human" ? "human"
        : src !== undefined ? "operation"
        : "state";
      const ending = node.type === "final" && node.path.length === 1
        ? runEnding(endings, node.meta?.["machines.ending"]) : undefined;
      states.push({
        id: id(node),
        ...(parent === undefined ? {} : { parent }),
        kind,
        ...(ending === undefined ? {} : { ending: ending.kind }),
        ...(kind === "agent" ? { role: using as string } : {}),
      });
      const add = (event: string, targets: ReadonlyArray<Node> | undefined) => {
        for (const target of targets ?? []) {
          // A target outside the drawn states is the root itself, which nothing draws.
          if (target.path.length > 0) edges.push({ from: id(node), to: id(target), event });
        }
      };
      if (node.meta?.["machines.retry"]) add("retry", [node]);
      for (const [event, definitions] of node.transitions) {
        // The runtime's own actor events only run actions; the outcome they raise is the transition.
        // A plain XState state can target from them directly, through `onDone` and `onError`.
        const label = event.startsWith("xstate.done.state.") || event.startsWith("xstate.done.actor.") ? "done"
          : event.startsWith("xstate.error.actor.") ? "error"
          : event.startsWith("xstate.after.") ? "after"
          : event;
        for (const transition of definitions) add(label, transition.target);
      }
      for (const transition of node.always ?? []) add("always", transition.target);
      for (const child of Object.values(node.states)) visit(child, kind === "group" ? id(node) : parent);
    };
    for (const child of Object.values(root.states)) visit(child, undefined);
    if (states.length === 0 || states.length > maxStates || edges.length > maxEdges) return undefined;
    const initial = root.initial?.target?.[0];
    return { ...(initial === undefined ? {} : { initial: id(initial) }), states, edges: dedupe(edges) };
  } catch {
    return undefined;
  }
}

/** Add a started child's graph under its use state, retaining the existing graph at the limits. */
export function nestGraph(graph: RunGraph, at: string, child: RunGraph): RunGraph {
  const ids = new Set(graph.states.map((state) => state.id));
  const states = [...graph.states];
  for (const { id: childId, parent, ...state } of child.states) {
    const id = `${at}.${childId}`;
    if (ids.has(id)) continue;
    ids.add(id);
    states.push({ id, parent: parent === undefined ? at : `${at}.${parent}`, ...state });
  }
  const edges = dedupe([...graph.edges, ...child.edges.map((edge) => ({
    ...edge, from: `${at}.${edge.from}`, to: `${at}.${edge.to}`,
  }))]);
  if (states.length > maxStates || edges.length > maxEdges
    || (states.length === graph.states.length && edges.length === graph.edges.length)) return graph;
  return { ...graph, states, edges };
}

/** A state value as the dotted paths of its active leaves: `{"review":"round"}` is `review.round`. */
export function statePaths(value: unknown): string[] {
  if (typeof value === "string") {
    if (!value.startsWith("{")) return [value];
    try {
      return statePaths(JSON.parse(value));
    } catch {
      return [value];
    }
  }
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => {
    const below = statePaths(child);
    return below.length === 0 ? [key] : below.map((path) => `${key}.${path}`);
  });
}

function dedupe(edges: readonly RunGraphEdge[]): RunGraphEdge[] {
  const seen = new Set<string>();
  return edges.filter((edge) => {
    const key = `${edge.from}\0${edge.to}\0${edge.event}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Safe local node ids and quoted labels keep state names out of Mermaid syntax. */
export function machineMermaid(graph: RunGraph | undefined, current: string): string | undefined {
  if (!graph) return undefined;
  const label = (text: string) => text.replace(/[^a-zA-Z0-9 .,:_-]/gu,
    (character) => `#${character.codePointAt(0)};`);
  const ids = new Map(graph.states.map((state, index) => [state.id, `s${index}`]));
  return [
    "flowchart TD",
    ...graph.states.map((state) => `  ${ids.get(state.id)}["${label(`${state.id} (${state.kind}${state.role ? `: ${state.role}` : ""})`)}${state.id === current ? " ← current" : ""}"]${state.id === current ? ":::current" : ""}`),
    ...graph.edges.map((edge) => `  ${ids.get(edge.from)} -->|"${label(edge.event)}"| ${ids.get(edge.to)}`),
  ].join("\n");
}
