import { humanRequestProblem } from "./human-request.ts";

/** Shared validation for workflow updates and persisted note/page pairs. */
export function runNoteProblem(value: { readonly note?: unknown; readonly page?: unknown }): string | undefined {
  if (value.note !== undefined && typeof value.note !== "string") return "Run note must be a string";
  if (value.page === undefined) return undefined;
  if (typeof value.note !== "string" || !value.note.trim()) return "Run page requires a non-empty note";
  return humanRequestProblem({ page: value.page as string })?.replace(/^Human page/u, "Run page");
}

/** Keep the existing summary normalization for explicitly authored notes too. */
export function formatNote(note: string | undefined): string | undefined {
  const text = note?.trim();
  if (!text) return undefined;
  if (text.length <= 2000) return text;
  // Reserve one character for the ellipsis, keeping the last whole word that fits.
  let end = 1999;
  while (end > 0 && !/\s/u.test(text[end]!)) end -= 1;
  // A single word longer than the limit still has to fit in the record.
  return `${text.slice(0, end || 1999).trimEnd()}…`;
}
