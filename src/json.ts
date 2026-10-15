/** Values that can cross the hosted-run process boundary without conversion. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export function isJsonValue(value: unknown): value is JsonValue {
  const ancestors = new Set<object>();
  function visit(item: unknown): boolean {
    if (item === null || typeof item === "string" || typeof item === "boolean")
      return true;
    if (typeof item === "number") return Number.isFinite(item);
    if (typeof item !== "object" || ancestors.has(item)) return false;
    if (
      !Array.isArray(item) &&
      Object.getPrototypeOf(item) !== Object.prototype &&
      Object.getPrototypeOf(item) !== null
    )
      return false;
    if (Object.getOwnPropertySymbols(item).length > 0) return false;
    ancestors.add(item);
    const valid = Array.isArray(item)
      ? [...item].every(visit)
      : Object.values(item).every(visit);
    ancestors.delete(item);
    return valid;
  }
  return visit(value);
}

export function assertJsonValue(
  value: unknown,
  label = "value",
): asserts value is JsonValue {
  if (!isJsonValue(value))
    throw new Error(`${label} must be a JSON-serializable value`);
}

/** First value JSON would lose or change, with its location. */
export function jsonProblem(value: unknown, label = "value"): string | undefined {
  const ancestors = new Set<object>();
  function visit(item: unknown, path: string): string | undefined {
    if (item === null || typeof item === "string" || typeof item === "boolean") return;
    if (typeof item === "number") return Number.isFinite(item) ? undefined : `${path} is not a finite number`;
    if (typeof item !== "object") return `${path} is ${typeof item === "function" ? "a function" : typeof item}`;
    if (ancestors.has(item)) return `${path} contains a cycle`;
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) {
      return `${path} is not a plain object`;
    }
    if (Object.getOwnPropertySymbols(item).length) return `${path} has a symbol key`;
    if (Array.isArray(item)) {
      const extra = Object.getOwnPropertyNames(item).find((key) => key !== "length" && (!/^(0|[1-9][0-9]*)$/u.test(key) || Number(key) >= item.length));
      if (extra !== undefined) return `${path}.${extra} is an extra array property`;
    }
    ancestors.add(item);
    const keys = Array.isArray(item) ? Array.from({ length: item.length }, (_, i) => String(i)) : Object.getOwnPropertyNames(item);
    for (const key of keys) {
      const location = Array.isArray(item) ? `${path}[${key}]` : `${path}.${key}`;
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (descriptor && (!descriptor.enumerable || !("value" in descriptor))) return `${location} is not a plain enumerable value`;
      const problem = visit((item as Record<string, unknown>)[key], location);
      if (problem) return problem;
    }
    ancestors.delete(item);
  }
  return visit(value, label);
}
