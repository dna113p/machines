import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";

import machinesExtension from "../pi-extension/index.ts";

interface Result {
  readonly content: readonly [{ readonly type: "text"; readonly text: string }];
  readonly details: unknown;
}

interface RegisteredTool {
  readonly name: string;
  readonly promptSnippet?: string;
  readonly promptGuidelines?: readonly string[];
  execute(
    id: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    update: unknown,
    context: Context,
  ): Promise<Result>;
  renderResult?(
    result: Result,
    options: { readonly expanded: boolean },
    theme: Theme,
  ): { render(width: number): string[] };
}

interface Context {
  readonly cwd: string;
  readonly ui: FakeUi;
}

interface Theme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

class FakeUi {
  widget: string[] | undefined;
  widgetPlacement: "aboveEditor" | "belowEditor" | undefined;
  readonly notifications: Array<{ message: string; type?: string }> = [];
  readonly selections: Array<{ title: string; options: string[] }> = [];
  readonly inputs: Array<{ title: string; placeholder?: string }> = [];
  readonly selectionResponses: Array<string | undefined> = [];
  readonly inputResponses: Array<string | undefined> = [];

  async select(title: string, options: string[]) {
    this.selections.push({ title, options });
    return this.selectionResponses.shift();
  }

  async input(title: string, placeholder?: string) {
    this.inputs.push({ title, ...(placeholder === undefined ? {} : { placeholder }) });
    return this.inputResponses.shift();
  }

  notify(message: string, type?: "info" | "warning" | "error") {
    this.notifications.push({ message, ...(type === undefined ? {} : { type }) });
  }

  setWidget(
    _key: string,
    content: string[] | ((tui: unknown, theme: Theme) => { render(width: number): string[] }) | undefined,
    options?: { readonly placement?: "aboveEditor" | "belowEditor" },
  ) {
    this.widgetPlacement = options?.placement;
    const theme: Theme = { fg: (_color, text) => text, bold: (text) => text };
    this.widget = typeof content === "function" ? content(undefined, theme).render(120) : content;
  }
}

function setup() {
  const tools = new Map<string, RegisteredTool>();
  let shutdown: ((event: unknown, context: Context) => void | Promise<void>) | undefined;
  machinesExtension({
    registerTool(tool) {
      tools.set(tool.name, tool as RegisteredTool);
    },
    on(event, handler) {
      assert.equal(event, "session_shutdown");
      shutdown = handler;
    },
  });
  const ui = new FakeUi();
  const context = { cwd: resolve("tests/fixtures/pi-project"), ui };
  const execute = (name: string, params: Record<string, unknown> = {}) => {
    const tool = tools.get(name);
    if (tool === undefined) throw new Error(`Tool ${name} was not registered`);
    return tool.execute("test-call", params, undefined, undefined, context);
  };
  return {
    tools,
    ui,
    context,
    execute,
    shutdown: () => shutdown?.({}, context),
  };
}

test("registers the five small Machine tools with discovery guidance", () => {
  const extension = setup();
  assert.deepEqual([...extension.tools.keys()], [
    "machine_list",
    "machine_agents",
    "machine_start",
    "machine_status",
    "machine_respond",
  ]);
  assert.match(extension.tools.get("machine_list")?.promptSnippet ?? "", /Discover/u);
  assert.match(
    extension.tools.get("machine_list")?.promptGuidelines?.join(" ") ?? "",
    /one-off task normally.*ask before creating persistent Machine policy/u,
  );
  assert.match(
    extension.tools.get("machine_start")?.promptGuidelines?.join(" ") ?? "",
    /asynchronous.*without adding requirements/u,
  );
});

test("lists discoverable Machines and configured Agent presets", async () => {
  const extension = setup();
  const [machines, agents] = await Promise.all([
    extension.execute("machine_list"),
    extension.execute("machine_agents"),
  ]);

  assert.match(machines.content[0].text, /wait — Waits for a deterministic Human decision/u);
  assert.match(agents.content[0].text, /fast — A deterministic Agent preset/u);
  assert.match(agents.content[0].text, /fixture · tiny · low/u);
});

