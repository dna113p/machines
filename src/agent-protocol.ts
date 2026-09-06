import type { AgentRequest, Event } from "./index.ts";

export function agentPrompt(request: AgentRequest): string {
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

export function readAgentEvent(
  output: string,
  options: { readonly adapter: string; readonly includeMessage: boolean },
): Event {
  const matches = [...output.matchAll(/^MACHINES_EVENT (.+)$/gmu)];
  const encoded = matches.at(-1)?.[1];
  if (encoded === undefined) {
    throw new Error(`${options.adapter} Agent finished without returning a Machines event`);
  }

  let event: unknown;
  try {
    event = JSON.parse(encoded);
  } catch (cause) {
    throw new Error(`${options.adapter} Agent returned invalid event JSON`, { cause });
  }

  if (!isEvent(event)) {
    throw new Error(`${options.adapter} Agent returned an invalid Machines event`);
  }

  const message = output.replace(/^MACHINES_EVENT .+$(?:\r?\n)?/gmu, "").trim();
  return options.includeMessage && message !== "" ? { ...event, message } : event;
}

function isEvent(value: unknown): value is Event {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && "type" in value
    && typeof value.type === "string";
}
