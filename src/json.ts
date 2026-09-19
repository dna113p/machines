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
