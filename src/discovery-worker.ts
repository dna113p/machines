import { machinesUserHome } from "./discovery.ts";
import { resolve } from "node:path";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

import {
  inspectAgentPresets,
  inspectMachines,
  type AgentPresetSummary,
  type LauncherLocation,
  type MachineSummary,
} from "./catalog.ts";

type CatalogKind = "machines" | "agents";
interface CatalogJob {
  readonly machinesCatalog: true;
  readonly kind: CatalogKind;
  readonly location: LauncherLocation;
}
type CatalogEntries = readonly MachineSummary[] | readonly AgentPresetSummary[];
type CatalogReply = { readonly entries: CatalogEntries } | { readonly error: string };

export function queryCatalog(kind: "machines", location: LauncherLocation): Promise<readonly MachineSummary[]>;
export function queryCatalog(kind: "agents", location: LauncherLocation): Promise<readonly AgentPresetSummary[]>;
export function queryCatalog(kind: CatalogKind, location: LauncherLocation): Promise<CatalogEntries> {
  // A fresh module graph also refreshes transitive imports and releases their cache afterward.
  // This isolates discovery output/lifetime; the imported code remains trusted local code.
  const job: CatalogJob = {
    machinesCatalog: true,
    kind,
    location: {
      cwd: resolve(location.cwd ?? process.cwd()),
      home: resolve(location.home ?? machinesUserHome()),
    },
  };
  const worker = new Worker(new URL(import.meta.url), {
    workerData: job,
    execArgv: [],
    stdout: true,
    stderr: true,
  });
  worker.stdout.resume();
  worker.stderr.resume();
  return new Promise((resolveReply, reject) => {
    let settled = false;
    const finish = (reply: CatalogReply) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      if ("error" in reply) reject(new Error(reply.error));
      else resolveReply(reply.entries);
    };
    const timer = setTimeout(() => finish({ error: "Machine discovery timed out after 10 seconds" }), 10_000);
    worker.once("message", (reply: CatalogReply) => finish(reply));
    worker.once("error", (error) => finish({ error: error.message }));
    worker.once("exit", (code) => finish({ error: `Machine discovery exited before returning results (code ${code})` }));
  });
}

if (!isMainThread && parentPort !== null && workerData?.machinesCatalog === true) {
  const job = workerData as CatalogJob;
  const port = parentPort;
  const result = job.kind === "machines"
    ? inspectMachines(job.location)
    : inspectAgentPresets(job.location);
  void result.then(
    (entries) => port.postMessage({ entries } satisfies CatalogReply),
    (cause: unknown) => port.postMessage({
      error: cause instanceof Error ? cause.message : String(cause),
    } satisfies CatalogReply),
  );
}
