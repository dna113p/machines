import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import * as v from "valibot";

import { agentPrompt, readAgentEvent } from "./agent-protocol.ts";
import type { AgentRunner } from "./index.ts";

export interface ClaudeAgentOptions {
  readonly env?: Readonly<Record<string, string>>;
  readonly harness?: string;
  /** A Claude Code model alias (for example "opus", "sonnet", "haiku") or a full model name. */
  readonly model?: string;
  /** An effort level supported by the installed Claude Code and selected model. */
  readonly effort?: string;
  /**
   * Defaults to "dontAsk": tools run only when Claude Code's own permission
   * rules already allow them, and anything that would prompt is denied.
   */
  readonly permissionMode?: "acceptEdits" | "auto" | "bypassPermissions" | "dontAsk" | "manual" | "plan";
  /** Restricts the built-in tool set, for example ["Read"]. */
  readonly tools?: readonly string[];
  /** Permission rules to allow in addition to Claude Code's settings, for example ["Bash(npm test)"]. */
  readonly allowedTools?: readonly string[];
  /** Tools or permission rules to deny regardless of Claude Code's settings. */
  readonly disallowedTools?: readonly string[];
  /** Defaults to false, so each invocation does not save a resumable Claude Code session. */
  readonly sessionPersistence?: boolean;
  readonly output?: "capture" | "stream";
}

/**
 * Runs one fresh, non-interactive Claude Code turn using the installed CLI and
 * its existing login. Authentication, settings, and permission rules stay in
 * Claude Code; this runner never reads or forwards credentials.
 */
