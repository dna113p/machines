#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import * as v from "valibot";
import type { StateValue } from "xstate";

import { MachineSession as RunSession, type RunSnapshot } from "../src/session.ts";
export type { RunSnapshot } from "../src/session.ts";
import { listAgentPresets, listMachines } from "../src/launcher.ts";

const widgetUri = "ui://machines/run-v1.html";
const cwd = v.pipe(
  v.string(),
  v.nonEmpty("cwd must be a non-empty absolute path"),
  v.check(isAbsolute, "cwd must be an absolute path"),
);
const listInput = v.strictObject({ cwd });
const startInput = v.strictObject({
  cwd,
  machine: v.pipe(v.string(), v.nonEmpty("machine must not be empty")),
  input: v.optional(v.string()),
  agents: v.optional(v.record(
    v.pipe(v.string(), v.nonEmpty("Agent role names must not be empty")),
    v.pipe(v.string(), v.nonEmpty("Agent preset names must not be empty")),
  )),
});
const statusInput = v.strictObject({
  runId: v.optional(v.pipe(v.string(), v.nonEmpty("runId must not be empty"))),
});
const respondInput = v.strictObject({
  requestId: v.pipe(v.string(), v.nonEmpty("requestId must not be empty")),
  runId: v.pipe(v.string(), v.nonEmpty("runId must not be empty")),
  response: v.string(),
});

const locationInputSchema = {
  type: "object",
  properties: {
    cwd: {
      type: "string",
      description: "Absolute path to the current Codex project",
    },
  },
  required: ["cwd"],
  additionalProperties: false,
} as const;

const tools = [
  {
    name: "machine_list",
    title: "List Machines",
    description: "List Machines available to the current project, why to use them, and any missing Agent bindings.",
    inputSchema: locationInputSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  {
    name: "machine_agents",
    title: "List Machine Agents",
    description: "List configured Agent presets before overriding a Machine's semantic Agent role.",
    inputSchema: locationInputSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  {
    name: "machine_start",
    title: "Start Machine",
    description: "Start one discovered Machine asynchronously. Preserve the user's requested scope and use only Agent presets returned by machine_agents.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: {
          type: "string",
          description: "Absolute path to the current Codex project",
        },
        machine: {
          type: "string",
          description: "Exact Machine name returned by machine_list",
        },
        input: {
          type: "string",
          description: "Clear task or input for the Machine",
        },
        agents: {
          type: "object",
          description: "Optional Machine role to configured Agent preset name",
          additionalProperties: { type: "string" },
        },
      },
      required: ["cwd", "machine"],
      additionalProperties: false,
    },
    _meta: {
      ui: { resourceUri: widgetUri },
      "openai/outputTemplate": widgetUri,
      "openai/toolInvocation/invoking": "Starting Machine…",
      "openai/toolInvocation/invoked": "Machine started.",
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  {
    name: "machine_status",
    title: "Machine Status",
    description: "Read one exact Machine run, or all runs owned by this Codex session.",
    inputSchema: {
      type: "object",
      properties: {
        runId: {
          type: "string",
          description: "Exact run id returned by machine_start; omit to list this session's runs",
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "machine_respond",
    title: "Respond to Machine",
    description: "Send Human input directly to one waiting Machine. Use an exact allowed choice when choices are present.",
    inputSchema: {
      type: "object",
      properties: {
        runId: {
          type: "string",
          description: "Exact run id returned by machine_start",
        },
        requestId: {
          type: "string",
          description: "Exact human.requestId from the current waiting run snapshot",
        },
        response: {
          type: "string",
          description: "Human response, or an exact allowed choice",
        },
      },
      required: ["runId", "requestId", "response"],
      additionalProperties: false,
    },
    _meta: {
      "openai/toolInvocation/invoking": "Responding…",
      "openai/toolInvocation/invoked": "Response sent.",
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
] as const;

export class MachineSession {
  readonly #session = new RunSession();

  async list(input: unknown): Promise<CallToolResult> {
    const { cwd } = parse(listInput, input);
    const machines = await listMachines({ cwd });
    const text = machines.length === 0
      ? "No Machines found."
      : machines.map((machine) => {
        const roles = Object.keys(machine.agentRoles);
        const ready = machine.error !== undefined
          ? `invalid: ${machine.error}`
          : machine.missingAgents.length === 0
          ? "ready"
          : `missing: ${machine.missingAgents.join(", ")}`;
        return `${machine.name} — ${machine.description}\n  ${roles.length === 0 ? "no Agent roles" : `roles: ${roles.join(", ")}`} · ${ready}\n  ${machine.path}`;
      }).join("\n\n");
    return result(text, { machines });
  }

  async agents(input: unknown): Promise<CallToolResult> {
    const { cwd } = parse(listInput, input);
    const agents = await listAgentPresets({ cwd });
    const text = agents.length === 0
      ? "No Agent presets configured."
      : agents.map((agent) => {
        const identity = [agent.harness, agent.model, agent.thinking]
          .filter((part) => part !== undefined)
          .join(" · ");
        return `${agent.name} — ${agent.description}${identity === "" ? "" : ` (${identity})`}\n  ${agent.source}`;
      }).join("\n\n");
    return result(text, { agents });
  }

  async start(input: unknown): Promise<CallToolResult> {
    const run = await this.#session.start(parse(startInput, input));
    return result(`Started ${run.machine}.\nRun id: ${run.id}\nStatus: ${run.status}`, { run });
  }

  status(input: unknown): CallToolResult {
    const { runId } = parse(statusInput, input);
    const runs = this.#session.status(runId);
    return result(
      runs.length === 0 ? "No Machine runs in this Codex session." : runs.map(formatSnapshot).join("\n\n"),
      { runs },
    );
  }

  async respond(input: unknown): Promise<CallToolResult> {
    const run = await this.#session.respond(parse(respondInput, input));
    return result(`Sent response to ${run.machine}.\nRun id: ${run.id}\nStatus: ${run.status}`, { run });
  }

  close(): void {
    this.#session.close();
  }
}

export function createMachinesMcpServer(
  widgetHtml = readFileSync(new URL("../codex/machines/ui/machines.html", import.meta.url), "utf8"),
): { readonly server: Server; readonly session: MachineSession } {
  const session = new MachineSession();
  const server = new Server(
    { name: "machines", version: "0.1.0" },
    {
      capabilities: { tools: {}, resources: {} },
      instructions: [
        "Use machine_list when the user names a Machine or a reusable multi-step workflow may fit.",
        "Choose by description rather than guessing a Machine name.",
        "machine_start is asynchronous; continue the conversation while it runs.",
        "Use machine_status for authoritative progress and machine_respond only after the Human's answer is clear.",
        "If no Machine fits a one-off task, handle it normally. Ask before creating persistent Machine policy.",
      ].join(" "),
    },
  );

  server.onclose = () => session.close();

  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [...tools] }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const input = request.params.arguments ?? {};
      switch (request.params.name) {
        case "machine_list": return await session.list(input);
        case "machine_agents": return await session.agents(input);
        case "machine_start": return await session.start(input);
        case "machine_status": return session.status(input);
        case "machine_respond": return await session.respond(input);
        default: throw new Error(`Unknown tool "${request.params.name}"`);
      }
    } catch (cause) {
      return {
        isError: true,
        content: [{ type: "text", text: errorMessage(cause) }],
      };
    }
  });
  server.setRequestHandler(ListResourcesRequestSchema, () => ({
    resources: [{
      name: "Machine run status",
      uri: widgetUri,
      mimeType: "text/html;profile=mcp-app",
      description: "Live status and direct Human input for one Machine run",
    }],
  }));
  server.setRequestHandler(ReadResourceRequestSchema, (request) => {
    if (request.params.uri !== widgetUri) {
      throw new Error(`Unknown resource "${request.params.uri}"`);
    }
    return {
      contents: [{
        uri: widgetUri,
        mimeType: "text/html;profile=mcp-app",
        text: widgetHtml,
        _meta: { ui: { prefersBorder: true, csp: {} } },
      }],
    };
  });

  return { server, session };
}

function parse<TSchema extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>>(
  schema: TSchema,
  input: unknown,
): v.InferOutput<TSchema> {
  const parsed = v.safeParse(schema, input);
  if (parsed.success) return parsed.output;
  const details = parsed.issues.map((issue) => {
    const path = issue.path?.map((item) => String(item.key)).join(".");
    return path === undefined || path === "" ? issue.message : `${path}: ${issue.message}`;
  });
  throw new Error(`Invalid Machine tool input: ${details.join("; ")}`);
}

function result(text: string, structuredContent: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text }], structuredContent };
}

