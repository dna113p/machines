import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import * as v from "valibot";

import { agentPrompt, readAgentEvent } from "./agent-protocol.ts";
import type { AgentRunner } from "./index.ts";

export interface CodexAgentOptions {
  readonly env?: Readonly<Record<string, string>>;
  readonly harness?: string;
  readonly model?: string;
  /** A reasoning effort supported by the selected Codex model. */
  readonly effort?: string;
  /** Defaults to read-only; writes and unrestricted access require an explicit choice. */
  readonly sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  readonly skipGitRepoCheck?: boolean;
  /** Defaults to true, so each invocation does not persist a Codex session. */
  readonly ephemeral?: boolean;
  readonly output?: "capture" | "stream";
}

/** Runs one fresh, non-interactive Codex turn using the installed CLI and its authentication. */
export function codexAgent(
  command = "codex",
  args: readonly string[] = [],
  options: CodexAgentOptions = {},
): AgentRunner {
  return async (request, report) => {
    if (request.cwd === undefined) throw new Error("Codex Agent requires a working directory");
    if (request.outcomes.length === 0) throw new Error("Codex Agent requires at least one allowed outcome");

    const env = { ...process.env, ...options.env };
    const model = options.model ?? env.CODEX_MODEL ?? env.MACHINES_AGENT_MODEL;
    const effort = options.effort ?? env.CODEX_EFFORT ?? env.MACHINES_AGENT_EFFORT;
    const outputMode = options.output ?? "stream";
    report?.({
      type: "identity",
      harness: options.harness ?? command,
      ...(model === undefined ? {} : { model }),
      ...(effort === undefined ? {} : { thinking: effort }),
    });

    const temporary = await mkdtemp(join(tmpdir(), "machines-codex-result-"));
    const finalPath = join(temporary, "response.txt");
    let stderr = "";
    try {
      const child = spawn(command, [
        ...args,
        "exec", "--json", "--color", "never",
        "--sandbox", options.sandbox ?? "read-only",
        "--config", 'approval_policy="never"',
        ...(options.skipGitRepoCheck === true ? ["--skip-git-repo-check"] : []),
        ...(options.ephemeral === false ? [] : ["--ephemeral"]),
        ...(model === undefined ? [] : ["--model", model]),
        ...(effort === undefined ? [] : ["--config", `model_reasoning_effort=${JSON.stringify(effort)}`]),
        "--output-last-message", finalPath, "-",
      ], { cwd: request.cwd, env, stdio: ["pipe", "pipe", "pipe"] });

      const exited = new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.stdin.once("error", reject);
        child.once("close", (code, signal) => {
          if (code === 0) resolve();
          else reject(new Error(signal === null
            ? `Process exited with code ${code}`
            : `Process terminated by ${signal}`));
        });
      });
      // Attach handlers before reading stdout: errors can arrive while it drains.
      void exited.catch(() => {});
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
        if (outputMode === "stream") process.stderr.write(chunk);
      });
      const lines = createInterface({ input: child.stdout });
      let completed = false;
      let failure: string | undefined;
      let lastError: string | undefined;
      let lastMessage: string | undefined;
      const emitMessage = (text: string) => {
        if (text === "") return;
        report?.({ type: "output", text: `${text}${text.endsWith("\n") ? "" : "\n"}` });
        if (outputMode === "stream") process.stdout.write(`${text}${text.endsWith("\n") ? "" : "\n"}`);
      };

      try {
        child.stdin.end(agentPrompt(request));
        for await (const line of lines) {
          const record = decodeRecord(line);
          if (record === undefined) continue;
          if (record.type === "turn.completed") completed = true;
          else if (record.type === "turn.failed") failure = record.error.message;
          else if (record.type === "error") lastError = record.message;
          else {
            const item = record.item;
            if (item.type === "agent_message") {
              if (record.type === "item.completed") {
                lastMessage = item.text;
                emitMessage(item.text);
              }
            } else {
              const title = item.type === "command_execution" ? item.command
                : item.type === "mcp_tool_call" ? `${item.server}/${item.tool}`
                : item.type === "web_search" ? item.query : "File changes";
              const status = item.status === "failed" || item.status === "declined" ? "failed"
                : record.type === "item.completed" ? "completed" : "in_progress";
              report?.({ type: "tool", id: item.id, title, status });
            }
          }
        }
        try {
          await exited;
        } catch (cause) {
          const detail = failure ?? lastError;
          if (detail === undefined) throw cause;
          const message = cause instanceof Error ? cause.message : String(cause);
          throw new Error(`${message}: ${detail}`, { cause });
        }
        if (failure !== undefined) throw new Error(failure);
        if (!completed) throw new Error(lastError ?? "Codex exited without completing its turn");

        // A progress message may contain a preliminary event. Only the CLI's
        // final-response file determines the outcome, never accumulated activity.
        const response = await readFile(finalPath, "utf8");
        if (response.trimEnd() !== lastMessage?.trimEnd()) emitMessage(response);
        return readAgentEvent(response, { adapter: "Codex", includeMessage: outputMode === "capture" });
      } finally {
        lines.close();
        child.kill();
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      const detail = stderr.trim();
      throw new Error(
        `Codex Agent "${command}" failed in "${request.cwd}": ${message}${detail === "" ? "" : `\n${detail}`}`,
        { cause },
      );
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  };
}

const statusSchema = v.optional(v.picklist(["in_progress", "completed", "failed", "declined"]));
const itemSchema = v.variant("type", [
  v.object({ type: v.literal("agent_message"), id: v.string(), text: v.string() }),
  v.object({ type: v.literal("command_execution"), id: v.string(), command: v.string(), status: statusSchema }),
  v.object({ type: v.literal("file_change"), id: v.string(), status: statusSchema }),
  v.object({ type: v.literal("mcp_tool_call"), id: v.string(), server: v.string(), tool: v.string(), status: statusSchema }),
  v.object({ type: v.literal("web_search"), id: v.string(), query: v.string(), status: statusSchema }),
]);
const recordSchema = v.variant("type", [
  v.object({ type: v.literal("item.started"), item: itemSchema }),
  v.object({ type: v.literal("item.updated"), item: itemSchema }),
  v.object({ type: v.literal("item.completed"), item: itemSchema }),
  v.object({ type: v.literal("turn.completed") }),
  v.object({ type: v.literal("turn.failed"), error: v.object({ message: v.string() }) }),
  v.object({ type: v.literal("error"), message: v.string() }),
]);

// Ignore unsupported events and malformed records without exposing raw protocol data.
function decodeRecord(line: string): v.InferOutput<typeof recordSchema> | undefined {
  let value: unknown;
  try { value = JSON.parse(line); } catch { return undefined; }
  const result = v.safeParse(recordSchema, value);
  return result.success ? result.output : undefined;
}
