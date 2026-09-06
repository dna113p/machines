const mode = process.argv[2] ?? "completed";
const args = process.argv.slice(3);
const emit = (record) => process.stdout.write(`${JSON.stringify(record)}\n`);

if (mode === "signal-exit") process.kill(process.pid, "SIGTERM");

if (mode === "error-exit") {
  process.stderr.write("agy crashed\n");
  process.exit(1);
}

emit({
  event: "init",
  conversation_id: "fake-conversation",
  init: { cwd: process.cwd(), tools: ["write_to_file"] },
});

if (mode === "activity") {
  emit({
    event: "step_update",
    step_update: {
      step_index: 1,
      step_type: "tool",
      tool_name: "write_to_file",
      state: "ACTIVE",
    },
  });
  emit({
    event: "step_update",
    step_update: {
      step_index: 1,
      step_type: "tool",
      tool_name: "write_to_file",
      state: "DONE",
    },
  });
}

if (mode === "malformed") {
  process.stdout.write("not JSON\n");
  for (const record of [
    null,
    [],
    { event: "step_update", step_update: null },
    { event: "step_update", step_update: { step_type: "agent_response", text_delta: {} } },
    { event: "step_update", step_update: { step_type: "tool", tool_name: { bad: true } } },
    { event: "step_update", step_update: { step_type: "tool", tool_info: { name: 12 } } },
    { event: "step_update", step_update: { step_type: "tool", step_index: [] } },
    { event: "step_update", step_update: { step_type: "tool", state: {} } },
    { event: "result", result: { response: [] } },
  ]) emit(record);
  emit({ event: "step_update", step_update: {
    step_type: "tool", step_index: 3, tool_info: { name: "write_to_file" }, state: "ACTIVE",
  } });
}

const flag = (name) => args.includes(name) ? args[args.indexOf(name) + 1] : null;
const event = mode === "arguments"
  ? {
    type: "completed",
    modelFlag: flag("--model"),
    effortFlag: flag("--effort"),
    envModel: process.env.AGY_MODEL,
    envEffort: process.env.AGY_EFFORT,
    skipPermissions: args.includes("--dangerously-skip-permissions"),
  }
  : mode === "environment"
  ? { type: "completed", profile: process.env.MACHINES_TEST_PROFILE }
  : { type: "completed", source: "fake" };

const text = mode === "missing-event"
  ? "fake agy agent finished without an event\n"
  : `fake agy agent finished\nMACHINES_EVENT ${JSON.stringify(event)}\n`;

if (mode === "stderr") process.stderr.write("agy diagnostic\n");
if (mode !== "result-only") {
  const delta = mode === "progress"
    ? "Working on it.\n"
    : mode === "partial"
    ? text.slice(0, 8)
    : mode === "progress-and-final"
    ? `Working on it.\n${text}`
    : mode === "stale-event"
    ? 'Preliminary result\nMACHINES_EVENT {"type":"blocked"}\n'
    : text;
  emit({ event: "step_update", step_update: {
    step_index: 2, step_type: "agent_response", text_delta: delta,
  } });
}

if (mode !== "delta-only") emit({
  event: "result",
  result: {
    status: "SUCCESS",
    response: mode === "empty-final" ? "" : text,
  },
});
