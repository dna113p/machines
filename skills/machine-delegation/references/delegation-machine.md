# A Machine for one delegated assignment

Use this starter when no existing Machine provides the needed task and result
contract. Save it as `.machines/delegate-task.ts`, then adapt verification to the
assignment using [Authoring Machines](../../../docs/authoring.md). It accepts a JSON
input string containing `task` and an absolute `resultPath` that does not yet exist.
The Agent works in the launch workspace and returns a summary; an Operation saves
the result, so the Agent can use a read-only preset for research or review.

```ts
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import type { Event, MachinePrimitives } from "@dna113p/machines";

export const description = "Completes a bounded assignment and saves its outcome and evidence as JSON.";
export const agentRoles = { worker: "Performs the delegated assignment" };

export default function delegateTask(
  { machine, agent, operation, final }: MachinePrimitives,
  input: string,
) {
  const assignment = JSON.parse(input);
  if (
    typeof assignment?.task !== "string" || assignment.task.trim() === "" ||
    typeof assignment?.resultPath !== "string" || !isAbsolute(assignment.resultPath)
  ) {
    throw new Error("Expected task and absolute resultPath in JSON input");
  }

  const fields = ["assumptions", "scopeAdditions", "openQuestions", "needs"] as const;
  type Result = { outcome: string; summary: string } &
    Partial<Record<typeof fields[number], string[]>>;
  let result: Result | undefined;
  const capture = ({ event }: { event: Event }) => {
    if (typeof event.summary !== "string" || event.summary.trim() === "") {
      throw new Error("Worker must return a non-empty summary with evidence or blockers");
    }
    const captured: Result = { outcome: event.type, summary: event.summary };
    for (const field of fields) {
      const value = event[field];
      if (value === undefined) continue;
      if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
        throw new Error(`Worker must return ${field} as a list of strings`);
      }
      if (field !== "needs" || event.type === "blocked") captured[field] = value;
    }
    result = captured;
  };

  return machine({
    initial: "work",
    states: {
      work: agent(
        `${assignment.task}\n\nComplete this bounded assignment yourself. ` +
        "Return completed when its acceptance criteria are met, or blocked when " +
        "a person must decide an irreversible question or supply a login. Include a " +
        "non-empty summary string in the final Machines event with findings or changes, " +
        "verification evidence, and blockers. Include optional string lists: assumptions " +
        "for assumed answers, scopeAdditions for added work within authorization, " +
        "openQuestions for irreversible questions only, and needs on blocked for what " +
        "a person must supply or decide. Report other open findings with the draft. " +
        "Checks you cannot run are the workflow's to run. " +
        "The Machine saves these fields; you do not need to write a separate report.",
        {
          completed: { target: "save", actions: capture },
          blocked: { target: "save", actions: capture },
        },
        { using: "worker", cwd: process.cwd() },
      ),
      save: operation(async () => {
        if (result === undefined) throw new Error("Worker result is missing");
        await mkdir(dirname(assignment.resultPath), { recursive: true });
        await writeFile(assignment.resultPath, JSON.stringify(result, null, 2) + "\n", {
          flag: "wx",
        });
        return { type: result.outcome };
      }, { completed: "done", blocked: "blocked" }),
      done: final(),
      blocked: final(),
    },
  });
}
```

Discover the definition and presets, then bind `worker` to a discovered preset.
For example, if `codex` is available and configured, launch a read-only review via
MCP with these arguments (replace the example paths and task):

```json
{
  "cwd": "/absolute/project",
  "machine": "delegate-task",
  "input": "{\"task\":\"Read src/parser.ts and its tests. Identify unhandled input cases with file and line evidence. Leave source files unchanged.\",\"resultPath\":\"/absolute/project/.machines/results/parser-review-01.json\"}",
  "agents": { "worker": "codex" }
}
```

The saved JSON has `outcome` and `summary`, plus optional string lists `assumptions`,
`scopeAdditions`, `openQuestions` (irreversible questions only), and `needs` on
`blocked`. Read it after the run finishes; `done` means the worker reported
completion and its result was saved. `blocked` is a terminal outcome requiring
the coordinator's attention. This starter validates the result contract, not the
truth of the worker's claims: inspect its evidence, and add verification Operations
for conditions the Machine can check directly.

Before real work, exercise both outcomes with fake runners through the public
runtime or launcher. Also check that a missing summary fails and that an existing
result file is preserved. Use a fresh result path for each run; retrying after a
write failure may repeat completed Agent work, so inspect partial effects first.
