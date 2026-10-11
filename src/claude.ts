import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import * as v from "valibot";

import { AgentLimitError, type AgentLimit } from "./agent-limit.ts";
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
  /**
   * Defaults to "limit": once the plan limit is used up and Claude Code starts
   * spending paid extra usage, the turn stops with an `AgentLimitError`.
   * "allow" lets the turn continue on extra usage.
   */
  readonly extraUsage?: "limit" | "allow";
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
      let result: { readonly failed: boolean; readonly text: string; readonly apiError?: ApiError } | undefined;
      // The CLI reports a limit beside its messages: on the last top-level
      // assistant record and in the latest rate-limit information.
      let assistantError: ApiError = {};
      let rateLimit: RateLimitInfo | undefined;
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
          } else if (record.type === "rate_limit_event") {
            const info = record.rate_limit_info;
            if (info?.isUsingOverage === true && options.extraUsage !== "allow") {
              // The plan limit is already used up; continuing would spend paid credits.
              throw new AgentLimitError(
                "Claude plan limit reached; extra usage is not used",
                agentLimit(harness, info),
              );
            }
            // Information without a recognised status does not replace what is known.
            if (info?.status !== undefined) rateLimit = info;
          } else if (record.type === "result") {
            result = {
              failed: record.is_error === true || record.subtype !== "success",
              text: record.result ?? record.errors?.join("\n") ?? record.subtype,
              ...(record.is_error === true
                ? { apiError: { name: record.api_error, rateLimited: record.api_error_status === 429 } }
                : {}),
            };
          } else if (record.parent_tool_use_id !== undefined && record.parent_tool_use_id !== null) {
            // Subagent activity belongs to the parent's tool call, not the final answer.
          } else if (record.type === "assistant") {
            assistantError = { name: record.api_error, rateLimited: record.error === "rate_limit" };
            const info = record.api_error_params?.rate_limit_info;
            if (info?.status !== undefined) rateLimit = info;
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
        // Only a final result that ended on an API error can be a limit. The latest
        // rate-limit information names it and its reset, whatever its own status.
        const limit = result?.apiError !== undefined
          && reachedLimit(result.apiError, assistantError, rateLimit, result.text)
          ? agentLimit(harness, rateLimit)
          : undefined;
        try {
          await exited;
        } catch (cause) {
          // An empty result adds nothing to the exit, but a limit it carries is still reported.
          if (result === undefined || (result.text === "" && limit === undefined)) throw cause;
          const message = cause instanceof Error ? cause.message : String(cause);
          throw turnFailure(result.text === "" ? message : `${message}: ${result.text}`, limit, { cause });
        }
        if (result === undefined) throw new Error("Claude exited without a final result");
        if (result.failed) throw turnFailure(result.text, limit);

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
      const text = `Claude Agent "${command}" failed in "${request.cwd}": ${message}${detail === "" ? "" : `\n${detail}`}`;
      throw cause instanceof AgentLimitError
        ? new AgentLimitError(text, cause.limit, { cause })
        : new Error(text, { cause });
    }
  };
}

interface ApiError {
  /** Claude Code's `api_error`, which names a plan limit. */
  readonly name?: string | undefined;
  /** Any 429, including a temporary throttle. */
  readonly rateLimited?: boolean;
}

type RateLimitInfo = v.InferOutput<typeof rateLimitInfoSchema>;

const planLimitErrors = new Set(["usage_limit_reached", "model_requires_usage_credits"]);
const limitText = /^(?:You've (?:hit|reached) your |You're out of (?:usage credits|extra usage))/u;
const maximumResetDelay = 8 * 24 * 60 * 60 * 1000;

// A 429 alone may be a temporary throttle; a plan limit also names itself, is
// rejected by the rate-limit information, or uses Claude Code's limit wording.
function reachedLimit(
  result: ApiError,
  assistant: ApiError,
  rateLimit: RateLimitInfo | undefined,
  text: string,
): boolean {
  if ([result.name, assistant.name].some((name) => name !== undefined && planLimitErrors.has(name))) return true;
  if (result.rateLimited !== true && assistant.rateLimited !== true) return false;
  return (rateLimit?.status === "rejected" && rateLimit.isUsingOverage !== true) || limitText.test(text);
}

function agentLimit(harness: string, info: RateLimitInfo | undefined): AgentLimit {
  const now = Date.now();
  const resetsAt = info?.resetsAt === undefined ? undefined : info.resetsAt * 1000;
  return {
    harness,
    ...(info?.rateLimitType === undefined ? {} : { kind: info.rateLimitType }),
    // A reset time that is past or implausibly distant is not reported.
    ...(resetsAt !== undefined && Number.isFinite(resetsAt) && resetsAt > now && resetsAt <= now + maximumResetDelay
      ? { resetsAt }
      : {}),
  };
}

function turnFailure(message: string, limit: AgentLimit | undefined, options?: ErrorOptions): Error {
  return limit === undefined ? new Error(message, options) : new AgentLimitError(message, limit, options);
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
// The limit fields were read from the Claude Code bundle, not observed at a real
// limit, so a malformed one is dropped without rejecting the record that carries it.
// A value outside the listed ones counts as malformed.
const tolerant = <const TSchema extends v.GenericSchema>(schema: TSchema) =>
  v.fallback(v.optional(schema), undefined);
const rateLimitInfoSchema = v.object({
  status: tolerant(v.picklist(["allowed", "allowed_warning", "rejected"])),
  // Whole Unix seconds.
  resetsAt: tolerant(v.pipe(v.number(), v.safeInteger())),
  rateLimitType: tolerant(v.picklist([
    "five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet", "seven_day_overage_included", "overage",
  ])),
  isUsingOverage: tolerant(v.boolean()),
});
const recordSchema = v.variant("type", [
  v.object({ type: v.literal("system"), subtype: v.literal("init"), model: v.string() }),
  v.object({ type: v.literal("rate_limit_event"), rate_limit_info: tolerant(rateLimitInfoSchema) }),
  v.object({
    type: v.literal("assistant"),
    parent_tool_use_id: parentSchema,
    message: v.object({ id: v.nullish(v.string()), content: v.array(assistantBlockSchema) }),
    error: tolerant(v.string()),
    api_error: tolerant(v.string()),
    api_error_params: tolerant(v.object({ rate_limit_info: tolerant(rateLimitInfoSchema) })),
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
    api_error: tolerant(v.string()),
    api_error_status: tolerant(v.number()),
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
