import * as v from "valibot";

import { decisionAgent, type DecisionAgentOptions, type DecisionProvider } from "./decision.ts";

export interface JevProviderOptions {
  /** Read lazily from TYPESAFE_API_KEY when omitted. Never used during discovery. */
  readonly apiKey?: string;
  /** Overrides JEV_MODEL, then the pinned default jev-1.13.0. */
  readonly model?: string;
  readonly timeoutMs?: number;
  /** Transport injection for tests or an explicitly configured HTTP client. */
  readonly fetch?: typeof globalThis.fetch;
}

export type JevAgentOptions = JevProviderOptions & DecisionAgentOptions;

const probability = v.pipe(v.number(), v.minValue(0), v.maxValue(1));
const responseSchema = v.object({
  model: v.pipe(v.string(), v.check(value => value.trim().length > 0)),
  answers: v.object({
    decision: v.object({
      type: v.literal("choice"),
      choice: v.string(),
      probabilities: v.record(v.string(), probability),
      confidence: probability,
    }),
  }),
});

/** TypeSafe Choice transport. No tool access, retries, or workflow policy. */
export function jevProvider(options: JevProviderOptions = {}): DecisionProvider {
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    throw new Error("Jev timeoutMs must be a positive 32-bit integer");
  }
  return {
    name: "jev",
    async decide(request) {
      const apiKey = options.apiKey ?? process.env.TYPESAFE_API_KEY;
      if (typeof apiKey !== "string" || !apiKey.trim()) {
        throw new Error("Jev requires TYPESAFE_API_KEY or an explicit apiKey");
      }
      const model = options.model ?? process.env.JEV_MODEL ?? "jev-1.13.0";
      if (typeof model !== "string" || !model.trim()) {
        throw new Error("Jev model must be non-empty");
      }
      const count = Object.keys(request.choices).length;
      if (count === 0 || count > 255) {
        throw new Error("Jev Choice requires between 1 and 255 outcomes");
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const timeoutError = () => new Error(`Jev request timed out after ${timeoutMs}ms`);
      try {
        let response: Response;
        try {
          response = await (options.fetch ?? globalThis.fetch)("https://api.typesafe.ai/v1/systemone", {
            method: "POST",
            redirect: "error",
            signal: controller.signal,
            headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              model,
              state: request.input,
              questions: {
                decision: { type: "choice", instructions: request.question, criteria: request.choices },
              },
            }),
          });
        } catch {
          // Do not forward transport errors that might contain credentials or input.
          throw controller.signal.aborted ? timeoutError() : new Error("Jev network request failed");
        }
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          throw new Error(`Jev request failed (HTTP ${response.status}); no automatic retry`);
        }
        let body: unknown;
        try { body = await response.json(); }
        catch {
          throw controller.signal.aborted ? timeoutError() : new Error("Jev returned invalid JSON");
        }
        const parsed = v.safeParse(responseSchema, body);
        if (!parsed.success) throw new Error("Jev returned an invalid Choice response");
        const { choice, probabilities, confidence } = parsed.output.answers.decision;
        if (!Object.hasOwn(probabilities, choice)
          || Object.values(probabilities).some(value => value > probabilities[choice]!)) {
          throw new Error("Jev choice must have the highest probability");
        }
        return { choice, probabilities, confidence, model: parsed.output.model };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** Convenience preset; workflows can swap providers through decisionAgent instead. */
export function jevAgent(options: JevAgentOptions = {}) {
  return decisionAgent(jevProvider(options), options);
}
