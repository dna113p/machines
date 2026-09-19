import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { deepseekAgent } from "../src/deepseek.ts";
import { agent, final, machine, operation, run } from "../src/index.ts";

// Requires an installed, configured dsh ACP profile. May use model credits.
// No automatic permission approval; all work is requested in this temporary cwd.
const cwd = await mkdtemp(join(tmpdir(), "machines-deepseek-example-"));
try {
  const workflow = machine({
    initial: "write",
    states: {
      write: agent(
        'Create hello.txt in your working directory containing exactly "Hello from DeepSeek.\\n". Do not modify any other files.',
        { completed: "verify" },
        { cwd },
      ),
      verify: operation(async () => {
        assert.equal(await readFile(join(cwd, "hello.txt"), "utf8"), "Hello from DeepSeek.\n");
        return { type: "verified" };
      }, { verified: "done" }),
      done: final(),
    },
  });

  const result = await run(workflow, { agents: { default: deepseekAgent() } });
  console.log(`write --completed--> verify --verified--> ${String(result.value)}`);
} finally {
  await rm(cwd, { recursive: true, force: true });
}
