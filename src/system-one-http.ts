import * as v from "valibot";

import type { DecisionProvider } from "./decision.ts";

/** Shared transport options for self-hosted System One Choice services. */
export interface SystemOneHttpOptions {
  /** Server root (optionally including a proxy prefix), without /v1/systemone. */
  readonly baseUrl?: string;
  /** Optional Bearer token. Only the selected provider's environment is read. */
  readonly apiKey?: string;
  /** Wire model identifier; checkpoint/backend selection belongs to the server. */
  readonly model?: string;
  /** Defaults to 30 seconds, including reading the response body. */
  readonly timeoutMs?: number;
  /** Injected clients must honor the AbortSignal to release network resources. */
  readonly fetch?: typeof globalThis.fetch;
}

interface Service {
  readonly name: string;
  readonly label: string;
  readonly envPrefix: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly minChoices: number;
}

const nonBlank = v.pipe(v.string(), v.check(value => value.trim().length > 0));
const probability = v.pipe(v.number(), v.minValue(0), v.maxValue(1));
const responseSchema = v.object({
  model: nonBlank,
  answers: v.object({
    decision: v.object({
      type: v.literal("choice"),
      choice: nonBlank,
      probabilities: v.pipe(
        v.unknown(), v.check(value => !Array.isArray(value)), v.record(v.string(), probability),
      ),
      confidence: probability,
    }),
  }),
});
const maxResponseBytes = 1_048_576;

/** Internal plumbing shared by Von and Laya, not a new workflow primitive. */
export function systemOneHttpProvider(service: Service, options: SystemOneHttpOptions): DecisionProvider {
  const { label, envPrefix } = service;
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    throw new Error(`${label} timeoutMs must be a positive 32-bit integer`);
  }
  return {
    name: service.name,
    async decide(request) {
      // Resolve all environment configuration lazily: discovery never contacts a
      // service, validates credentials, starts Python, or downloads model weights.
      const endpoint = serviceEndpoint(options.baseUrl ?? process.env[`${envPrefix}_BASE_URL`] ?? service.baseUrl, label);
      const apiKey = options.apiKey ?? process.env[`${envPrefix}_API_KEY`];
      if (apiKey !== undefined && (typeof apiKey !== "string" || !/^[\x21-\x7e]+$/.test(apiKey))) {
        throw new Error(`${label} apiKey must be a non-empty ASCII Bearer token`);
      }
      const model = options.model ?? process.env[`${envPrefix}_MODEL`] ?? service.model;
      if (typeof model !== "string" || !model.trim()) throw new Error(`${label} model must be non-empty`);
      const choices = Object.entries(request.choices);
      if (choices.length < service.minChoices) {
        throw new Error(`${label} Choice requires at least ${service.minChoices} outcome(s)`);
      }
      if (!request.question?.trim() || !request.input?.trim()
        || choices.some(([key, value]) => !key.trim() || key !== key.trim()
          || (value !== null && (typeof value !== "string" || !value.trim())))) {
        throw new Error(`${label} requires non-empty evidence, question, and valid choices`);
      }
      const controller = new AbortController();
      const timeoutError = () => new Error(`${label} request timed out after ${timeoutMs}ms`);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(timeoutError()); }, timeoutMs);
      });
      const execute = async () => {
        let response: Response;
        try {
          response = await (options.fetch ?? globalThis.fetch)(endpoint, {
            method: "POST", redirect: "error", signal: controller.signal,
            headers: {
              "Content-Type": "application/json",
              ...(apiKey === undefined ? {} : { Authorization: `Bearer ${apiKey}` }),
            },
            body: JSON.stringify({
              model, state: request.input,
              questions: {
                decision: { type: "choice", instructions: request.question, criteria: request.choices },
              },
            }),
          });
        } catch {
          throw controller.signal.aborted ? timeoutError() : new Error(`${label} network request failed`);
        }
        if (controller.signal.aborted || !response.ok) {
          // Do not wait on untrusted error streams, or expose their contents.
          void response.body?.cancel().catch(() => {});
          if (controller.signal.aborted) throw timeoutError();
          throw new Error(`${label} request failed (HTTP ${response.status}); no automatic retry`);
        }
        let body: unknown;
        const reader = response.body?.getReader();
        const cancel = () => { void reader?.cancel().catch(() => {}); };
        controller.signal.addEventListener("abort", cancel, { once: true });
        try {
          const chunks: Uint8Array[] = [];
          let bytes = 0;
          if (reader) {
            while (true) {
              const { value, done } = await reader.read();
              if (done) break;
              bytes += value.byteLength;
              if (bytes > maxResponseBytes) {
                cancel();
                throw new RangeError("Response size limit");
              }
              chunks.push(value);
            }
          }
          body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch (error) {
          if (controller.signal.aborted) throw timeoutError();
          throw new Error(error instanceof RangeError
            ? `${label} response exceeds 1 MiB` : `${label} returned invalid JSON`);
        } finally {
          controller.signal.removeEventListener("abort", cancel);
          reader?.releaseLock();
        }
        if (controller.signal.aborted) throw timeoutError();
        const parsed = v.safeParse(responseSchema, body);
        if (!parsed.success) throw new Error(`${label} returned an invalid Choice response`);
        const { choice, probabilities, confidence } = parsed.output.answers.decision;
        if (!Object.hasOwn(probabilities, choice)
          || Object.values(probabilities).some(value => value > probabilities[choice]!)) {
          throw new Error(`${label} choice must have the highest probability`);
        }
        return { choice, probabilities, confidence, model: parsed.output.model };
      };
      try { return await Promise.race([execute(), timeout]); }
      finally { clearTimeout(timer); }
    },
  };
}

function serviceEndpoint(value: string, label: string): string {
  try {
    if (typeof value !== "string" || !value.trim() || value !== value.trim()) throw new Error();
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error();
    }
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/v1/systemone`;
    return url.href;
  } catch {
    // A malformed URL may contain a password; never include it in the error.
    throw new Error(`${label} baseUrl must be an HTTP(S) server root without credentials, query, or fragment`);
  }
}
