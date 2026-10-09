import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { readRunStatuses } from "../../../src/run-status.ts";

/** Records what is published once the current state has been announced. */
export async function observeRunStatus(name: string): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  writeFileSync(
    join(process.env.RUN_STATUS_OBSERVED ?? "", `${name}.json`),
    JSON.stringify(readRunStatuses(process.env.MACHINES_RUN_STATUS_DIR ?? "")),
  );
}
