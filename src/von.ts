import { decisionAgent, type DecisionAgentOptions, type DecisionProvider } from "./decision.ts";
import { systemOneHttpProvider, type SystemOneHttpOptions } from "./system-one-http.ts";

export interface VonProviderOptions extends SystemOneHttpOptions {
  /** Overrides VON_BASE_URL, then http://127.0.0.1:8000. */
  readonly baseUrl?: string;
  /** Overrides VON_API_KEY. No TypeSafe/OpenRouter credential fallback. */
  readonly apiKey?: string;
  /** Overrides VON_MODEL, then von-1.0.0. Does NOT select the server backend. */
  readonly model?: string;
}

export type VonAgentOptions = VonProviderOptions & DecisionAgentOptions;

/** One Choice request to a separately managed Von server; no Python dependency. */
export function vonProvider(options: VonProviderOptions = {}): DecisionProvider {
  return systemOneHttpProvider({
    name: "von", label: "Von", envPrefix: "VON",
    baseUrl: "http://127.0.0.1:8000", model: "von-1.0.0", minChoices: 1,
  }, options);
}

/** Convenience binding. Transitions, confidence gates, and retries stay in Machines. */
export function vonAgent(options: VonAgentOptions = {}) {
  return decisionAgent(vonProvider(options), options);
}