export function claudeAgent(
  command = "claude",
  args: readonly string[] = [],
  options: ClaudeAgentOptions = {},
): AgentRunner {
  return async (request, report) => {
    if (request.cwd === undefined) throw new Error("Claude Agent requires a working directory");
    if (request.outcomes.length === 0) throw new Error("Claude Agent requires at least one allowed outcome");

    const harness = options.harness ?? command;
    const env = { ...process.env, ...options.env };
    // Claude Code exports its own CLAUDE_* variables (including CLAUDE_EFFORT) to
    // child processes, so runner settings use names it does not own.
    const model = options.model ?? env.MACHINES_CLAUDE_MODEL ?? env.MACHINES_AGENT_MODEL;
    const effort = options.effort ?? env.MACHINES_CLAUDE_EFFORT ?? env.MACHINES_AGENT_EFFORT;
    const outputMode = options.output ?? "stream";
    report?.({
      type: "identity",
      harness,
      ...(model === undefined ? {} : { model }),
      ...(effort === undefined ? {} : { thinking: effort }),
    });

    let stderr = "";
    try {
      const child = spawn(command, [
        ...args,
        "--print", "--output-format", "stream-json", "--verbose",
        "--permission-mode", options.permissionMode ?? "dontAsk",
        ...(options.sessionPersistence === true ? [] : ["--no-session-persistence"]),
        ...(model === undefined ? [] : ["--model", model]),
        ...(effort === undefined ? [] : ["--effort", effort]),
        ...(options.tools === undefined ? [] : ["--tools", options.tools.join(",")]),
        ...(options.allowedTools === undefined ? [] : ["--allowed-tools", options.allowedTools.join(",")]),
        ...(options.disallowedTools === undefined ? [] : ["--disallowed-tools", options.disallowedTools.join(",")]),
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
      const toolTitles = new Map<string, string>();
      let result: { readonly failed: boolean; readonly text: string } | undefined;
      // The CLI streams one record per content block, and its final result
      // joins the text blocks of the closing message.
      let closingMessage: string | undefined;
      let closingText = "";
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
          if (record.type === "malformed-result") {
            // An unreadable final result must not leave an earlier one in effect.
            result = { failed: true, text: "Claude returned a malformed final result" };
          } else if (record.type === "system") {
            // The CLI resolves aliases and defaults; report what actually runs.
            report?.({
              type: "identity",
              harness,
              model: record.model,
              ...(effort === undefined ? {} : { thinking: effort }),
            });
          } else if (record.type === "result") {
            result = {
              failed: record.is_error === true || record.subtype !== "success",
              text: record.result ?? record.errors?.join("\n") ?? record.subtype,
            };
          } else if (record.parent_tool_use_id !== undefined && record.parent_tool_use_id !== null) {
            // Subagent activity belongs to the parent's tool call, not the final answer.
          } else if (record.type === "assistant") {
            const message = record.message.id ?? undefined;
            if (message === undefined || message !== closingMessage) closingText = "";
            closingMessage = message;
            for (const block of record.message.content) {
              if (block.type === "text") {
                closingText += block.text;
                emitMessage(block.text);
              } else if (block.type === "tool_use") {
                toolTitles.set(block.id, block.name);
                report?.({ type: "tool", id: block.id, title: block.name, status: "in_progress" });
              }
            }
          } else if (typeof record.message.content !== "string") {
            for (const block of record.message.content) {
              if (block.type !== "tool_result") continue;
              const title = toolTitles.get(block.tool_use_id);
              report?.({
                type: "tool",
                id: block.tool_use_id,
                ...(title === undefined ? {} : { title }),
                status: block.is_error === true ? "failed" : "completed",
              });
            }
          }
        }
        try {
          await exited;
        } catch (cause) {
          if (result === undefined || result.text === "") throw cause;
          const message = cause instanceof Error ? cause.message : String(cause);
          throw new Error(`${message}: ${result.text}`, { cause });
        }
        if (result === undefined) throw new Error("Claude exited without a final result");
        if (result.failed) throw new Error(result.text);

        // Earlier messages may contain progress or a preliminary event. Only the
        // CLI's final result determines the outcome, never accumulated activity.
        if (withoutSpace(result.text) !== withoutSpace(closingText)) emitMessage(result.text);
        return readAgentEvent(result.text, { adapter: "Claude", includeMessage: outputMode === "capture" });
      } finally {
        lines.close();
        child.kill();
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      const detail = stderr.trim();
      throw new Error(
        `Claude Agent "${command}" failed in "${request.cwd}": ${message}${detail === "" ? "" : `\n${detail}`}`,
        { cause },
      );
    }
  };
}

const parentSchema = v.nullish(v.string());
// Unlisted block types (thinking, images, future additions) are skipped, not rejected.
const otherBlockSchema = v.pipe(v.object({ type: v.string() }), v.transform(() => ({ type: "other" as const })));
const assistantBlockSchema = v.union([
  v.object({ type: v.literal("text"), text: v.string() }),
  v.object({ type: v.literal("tool_use"), id: v.string(), name: v.string() }),
  otherBlockSchema,
]);
const userBlockSchema = v.union([
  v.object({ type: v.literal("tool_result"), tool_use_id: v.string(), is_error: v.nullish(v.boolean()) }),
  otherBlockSchema,
]);
const recordSchema = v.variant("type", [
  v.object({ type: v.literal("system"), subtype: v.literal("init"), model: v.string() }),
  v.object({
    type: v.literal("assistant"),
    parent_tool_use_id: parentSchema,
    message: v.object({ id: v.nullish(v.string()), content: v.array(assistantBlockSchema) }),
  }),
  v.object({
    type: v.literal("user"),
    parent_tool_use_id: parentSchema,
    message: v.object({ content: v.union([v.string(), v.array(userBlockSchema)]) }),
  }),
  v.object({
    type: v.literal("result"),
    subtype: v.string(),
    is_error: v.nullish(v.boolean()),
    result: v.nullish(v.string()),
    errors: v.nullish(v.array(v.string())),
  }),
]);

// Ignore unsupported events and malformed records without exposing raw protocol data.
function decodeRecord(
  line: string,
): v.InferOutput<typeof recordSchema> | { readonly type: "malformed-result" } | undefined {
  let value: unknown;
  try { value = JSON.parse(line); } catch { return undefined; }
  const parsed = v.safeParse(recordSchema, value);
  if (parsed.success) return parsed.output;
  return value !== null && typeof value === "object" && "type" in value && value.type === "result"
    ? { type: "malformed-result" }
    : undefined;
}

// Block boundaries differ between streamed messages and the joined result.
function withoutSpace(text: string): string {
  return text.replace(/\s+/gu, "");
}
