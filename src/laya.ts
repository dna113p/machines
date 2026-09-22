import { decisionAgent, type DecisionAgentOptions, type DecisionProvider } from "./decision.ts";
import { systemOneHttpProvider, type SystemOneHttpOptions } from "./system-one-http.ts";

export interface LayaProviderOptions extends SystemOneHttpOptions {
  /** Overrides LAYA_BASE_URL, then http://127.0.0.1:8001. */
  readonly baseUrl?: string;
  /** Overrides LAYA_API_KEY. No other provider's credentials are used. */
  readonly apiKey?: string;
  /** Overrides LAYA_MODEL, then laya. Must match the bridge's --model identifier. */
  readonly model?: string;
}

export type LayaAgentOptions = LayaProviderOptions & DecisionAgentOptions;

/** Choice adapter for services/laya/server.py; the server owns checkpoint loading. */
export function layaProvider(options: LayaProviderOptions = {}): DecisionProvider {
  return systemOneHttpProvider({
    name: "laya", label: "Laya", envPrefix: "LAYA",
    baseUrl: "http://127.0.0.1:8001", model: "laya", minChoices: 2,
  }, options);
}

/** Convenience binding. The initial Laya checkpoint needs at least two choices. */
export function layaAgent(options: LayaAgentOptions = {}) {
  return decisionAgent(layaProvider(options), options);
}
