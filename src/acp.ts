import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";

import * as acp from "@agentclientprotocol/sdk";

import type {
  AgentReporter,
  AgentRequest,
  AgentRunner,
  AgentUpdate,
  Event,
} from "./index.ts";

export interface AcpAgentOptions {
  readonly env?: Readonly<Record<string, string>>;
  readonly harness?: string;
  readonly output?: "capture" | "stream";
}

export function acpAgent(
  command: string,
  args: readonly string[] = [],
  options: AcpAgentOptions = {},
): AgentRunner {
  return async (request, report) => {
    if (request.cwd === undefined) {
      throw new Error("ACP Agent requires a working directory");
    }

    if (request.outcomes.length === 0) {
      throw new Error("ACP Agent requires at least one allowed outcome");
    }

    const harness = options.harness ?? command;
    report?.({ type: "identity", harness });

    const child = spawn(command, [...args], {
      cwd: request.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      process.stderr.write(chunk);
    });

    try {
      await waitForSpawn(child);
      return await runSession(
        child,
        { ...request, cwd: request.cwd },
        options.output ?? "stream",
        report,
        harness,
      );
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      const detail = stderr.trim();
      throw new Error(
        `ACP Agent "${command}" failed in "${request.cwd}": ${message}${
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
  request: AgentRequest & { readonly cwd: string },
  outputMode: "capture" | "stream",
  report: AgentReporter | undefined,
  harness: string,
): Promise<Event> {
  const stream = acp.ndJsonStream(
    Writable.toWeb(child.stdin),
    Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
  );
  let output = "";
  let permissionError: Error | undefined;

  return acp
    .client({ name: "machines" })
    .onNotification(acp.methods.client.session.update, ({ params }) => {
      const update = params.update;
      if (
        update.sessionUpdate === "agent_message_chunk"
        && update.content.type === "text"
      ) {
        output += update.content.text;
        report?.({ type: "output", text: update.content.text });
        if (outputMode === "stream") process.stdout.write(update.content.text);
      } else if (update.sessionUpdate === "tool_call") {
        report?.({
          type: "tool",
          id: update.toolCallId,
          title: update.title,
          ...(update.status === undefined || update.status === null
            ? {}
            : { status: update.status }),
        });
      } else if (update.sessionUpdate === "tool_call_update") {
        report?.({
          type: "tool",
          id: update.toolCallId,
          ...(update.title === undefined || update.title === null
            ? {}
            : { title: update.title }),
          ...(update.status === undefined || update.status === null
            ? {}
            : { status: update.status }),
        });
      } else if (update.sessionUpdate === "config_option_update") {
        const identity = identityUpdate(update.configOptions, harness);
        if (identity !== undefined) report?.(identity);
      }
    })
    .onRequest(acp.methods.client.session.requestPermission, ({ params }) => {
      const title = params.toolCall.title ?? params.toolCall.toolCallId;
      permissionError = new Error(
        `ACP Agent requested permission for "${title}", but permission input is not implemented yet`,
      );
      const rejection = params.options.find((option) => option.kind === "reject_once")
        ?? params.options.find((option) => option.kind === "reject_always");
      return rejection === undefined
        ? { outcome: { outcome: "cancelled" } }
        : { outcome: { outcome: "selected", optionId: rejection.optionId } };
    })
    .connectWith(stream, async (connection) => {
      await connection.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });

      const session = await connection.request(acp.methods.agent.session.new, {
        cwd: request.cwd,
        mcpServers: [],
      });
      const identity = identityUpdate(session.configOptions, harness);
      if (identity !== undefined) report?.(identity);
      const result = await connection.request(acp.methods.agent.session.prompt, {
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: agentPrompt(request) }],
      });

      if (outputMode === "stream" && output !== "" && !output.endsWith("\n")) {
        process.stdout.write("\n");
      }
      if (permissionError !== undefined) throw permissionError;
      if (result.stopReason !== "end_turn") {
        throw new Error(`ACP Agent stopped with "${result.stopReason}"`);
      }

      return returnedEvent(output, outputMode === "capture");
    });
}

function identityUpdate(
  options: readonly acp.SessionConfigOption[] | null | undefined,
  harness: string,
): AgentUpdate | undefined {
  let model: string | undefined;
  let thinking: string | undefined;

  for (const option of options ?? []) {
    if (option.type !== "select") continue;
    if (option.category === "model" || option.id === "model") {
      model = option.currentValue;
    } else if (option.category === "thought_level" || option.id === "thought_level") {
      thinking = option.currentValue;
    }
  }

  return model === undefined && thinking === undefined
    ? undefined
    : {
      type: "identity",
      harness,
      ...(model === undefined ? {} : { model }),
      ...(thinking === undefined ? {} : { thinking }),
    };
}

function agentPrompt(request: AgentRequest): string {
  return [
    request.prompt,
    "",
    "Complete the work using the available tools.",
    `Allowed outcome types: ${request.outcomes.join(", ")}.`,
    "When finished, end your final response with exactly one line in this form:",
    'MACHINES_EVENT {"type":"completed"}',
    "Replace completed with exactly one allowed outcome type.",
    "Include additional JSON fields only when the task asks for them.",
  ].join("\n");
}

function returnedEvent(output: string, includeMessage: boolean): Event {
  const matches = [...output.matchAll(/^MACHINES_EVENT (.+)$/gmu)];
  const encoded = matches.at(-1)?.[1];
  if (encoded === undefined) {
    throw new Error("ACP Agent finished without returning a Machines event");
  }

  let event: unknown;
  try {
    event = JSON.parse(encoded);
  } catch (cause) {
    throw new Error("ACP Agent returned invalid event JSON", { cause });
  }

  if (
    event === null
    || typeof event !== "object"
    || !("type" in event)
    || typeof event.type !== "string"
  ) {
    throw new Error("ACP Agent returned an invalid Machines event");
  }

  const result = event as Event;
  const message = output
    .replace(/^MACHINES_EVENT .+$(?:\r?\n)?/gmu, "")
    .trim();

  return includeMessage && message !== ""
    ? { ...result, message }
    : result;
}

function waitForSpawn(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
}