function formatSnapshot(run: RunSnapshot): string {
  const lines = [
    `${run.machine} (${run.status})`,
    `Run id: ${run.id}`,
    `State: ${formatState(run.state) ?? "starting"}`,
    `Elapsed: ${run.elapsedSeconds}s`,
  ];
  if (run.agent !== undefined) {
    lines.push(`Agent: ${[
      run.agent.harness,
      run.agent.model,
      run.agent.thinking === undefined ? undefined : `thinking ${run.agent.thinking}`,
    ].filter((part) => part !== undefined).join(" · ")}`);
  }
  if (run.human !== undefined) {
    lines.push(`Human: ${run.human.prompt}`, `Request id: ${run.human.requestId}`);
    if (run.human.choices !== undefined) lines.push(`Choices: ${run.human.choices.join(", ")}`);
    if (run.human.suggestions !== undefined) {
      lines.push(`Suggestions: ${run.human.suggestions.join(", ")}`);
    }
  }
  if (run.error !== undefined) lines.push(`Error: ${run.error}`);
  return lines.join("\n");
}

function formatState(state: StateValue | undefined): string | undefined {
  if (state === undefined) return undefined;
  return typeof state === "string" ? state : JSON.stringify(state);
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

async function main(): Promise<void> {
  const { server, session } = createMachinesMcpServer();
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    session.close();
  };
  process.once("exit", close);
  process.once("SIGINT", () => {
    close();
    process.exit(0);
  });
  process.once("SIGTERM", () => {
    close();
    process.exit(0);
  });
  process.stdin.once("end", close);
  await server.connect(new StdioServerTransport());
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((cause: unknown) => {
    console.error(errorMessage(cause));
    process.exit(1);
  });
}
