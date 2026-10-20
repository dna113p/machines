import assert from "node:assert/strict";
import { test } from "node:test";

import * as modules from "../src/machine-module.ts";

// Read from the namespace so that each case fails on its own until the export exists.
const { readAgentRoles } = modules;
const readOptionalAgentRoles = (modules as unknown as {
  readonly readOptionalAgentRoles: (loaded: Record<string, unknown>, machinePath: string) => readonly string[];
}).readOptionalAgentRoles;

test("agentRoles declares a role required by its description, or optional with { description, optional: true }", () => {
  const loaded = {
    agentRoles: {
      writer: "Writes the release notes",
      presenter: { description: "Explains a stop to a person", optional: true },
    },
  };
  // Descriptions keep their shape for every reader of agentRoles.
  assert.deepEqual(readAgentRoles(loaded, "briefed.ts"), {
    writer: "Writes the release notes",
    presenter: "Explains a stop to a person",
  });
  assert.deepEqual(readOptionalAgentRoles(loaded, "briefed.ts"), ["presenter"]);
  assert.deepEqual(readOptionalAgentRoles({ agentRoles: { writer: "Writes" } }, "plain.ts"), []);
  assert.deepEqual(readOptionalAgentRoles({}, "none.ts"), []);
});

test("a malformed role declaration is refused, naming the role", () => {
  for (const declaration of [
    { optional: true },
    { description: "", optional: true },
    { description: "Two\nlines", optional: true },
    { description: "Explains", optional: "yes" },
    ["Explains"],
    null,
  ]) {
    const loaded = { agentRoles: { presenter: declaration } };
    assert.throws(() => readAgentRoles(loaded, "briefed.ts"), /presenter/u, JSON.stringify(declaration));
    assert.throws(() => readOptionalAgentRoles(loaded, "briefed.ts"), /presenter/u, JSON.stringify(declaration));
  }
});