test("starts two concurrent runs, reports both, and responds by exact id", async () => {
  const extension = setup();
  const [firstResult, secondResult] = await Promise.all([
    extension.execute("machine_start", { machine: "wait", input: "first" }),
    extension.execute("machine_start", { machine: "wait", input: "second" }),
  ]);
  const firstId = runId(firstResult);
  const secondId = runId(secondResult);
  assert.notEqual(firstId, secondId);

  await eventually(async () => {
    const status = await extension.execute("machine_status");
    const runs = statusRuns(status);
    assert.equal(runs.filter((run) => run.status === "waiting").length, 2);
    assert.doesNotMatch(status.content[0].text, /Recent:/u);
    assert.equal(runs.some((run) => "activity" in run), false);
    assert.match(extension.ui.widget?.join("\n") ?? "", /first|second/u);
  });
  await eventually(() => assert.equal(extension.ui.selections.length, 2));

  const runs = statusRuns(await extension.execute("machine_status"));
  const firstRequestId = humanRequestId(runs.find((run) => run.id === firstId)!);
  const secondRequestId = humanRequestId(runs.find((run) => run.id === secondId)!);
  await assert.rejects(
    extension.execute("machine_respond", { runId: firstId, requestId: firstRequestId, response: "other" }),
    /Expected one of: approve, deny/u,
  );
  await extension.execute("machine_respond", { runId: firstId, requestId: firstRequestId, response: "approve" });
  await extension.execute("machine_respond", { runId: secondId, requestId: secondRequestId, response: "deny" });

  await eventually(async () => {
    const status = await extension.execute("machine_status");
    assert.equal(
      statusRuns(status).filter((run) => run.status === "completed").length,
      2,
    );
    assert.match(extension.ui.widget?.join("\n") ?? "", /✓.*done/u);
  });
  assert.equal(
    extension.ui.notifications.filter(({ message }) => message.includes("completed")).length,
    2,
  );
  await extension.shutdown();
});

test("routes a suggested Human response directly through a Pi selector", async () => {
  const extension = setup();
  extension.ui.selectionResponses.push("approve");

  await extension.execute("machine_start", { machine: "review", input: "direct" });

  await eventually(async () => {
    const status = await extension.execute("machine_status");
    assert.equal(statusRuns(status)[0]?.status, "completed");
  });
  assert.deepEqual(extension.ui.selections, [{
    title: "Review direct?",
    options: ["approve", "details", "Other…"],
  }]);
  assert.deepEqual(extension.ui.inputs, []);
  await extension.shutdown();
});

test("routes Other through direct Pi input without involving the parent Agent", async () => {
  const extension = setup();
  extension.ui.selectionResponses.push("Other…");
  extension.ui.inputResponses.push("Please revise the copy");

  await extension.execute("machine_start", { machine: "review", input: "feedback" });

  await eventually(async () => {
    const status = await extension.execute("machine_status");
    assert.equal(statusRuns(status)[0]?.status, "completed");
  });
  assert.deepEqual(extension.ui.inputs, [{
    title: "Review feedback?",
    placeholder: "Type your response",
  }]);
  await extension.shutdown();
});

test("shutdown terminates waiting hosts and clears the widget", async () => {
  const extension = setup();
  await extension.execute("machine_start", { machine: "wait", input: "shutdown" });
  await eventually(async () => {
    assert.match(extension.ui.widget?.join("\n") ?? "", /input needed/u);
    assert.match(extension.ui.widget?.[0] ?? "", /^┌/u);
    assert.match(extension.ui.widget?.at(-1) ?? "", /^└/u);
    assert.equal(extension.ui.widget?.[0]?.length, 120);
    assert.equal(extension.ui.widget?.at(-1)?.length, 120);
    assert.equal(extension.ui.widgetPlacement, "aboveEditor");
  });

  await extension.shutdown();
  assert.equal(extension.ui.widget, undefined);
  assert.equal(
    extension.ui.notifications.some(({ message }) => message.includes("failed")),
    false,
  );
});

test("tool results stay compact until Pi expands them", async () => {
  const extension = setup();
  const result = await extension.execute("machine_list");
  const render = extension.tools.get("machine_list")?.renderResult;
  assert.ok(render);
  const theme: Theme = { fg: (_color, text) => text, bold: (text) => text };

  assert.match(render(result, { expanded: false }, theme).render(80)[0] ?? "", /Ctrl\+O/u);
  assert.match(render(result, { expanded: true }, theme).render(80).join("\n"), /wait —/u);
});

function runId(result: Result): string {
  const details = result.details as { readonly run?: { readonly id?: unknown } };
  const id = details.run?.id;
  if (typeof id !== "string") throw new Error("machine_start did not return a run id");
  return id;
}

function statusRuns(result: Result): Array<{ readonly status: string; readonly [key: string]: unknown }> {
  const details = result.details as { readonly runs?: unknown };
  assert.ok(Array.isArray(details.runs));
  return details.runs as Array<{ readonly status: string }>;
}

async function eventually(assertion: () => void | Promise<void>): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (true) {
    try {
      await assertion();
      return;
    } catch (cause) {
      if (Date.now() >= deadline) throw cause;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    }
  }
}

function humanRequestId(run: Record<string, unknown>): string {
  const human = run.human;
  assert.ok(human !== null && typeof human === "object" && "requestId" in human);
  assert.equal(typeof human.requestId, "string");
  return human.requestId as string;
}

test("Pi shutdown while its first start is loading cannot create a late run", async () => {
  const extension = setup();
  const started = extension.execute("machine_start", { machine: "wait" });
  await extension.shutdown();
  await assert.rejects(started, /closed|terminated/u);
  assert.equal(extension.ui.widget, undefined);
  assert.equal(extension.ui.notifications.length, 0);
});
