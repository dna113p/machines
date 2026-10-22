import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { machinesStateDirectory, machinesUserHome } from "./discovery.ts";

export interface ProviderOrder {
  readonly order: readonly string[];
  readonly until?: string;
}

export function providerOrderPath(home = machinesUserHome()): string {
  return join(machinesStateDirectory(home), "provider-order.json");
}

export function providerOrderUntil(value: string, now = new Date()): string {
  if (/^\d{2}:\d{2}$/u.test(value)) {
    const [hour, minute] = value.split(":").map(Number) as [number, number];
    if (hour > 23 || minute > 59) throw new Error("--until must be an ISO time or HH:MM");
    const next = new Date(now);
    next.setHours(hour, minute, 0, 0);
    if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
    return next.toISOString();
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/u.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error("--until must be an ISO time or HH:MM");
  }
  return new Date(value).toISOString();
}

function validate(value: unknown): ProviderOrder {
  if (value === null || typeof value !== "object") throw new Error("Invalid provider order");
  const { order, until } = value as Partial<ProviderOrder>;
  if (!Array.isArray(order) || order.length === 0
    || order.some((name: unknown) => typeof name !== "string" || name.trim() === "")
    || (until !== undefined && (typeof until !== "string" || !Number.isFinite(Date.parse(until))))) {
    throw new Error("Invalid provider order: expected a nonempty order and optional ISO until time");
  }
  return { order: [...new Set(order)], ...(until === undefined ? {} : { until }) };
}

export async function readProviderOrder(home = machinesUserHome()): Promise<ProviderOrder | undefined> {
  const path = providerOrderPath(home);
  try {
    return validate(JSON.parse(await readFile(path, "utf8")));
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`Could not read provider preference at ${path}`, { cause });
  }
}

export async function writeProviderOrder(preference: ProviderOrder, home = machinesUserHome()): Promise<void> {
  const value = validate(preference);
  const path = providerOrderPath(home);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function clearProviderOrder(home = machinesUserHome()): Promise<void> {
  await rm(providerOrderPath(home), { force: true });
}

export function providerOrderExpired(preference: ProviderOrder, now = Date.now()): boolean {
  return preference.until !== undefined && Date.parse(preference.until) <= now;
}

/** Resolve once at preparation; an explicitly empty override disables the file. */
export async function effectiveProviderOrder(home = machinesUserHome()): Promise<readonly string[]> {
  const override = process.env.MACHINES_AGENT_PREFER;
  if (override !== undefined) return [...new Set(override.split(",").map((name) => name.trim()).filter(Boolean))];
  const preference = await readProviderOrder(home);
  return preference === undefined || providerOrderExpired(preference) ? [] : preference.order;
}

/** Stable sorting preserves both same-provider and unlisted candidate order. */
export function sortProviderCandidates<T extends { readonly harness?: string }>(
  candidates: readonly T[], order: readonly string[],
): T[] {
  const rank = (candidate: T) => {
    const index = candidate.harness === undefined ? -1 : order.indexOf(candidate.harness);
    return index < 0 ? order.length : index;
  };
  return [...candidates].sort((left, right) => rank(left) - rank(right));
}
