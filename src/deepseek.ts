import { acpAgent, type AcpAgentOptions } from "./acp.ts";
import type { AgentRunner } from "./index.ts";

export interface DeepSeekAgentOptions extends AcpAgentOptions {
  /** An ACP-compatible DSH profile. Defaults to the shipped "acp" profile. */
  readonly profile?: string;
}

/**
 * Runs a fresh DeepSeek Harness session through its standard ACP transport.
 * Configure models, credentials, and permissions in DSH, not in workflow states.
 * Extra arguments precede --profile (for example, npx arguments or --patch).
 */
export function deepseekAgent(
  command = "dsh",
  args: readonly string[] = [],
  options: DeepSeekAgentOptions = {},
): AgentRunner {
  const { profile = "acp", ...acpOptions } = options;
  if (profile.trim() === "" || profile !== profile.trim()) {
    throw new Error("DeepSeek Agent requires a non-empty, trimmed profile name");
  }

  return acpAgent(command, [...args, "--profile", profile], {
    ...acpOptions,
    harness: options.harness ?? "dsh",
  });
}
