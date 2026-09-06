import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import * as v from "valibot";

import { agentPrompt, readAgentEvent } from "./agent-protocol.ts";

import type {
  AgentReporter,
  AgentRunner,
  Event,
} from "./index.ts";

export interface AgyAgentOptions {
  readonly env?: Readonly<Record<string, string>>;
  readonly harness?: string;
  readonly model?: string;
  readonly effort?: "low" | "medium" | "high";
  /** Explicitly opt in to auto-approving all AGY tool permission requests. */
  readonly dangerouslySkipPermissions?: boolean;
  readonly output?: "capture" | "stream";
}

export function agyAgent(
  command = "agy",
  args: readonly string[] = [],
  options: AgyAgentOptions = {},
): AgentRunner {
  return async (request, report) => {
    if (request.cwd === undefined) {
      throw new Error("agy Agent requires a working directory");
    }

    if (request.outcomes.length === 0) {
      throw new Error("agy Agent requires at least one allowed outcome");
    }

    const harness = options.harness ?? (command === "agy" ? "agy" : command);
    const env = { ...process.env, ...options.env };
    const model = options.model ?? env.AGY_MODEL ?? env.MACHINES_AGENT_MODEL;
    const effort = options.effort ?? env.AGY_EFFORT ?? env.MACHINES_AGENT_EFFORT;
    const outputMode = options.output ?? "stream";

    report?.({
      type: "identity",
      harness,
      ...(model === undefined ? {} : { model }),
      ...(effort === undefined ? {} : { thinking: effort }),
    });

    const cliArgs = [
      ...args,
      "--print",
      agentPrompt(request),
      "--output-format",
      "stream-json",
      "--disable-slash-commands",
      ...(options.dangerouslySkipPermissions === true ? ["--dangerously-skip-permissions"] : []),
      ...(model === undefined ? [] : ["--model", model]),
      ...(effort === undefined ? [] : ["--effort", effort]),
    ];

    const child = spawn(command, cliArgs, {
      cwd: request.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      if (outputMode === "stream") process.stderr.write(chunk);
    });

    try {
      await waitForSpawn(child);
      return await runSession(
        child,
        outputMode,
        report,
      );
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      const detail = stderr.trim();
      throw new Error(
        `agy Agent "${command}" failed in "${request.cwd}": ${message}${
          detail === "" ? "" : `\n${detail}`
        }`,
        { cause },
      );
    } finally {
      child.kill();
    }
  };
}

async function runSession(
  child: ChildProcessWithoutNullStreams,
  outputMode: "capture" | "stream",
  report: AgentReporter | undefined,
): Promise<Event> {
  const exited = new Promise<void>((resolve, reject) => {
    child.once("close", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(signal === null
        ? `Process exited with code ${code}`
        : `Process terminated by ${signal}`));
    });
    child.once("error", reject);
  });
  // Observe failures immediately, while stdout may still be draining.
  void exited.catch(() => {});
  const lines = createInterface({ input: child.stdout });
  let displayedOutput = "";
  let finalResponse: string | undefined;

  const emitOutput = (text: string) => {
    if (text === "") return;
    displayedOutput += text;
    report?.({ type: "output", text });
    if (outputMode === "stream") process.stdout.write(text);
  };

  try {
    for await (const line of lines) {
      const record = decodeRecord(line);
      if (record === undefined) continue;

      if (record.event === "result") {
        finalResponse = record.result.response;
      } else {
        const step = record.step_update;
        if (step.step_type === "agent_response") {
          emitOutput(step.text_delta);
        } else {
          const id = String(step.step_index ?? step.tool_name ?? "tool");
          const title = step.tool_name ?? step.tool_info?.name ?? "tool";
          const status = step.state === "ACTIVE"
            ? "in_progress"
            : (step.state === "DONE" ? "completed" : undefined);
          report?.({ type: "tool", id, title, ...(status === undefined ? {} : { status }) });
        }
      }
    }

    await exited;
    // The final response owns the outcome; earlier deltas may contain progress
    // or a preliminary event. Fall back only when no final response was sent.
    const response = finalResponse ?? displayedOutput;
    if (finalResponse !== undefined && !displayedOutput.endsWith(finalResponse)) {
      if (finalResponse.startsWith(displayedOutput)) {
        emitOutput(finalResponse.slice(displayedOutput.length));
      } else {
        const separator = displayedOutput !== "" && !displayedOutput.endsWith("\n") ? "\n" : "";
        emitOutput(separator + finalResponse);
      }
    }
    if (outputMode === "stream" && displayedOutput !== "" && !displayedOutput.endsWith("\n")) {
      process.stdout.write("\n");
    }
    return readAgentEvent(response, { adapter: "agy", includeMessage: outputMode === "capture" });
  } finally {
    lines.close();
  }
}

// Unknown events and malformed records are ignored at the transport boundary.
// Only these validated fields can reach the harness-neutral AgentUpdate API.
const recordSchema = v.variant("event", [
  v.object({
    event: v.literal("step_update"),
    step_update: v.variant("step_type", [
      v.object({ step_type: v.literal("agent_response"), text_delta: v.string() }),
      v.object({
        step_type: v.literal("tool"),
        step_index: v.nullish(v.union([v.string(), v.number()])),
        tool_name: v.nullish(v.string()),
        tool_info: v.nullish(v.object({ name: v.nullish(v.string()) })),
        state: v.nullish(v.string()),
      }),
    ]),
  }),
  v.object({
    event: v.literal("result"),
    result: v.object({ response: v.string() }),
  }),
]);

function decodeRecord(line: string): v.InferOutput<typeof recordSchema> | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  const result = v.safeParse(recordSchema, value);
  return result.success ? result.output : undefined;
}

function waitForSpawn(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
}
