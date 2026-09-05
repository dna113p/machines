import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

/** Select a separate global catalog without changing the process's real home. */
export function machinesUserHome(): string {
  const override = process.env.MACHINES_USER_HOME;
  if (override === undefined) return homedir();
  if (!isAbsolute(override)) throw new Error("MACHINES_USER_HOME must be an absolute path");
  return override;
}

export interface DiscoveredMachine {
  readonly name: string;
  readonly path: string;
}

export async function discoverMachines(
  cwd: string,
  home: string,
): Promise<readonly DiscoveredMachine[]> {
  const globalDirectory = join(home, ".machines");
  const projectDirectory = await nearestMachinesDirectory(cwd);
  const found = new Map<string, string>();

  for (const machine of await machinesIn(globalDirectory)) {
    found.set(machine.name, machine.path);
  }

  if (projectDirectory !== undefined) {
    for (const machine of await machinesIn(projectDirectory)) {
      found.set(machine.name, machine.path);
    }
  }

  return [...found]
    .map(([name, path]) => ({ name, path }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export async function nearestMachinesDirectory(cwd: string): Promise<string | undefined> {
  let directory = cwd;

  while (true) {
    const candidate = join(directory, ".machines");
    if (await isDirectory(candidate)) return candidate;

    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

async function machinesIn(directory: string): Promise<readonly DiscoveredMachine[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (cause) {
    if (isMissing(cause)) return [];
    throw cause;
  }

  const found = new Map<string, string>();

  for (const entry of entries) {
    const machineDirectory = join(directory, entry.name);
    if (!await isDirectory(machineDirectory)) continue;
    const path = join(machineDirectory, "index.ts");
    if (await isFile(path)) found.set(entry.name, path);
  }

  for (const entry of entries) {
    if (
      !entry.name.endsWith(".ts")
      || entry.name.endsWith(".d.ts")
      || entry.name === "agents.ts"
    ) {
      continue;
    }
    const path = join(directory, entry.name);
    if (await isFile(path)) found.set(entry.name.slice(0, -3), path);
  }

  return [...found].map(([name, path]) => ({ name, path }));
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (cause) {
    if (isMissing(cause)) return false;
    throw cause;
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (cause) {
    if (isMissing(cause)) return false;
    throw cause;
  }
}

function isMissing(cause: unknown): cause is NodeJS.ErrnoException {
  return cause instanceof Error && "code" in cause && cause.code === "ENOENT";
}
