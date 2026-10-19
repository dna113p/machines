import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import type { AgentRunner } from "../../../../src/index.ts";
import { readRunStatuses, runStatusDirectory } from "../../../../src/run-status.ts";

const cli = resolve(import.meta.dirname, "../../../../src/cli.ts");

/**
 * Approves every review. While it runs, it records what is published and what
 * `machine runs` lists to USE_OBSERVED, and it holds its turn until
 * USE_RELEASE exists, when either is set.
 */
const approve: AgentRunner = async () => {
  await new Promise((resolveTick) => setImmediate(resolveTick));
  const observed = process.env.USE_OBSERVED;
  if (observed) {
    writeFileSync(observed, JSON.stringify({
      records: readRunStatuses(runStatusDirectory() ?? ""),
      runs: spawnSync(process.execPath, [cli, "runs"], { encoding: "utf8" }).stdout,
    }));
  }
  const release = process.env.USE_RELEASE;
  while (release && !existsSync(release)) await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  return { type: "approved" };
};

export default function agents() {
  return {
    default: { description: "Approves every review.", runner: approve },
    reviewer: { description: "Approves every review, recording the run while it does.", runner: approve },
  };
}
