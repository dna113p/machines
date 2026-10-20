import type { HumanRequest } from "./index.ts";

/** Presentation values are fixed at definition time and checked again at invocation. */
export interface HumanPresentation {
  readonly headline?: string;
  readonly recommended?: string;
  readonly effects?: Readonly<Record<string, string>>;
  readonly discards?: readonly string[];
  readonly reason?: string;
  readonly page?: string;
}

function shortSentence(value: unknown): boolean {
  return typeof value === "string" && value.trim() !== "" && value.length <= 160
    && !/[\r\n\u2028\u2029]/u.test(value);
}

export function humanRequestProblem(request: HumanPresentation & { readonly choices?: readonly string[] }): string | undefined {
  if (request.headline !== undefined && !shortSentence(request.headline)) {
    return "Human headline must be a non-empty sentence of at most 160 characters on one line";
  }
  for (const field of ["recommended", "effects", "discards"] as const) {
    if (request[field] !== undefined && request.choices === undefined) return `Human ${field} requires choices`;
  }
  if (request.recommended !== undefined && !request.choices?.includes(request.recommended)) {
    return "Human recommended must be one of the choices";
  }
  if (request.effects !== undefined) {
    if (request.effects === null || typeof request.effects !== "object" || Array.isArray(request.effects)) {
      return "Human effects must map choices to sentences";
    }
    for (const [choice, effect] of Object.entries(request.effects)) {
      if (!request.choices?.includes(choice)) return `Human effects contains an unknown choice: ${choice}`;
      if (!shortSentence(effect)) return "Human effects must contain non-empty sentences of at most 160 characters on one line";
    }
  }
  if (request.discards !== undefined) {
    if (!Array.isArray(request.discards) || request.discards.some(choice => !request.choices?.includes(choice))) {
      return "Human discards must contain only choices";
    }
    if (new Set(request.discards).size !== request.discards.length) return "Human discards must not repeat a choice";
    if (request.recommended !== undefined && request.discards.includes(request.recommended)) {
      return "Human discards must not include the recommended choice";
    }
  }
  if (request.reason !== undefined) {
    if (typeof request.reason !== "string" || !request.reason.trim() || request.reason.length > 1000) {
      return "Human reason must contain 1–1000 characters";
    }
    if (request.recommended === undefined) return "Human reason requires recommended";
  }
  if (request.page !== undefined) {
    if (typeof request.page !== "string" || Buffer.byteLength(request.page, "utf8") > 200_000) {
      return "Human page must be an HTML body fragment of at most 200,000 bytes of UTF-8";
    }
    return pageProblem(request.page);
  }
  return undefined;
}

/** Refuse obvious active content, not a sanitizer. Hosts must still isolate pages. */
function pageProblem(page: string): string | undefined {
  // Scan like HTML: quotes open only at the start of an attribute value.
  const starts = /<\/?[a-z]/giu;
  let tag: RegExpExecArray | null;
  while ((tag = starts.exec(page)) !== null) {
    let i = tag.index + (page[tag.index + 1] === "/" ? 2 : 1);
    const start = i;
    while (i < page.length && !/[\s/>]/u.test(page[i]!)) i += 1;
    const name = page.slice(start, i).toLowerCase();
    if (/^(?:script|style|link|meta|iframe|object|embed|base|html|head|body|font)$/u.test(name)) {
      return `Human page must not contain <${name}>`;
    }
    for (;;) {
      while (i < page.length && /[\s/]/u.test(page[i]!)) i += 1;
      if (page[i] === ">") { i += 1; break; }
      if (i >= page.length) return "Human page has an unclosed tag";
      const start = i;
      // A leading '=' is an attribute name character in HTML.
      i += 1;
      while (i < page.length && !/[\s/>=]/u.test(page[i]!)) i += 1;
      const key = page.slice(start, i).toLowerCase();
      while (i < page.length && /\s/u.test(page[i]!)) i += 1;
      let value = "";
      if (page[i] === "=") {
        i += 1;
        while (i < page.length && /\s/u.test(page[i]!)) i += 1;
        const quote = page[i];
        if (quote === '"' || quote === "'") {
          const end = page.indexOf(quote, i + 1);
          if (end < 0) return "Human page has an unclosed tag";
          value = page.slice(i + 1, end);
          i = end + 1;
        } else {
          const start = i;
          while (i < page.length && !/[\s>]/u.test(page[i]!)) i += 1;
          value = page.slice(start, i);
        }
      }
      if (key.startsWith("on") || /^(?:style|src|srcset|srcdoc|poster|background|action|formaction|data|color|bgcolor|face)$/u.test(key)) {
        return `Human page must not contain the ${key} attribute`;
      }
      if (key === "href" || key === "xlink:href") {
        if (name !== "a") return `Human page must not contain ${key} on <${name}>`;
        const href = value
          .replace(/&#(x[\da-f]+|\d+);?/giu, (_, code: string) => {
            const point = code[0]!.toLowerCase() === "x" ? parseInt(code.slice(1), 16) : Number(code);
            return point <= 0x10ffff ? String.fromCodePoint(point) : "\ufffd";
          })
          .replace(/&(?:colon|tab|newline);/giu, entity => entity.toLowerCase() === "&colon;" ? ":" : "")
          // URL parsers ignore ASCII controls; inspect the effective scheme.
          // eslint-disable-next-line no-control-regex
          .replace(/[\u0000-\u0020\u007f]/gu, "");
        if (/^(?:javascript|data|vbscript):/iu.test(href)) return "Human page must not contain an active href";
      }
    }
    starts.lastIndex = i;
  }
  return undefined;
}

/** Copies only the public request fields; absent fields remain absent. */
export function copyHumanRequest(request: HumanRequest) {
  return {
    prompt: request.prompt,
    ...(request.discussion === true ? { discussion: true } : {}),
    ...(request.choices === undefined ? {} : { choices: [...request.choices] }),
    ...(request.suggestions === undefined ? {} : { suggestions: [...request.suggestions] }),
    ...(request.headline === undefined ? {} : { headline: request.headline }),
    ...(request.recommended === undefined ? {} : { recommended: request.recommended }),
    ...(request.effects === undefined ? {} : { effects: { ...request.effects } }),
    ...(request.discards === undefined ? {} : { discards: [...request.discards] }),
    ...(request.reason === undefined ? {} : { reason: request.reason }),
    ...(request.page === undefined ? {} : { page: request.page }),
  };
}

export function humanChoiceLabel(request: HumanPresentation, choice: string): string {
  return choice + (choice === request.recommended ? " (recommended)" : "")
    + (request.discards?.includes(choice) ? " (discards work)" : "");
}

/** State fields win; each addition must also be valid alongside them. */
export function mergePresentation(request: HumanRequest, candidate: Record<string, unknown>): {
  request: HumanRequest; dropped: readonly string[];
} {
  let merged = copyHumanRequest(request);
  const dropped: string[] = [];
  for (const field of ["headline", "recommended", "effects", "discards", "reason", "page"] as const) {
    if (request[field] !== undefined || candidate[field] === undefined) continue;
    const next = { ...merged, [field]: candidate[field] } as HumanRequest;
    const problem = humanRequestProblem(next);
    if (problem) dropped.push(`${field}: ${problem}`);
    else merged = copyHumanRequest(next);
  }
  return { request: merged, dropped };
}
