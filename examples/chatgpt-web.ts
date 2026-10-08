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
import { chatGptWebAgent } from "../src/chatgpt-web.ts";

// Requires a running rig-bridge reachable from ChatGPT as a connector, and a
// ChatGPT login in the automation browser profile (see docs/authoring.md).
const workspace = await mkdtemp(join(tmpdir(), "machines-chatgpt-web-"));
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
    // This demo explicitly approves ChatGPT's tool confirmations for a temporary directory.
    default: chatGptWebAgent({ approveToolCalls: true }),
  },
  onAgentUpdate: update => {
    if (update.type === "tool") console.error(`[${update.status ?? "tool"}] ${update.title ?? update.id}`);
  },
});

console.log(`chatgpt-web workspace: ${workspace}`);
console.log(`hello.txt: ${(await readFile(helloPath, "utf8")).trim()}`);
console.log(`verified --> ${String(result.value)}`);
