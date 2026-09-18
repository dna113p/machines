import * as v from "valibot";

import { decisionAgent, type DecisionAgentOptions, type DecisionProvider } from "./decision.ts";

export interface OpenRouterDecisionProviderOptions {
  /** Read lazily from OPENROUTER_API_KEY. Never needed during discovery. */
  readonly apiKey?: string;
  /** Overrides OPENROUTER_DECISION_MODEL, then the pinned typesafe/jev-1.13. */
  readonly model?: string;
  /** Defaults to 10 seconds; covers both the request and response-body read. */
  readonly timeoutMs?: number;
  /** Explicit transport injection. Custom clients must honor the AbortSignal. */
  readonly fetch?: typeof globalThis.fetch;
}

export type OpenRouterDecisionAgentOptions = OpenRouterDecisionProviderOptions & DecisionAgentOptions;

const nonBlank = v.pipe(v.string(), v.check(value => value.trim().length > 0));
const probability = v.pipe(v.number(), v.minValue(0), v.maxValue(1));
// Validate only the fields consumed by this adapter. Usage and other metadata
// are not forwarded into workflow events or observer output.
const responseSchema = v.object({
  model: nonBlank,
  answers: v.object({
    decision: v.object({
      type: v.literal("choice"),
      choice: nonBlank,
      probabilities: v.optional(v.pipe(
        v.unknown(), v.check(value => !Array.isArray(value)), v.record(v.string(), probability),
      )),
      confidence: v.optional(probability),
    }),
  }),
});

/** OpenRouter Decisions transport, not chat completions or a coding agent. */
export function openRouterDecisionProvider(
  options: OpenRouterDecisionProviderOptions = {},
): DecisionProvider {
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    throw new Error("OpenRouter Decisions timeoutMs must be a positive 32-bit integer");
  }
  return {
    name: "openrouter-decision",
    async decide(request) {
      const apiKey = options.apiKey ?? process.env.OPENROUTER_API_KEY;
      if (typeof apiKey !== "string" || !apiKey.trim()) {
        throw new Error("OpenRouter Decisions requires OPENROUTER_API_KEY or an explicit apiKey");
      }
      const model = options.model ?? process.env.OPENROUTER_DECISION_MODEL ?? "typesafe/jev-1.13";
      if (typeof model !== "string" || !model.trim()) {
        throw new Error("OpenRouter Decisions model must be non-empty");
      }
      if (Object.keys(request.choices).length === 0) {
        throw new Error("OpenRouter Decisions requires at least one outcome");
      }
      // OpenRouter requires string criteria; the neutral contract allows null.
      // Preserve labels verbatim and use the label when no description is given.
      const criteria = Object.fromEntries(Object.entries(request.choices).map(
        ([label, description]) => [label, description ?? label],
      ));
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const timeoutError = () => new Error(`OpenRouter Decisions request timed out after ${timeoutMs}ms`);
      try {
        let response: Response;
        try {
          response = await (options.fetch ?? globalThis.fetch)("https://openrouter.ai/api/alpha/decisions", {
            method: "POST",
            redirect: "error",
            signal: controller.signal,
            headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              model,
              state: request.input,
              questions: {
                decision: { type: "choice", instructions: request.question, criteria },
              },
            }),
          });
        } catch {
          // Transport errors may contain credentials or evidence; do not expose them.
          throw controller.signal.aborted ? timeoutError() : new Error("OpenRouter Decisions network request failed");
        }
        if (!response.ok) {
          // Discard diagnostics without waiting on an untrusted error-body stream.
          void response.body?.cancel().catch(() => {});
          throw new Error(`OpenRouter Decisions request failed (HTTP ${response.status}); no automatic retry`);
        }
        let body: unknown;
        try { body = await response.json(); }
        catch {
          throw controller.signal.aborted ? timeoutError() : new Error("OpenRouter Decisions returned invalid JSON");
        }
        const parsed = v.safeParse(responseSchema, body);
        if (!parsed.success) throw new Error("OpenRouter Decisions returned an invalid Choice response");
        const { choice, probabilities, confidence } = parsed.output.answers.decision;
        return {
          choice,
          ...(probabilities === undefined ? {} : { probabilities }),
          ...(confidence === undefined ? {} : { confidence }),
          model: parsed.output.model,
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** Convenience preset; workflow policy stays in the Machine. */
export function openRouterDecisionAgent(options: OpenRouterDecisionAgentOptions = {}) {
  return decisionAgent(openRouterDecisionProvider(options), options);
}
