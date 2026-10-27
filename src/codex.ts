import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import * as v from "valibot";

import { AgentLimitError } from "./agent-limit.ts";
import { agentPrompt, readAgentEvent } from "./agent-protocol.ts";
import { withAgentTuning, tuningChoices } from "./agent-tuning.ts";
import type { AgentRunner } from "./index.ts";

export interface CodexAgentOptions {
  readonly env?: Readonly<Record<string, string>>;
  readonly harness?: string;
  readonly model?: string;
  /** A reasoning effort supported by the selected Codex model. */
  readonly effort?: string;
  /** Codex service tier, e.g. "fast" or "ultrafast"; omitted values inherit the CLI configuration. */
  readonly serviceTier?: string;
  /** Defaults to read-only; writes and unrestricted access require an explicit choice. */
  readonly sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  readonly skipGitRepoCheck?: boolean;
  /**
   * Unset, an invocation persists its Codex session only when its Agent state
   * names a session. `true` never persists one, so such a state always starts
   * fresh; `false` always persists one.
   */
  readonly ephemeral?: boolean;
  readonly output?: "capture" | "stream";
}

/**
 * Runs one non-interactive Codex turn using the installed CLI and its
 * authentication: fresh, or continuing a session an earlier call kept.
 */
export function codexAgent(
  command = "codex",
  args: readonly string[] = [],
  options: CodexAgentOptions = {},
): AgentRunner {
  return createCodexAgent(command, [...args], { ...options, ...(options.env === undefined ? {} : { env: { ...options.env } }) });
}

