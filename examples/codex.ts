import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  agent,
  final,
  machine,
  operation,
  run,
} from "../src/index.ts";
import { codexAgent } from "../src/codex.ts";

const workspace = await mkdtemp(join(tmpdir(), "machines-codex-"));
const helloPath = join(workspace, "hello.txt");

const example = machine({
  initial: "write",
  states: {
    write: agent(
      "Create hello.txt containing exactly: Hello from Machines.",
      { completed: "verify" },
      { cwd: workspace },
    ),
    verify: operation(async () => {
      const content = await readFile(helloPath, "utf8");
      if (content.trim() !== "Hello from Machines.") {
        throw new Error("hello.txt did not contain the expected text");
      }
      return { type: "passed" };
    }, { passed: "done" }),
    done: final(),
  },
});

const result = await run(example, {
  agents: {
    // This demo explicitly permits edits in a temporary, non-Git workspace.
    default: codexAgent("codex", [], { sandbox: "workspace-write", skipGitRepoCheck: true }),
  },
});

console.log(`codex workspace: ${workspace}`);
console.log(`hello.txt: ${(await readFile(helloPath, "utf8")).trim()}`);
console.log(`verified --> ${String(result.value)}`);