function createCodexAgent(command: string, args: readonly string[], options: CodexAgentOptions, environment?: NodeJS.ProcessEnv): AgentRunner {
  const runner: AgentRunner = async (request, report) => {
    if (request.cwd === undefined) throw new Error("Codex Agent requires a working directory");
    if (request.outcomes.length === 0) throw new Error("Codex Agent requires at least one allowed outcome");

    const harness = options.harness ?? command;
    const env = environment ?? { ...process.env, ...options.env };
    const model = options.model ?? env.CODEX_MODEL ?? env.MACHINES_AGENT_MODEL;
    const effort = options.effort ?? env.CODEX_EFFORT ?? env.MACHINES_AGENT_EFFORT;
    const serviceTier = options.serviceTier ?? env.CODEX_SERVICE_TIER;
    const outputMode = options.output ?? "stream";
    report?.({
      type: "identity",
      harness,
      ...(model === undefined ? {} : { model }),
      ...(effort === undefined ? {} : { thinking: effort }),
    });

    const keep = request.session !== undefined && options.ephemeral !== true;
    const resume = keep ? request.session?.resume : undefined;
    if (resume !== undefined) {
      try {
        return await turn({ resume: resume.id, prompt: resume.prompt });
      } catch (cause) {
        if (!(cause instanceof SessionUnavailable)) throw cause;
        // Nothing ran: the full prompt starts a new session.
        return turn({ prompt: request.prompt, reason: `session ${resume.id} could not be resumed: ${cause.message}` });
      }
    }
    return turn({ prompt: request.prompt });

    async function turn(session: { readonly resume?: string; readonly prompt: string; readonly reason?: string }) {
      const temporary = await mkdtemp(join(tmpdir(), "machines-codex-result-"));
      const finalPath = join(temporary, "response.txt");
      let started = false;
      let stderr = "";
      try {
        // Execution options belong to `exec`; `resume` only names the session.
        const child = spawn(command, [
          ...args,
          "exec", "--json", "--color", "never",
          "--sandbox", options.sandbox ?? "read-only",
          "--config", 'approval_policy="never"',
          ...(options.skipGitRepoCheck === true ? ["--skip-git-repo-check"] : []),
          ...(keep || options.ephemeral === false ? [] : ["--ephemeral"]),
          ...(model === undefined ? [] : ["--model", model]),
          ...(effort === undefined ? [] : ["--config", `model_reasoning_effort=${JSON.stringify(effort)}`]),
          ...(serviceTier === undefined ? [] : ["--config", `service_tier=${JSON.stringify(serviceTier)}`]),
          "--output-last-message", finalPath,
          ...(session.resume === undefined ? [] : ["resume", session.resume]),
          "-",
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
          child.stdin.end(agentPrompt({ ...request, prompt: session.prompt }));
          for await (const line of lines) {
            const record = decodeRecord(line);
            if (record === undefined) continue;
            if (record.type === "thread.started") {
              if (keep && !started) {
                report?.({ type: "session", status: session.resume === undefined ? "fresh" : "continued", id: record.thread_id,
                  ...(session.reason === undefined ? {} : { reason: session.reason }) });
              }
              started = true;
            } else if (record.type === "turn.completed") completed = true;
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
          // Codex states a usage limit only in the text of a failed turn.
          const detail = failure ?? lastError;
          if (session.resume !== undefined && !started && !(detail !== undefined && usageLimitText.test(detail))
            && await exited.then(() => !completed, () => true)) {
            // Codex refuses a session it cannot find before it starts a thread.
            throw new SessionUnavailable(detail ?? (stderr.trim().split("\n").at(-1) || "Codex did not start the turn"));
          }
          const turnFailure = (message: string, cause?: ErrorOptions) =>
            detail !== undefined && usageLimitText.test(detail)
              ? new AgentLimitError(message, { harness, kind: "usage" }, cause)
              : new Error(message, cause);
          try {
            await exited;
          } catch (cause) {
            if (detail === undefined) throw cause;
            const message = cause instanceof Error ? cause.message : String(cause);
            throw turnFailure(`${message}: ${detail}`, { cause });
          }
          if (failure !== undefined) throw turnFailure(failure);
          if (!completed) throw turnFailure(lastError ?? "Codex exited without completing its turn");

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
        if (cause instanceof SessionUnavailable) throw cause;
        const message = cause instanceof Error ? cause.message : String(cause);
        const detail = stderr.trim();
        const text = `Codex Agent "${command}" failed in "${request.cwd}": ${message}${detail === "" ? "" : `\n${detail}`}`;
        throw cause instanceof AgentLimitError
          ? new AgentLimitError(text, cause.limit, { cause })
          : new Error(text, { cause });
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    }
  };
  return withAgentTuning(runner, { configure(tuning) {
    const values = tuningChoices(tuning.options, {
      effort: ["none", "minimal", "low", "medium", "high", "xhigh"],
      serviceTier: ["fast", "ultrafast"],
    }, "Codex");
    const env = environment ?? { ...process.env, ...options.env };
    const model = tuning.model ?? options.model ?? env.CODEX_MODEL ?? env.MACHINES_AGENT_MODEL;
    const effort = values.effort ?? options.effort ?? env.CODEX_EFFORT ?? env.MACHINES_AGENT_EFFORT;
    const serviceTier = values.serviceTier ?? options.serviceTier ?? env.CODEX_SERVICE_TIER;
    return {
      runner: createCodexAgent(command, [...args], { ...options,
        ...(model === undefined ? {} : { model }),
        ...(effort === undefined ? {} : { effort }),
        ...(serviceTier === undefined ? {} : { serviceTier }),
      }, { ...env }),
      ...(model === undefined ? {} : { model }),
      ...(effort === undefined ? {} : { thinking: effort }),
    };
  } });
}

/** A resumed session that never started its thread, so the call can run fresh. */
class SessionUnavailable extends Error {}

// Codex 0.162.1 writes the first of these with a typographic apostrophe (U+2019).
const usageLimitText = /^(?:You['’]ve hit your usage limit|Your workspace is out of credits|You hit your spend cap)/u;

const statusSchema = v.optional(v.picklist(["in_progress", "completed", "failed", "declined"]));
const itemSchema = v.variant("type", [
  v.object({ type: v.literal("agent_message"), id: v.string(), text: v.string() }),
  v.object({ type: v.literal("command_execution"), id: v.string(), command: v.string(), status: statusSchema }),
  v.object({ type: v.literal("file_change"), id: v.string(), status: statusSchema }),
  v.object({ type: v.literal("mcp_tool_call"), id: v.string(), server: v.string(), tool: v.string(), status: statusSchema }),
  v.object({ type: v.literal("web_search"), id: v.string(), query: v.string(), status: statusSchema }),
]);
const recordSchema = v.variant("type", [
  v.object({ type: v.literal("thread.started"), thread_id: v.string() }),
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
