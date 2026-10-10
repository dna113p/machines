import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { stripVTControlCharacters } from "node:util";

import { runStatusLines } from "../claude/statusline.mjs";
import type { RunStatusRecord } from "../src/run-status.ts";

const script = resolve("claude/statusline.mjs");
const now = Date.parse("2026-03-04T05:06:07.000Z");
const alive = { now, sessionId: "session", projectDir: "/work/project", color: false, isAlive: () => true };

test("a labelled run leads with its label, then workflow, time in state, and Agent", () => {
  const labelled = record({
    id: "1a2b3c4d-0000", label: "org-2 → machines: Continue a chat", state: "change",
    startedAt: ago(1_967_000), stateSince: ago(312_000),
    agent: { harness: "claude", model: "claude-opus-5-5", thinking: "high" },
  });
  assert.deepEqual(runStatusLines([labelled], alive), [
    "● org-2 → machines: Continue a chat",
    "  ticket › change · 5m 12s (32m 47s total) · claude-opus-5-5 · high",
  ]);
  // A finished run reports only its whole duration.
  assert.deepEqual(runStatusLines([{ ...labelled, status: "completed", state: "done", updatedAt: ago(0) }], alive), [
    "✓ org-2 → machines: Continue a chat",
    "  ticket › done · 32m 47s",
  ]);
  assert.deepEqual(runStatusLines([record({ id: "1a2b3c4d-0000", state: "review", stateSince: ago(5_000), startedAt: ago(65_000) })], alive), [
    "● 1a2b3c4d  ticket › review · 5s (1m 5s total)",
  ]);
});

test("a run is one line, with its Agent or its Human prompt beneath it", () => {
  assert.deepEqual(runStatusLines([
    record({ id: "1a2b3c4d-0000", state: "review", startedAt: ago(125_000), agent: { harness: "claude", model: "opus", thinking: "high" } }),
  ], alive), [
    "● 1a2b3c4d  ticket › review · 2m 5s",
    "  claude · opus · high",
  ]);
  assert.deepEqual(runStatusLines([
    record({ id: "starting", startedAt: ago(59_999), agent: { harness: "codex" } }),
  ], alive), ["● starting  ticket › starting · 59s", "  codex"]);
  assert.deepEqual(runStatusLines([
    record({
      id: "waiting-run",
      status: "waiting",
      state: "approve",
      startedAt: ago(3_000),
      agent: { harness: "claude" },
      human: { prompt: "\nApprove the plan?\nIt changes three files." },
    }),
  ], alive), ["◆ waiting-  ticket › input needed · 3s", "  Approve the plan?"]);
  assert.deepEqual(runStatusLines([
    record({ id: "completed", status: "completed", state: "done", startedAt: ago(70_000), updatedAt: ago(10_000) }),
    record({ id: "failed-run", status: "failed", state: "review", error: "boom", startedAt: ago(20_000), updatedAt: ago(5_000) }),
  ], alive), ["✕ failed-r  ticket › failed · 15s", "✓ complete  ticket › done · 1m 0s"]);
});

test("statuses are coloured unless colour is disabled", () => {
  const records = [
    record({ id: "running", state: "review", agent: { harness: "claude" } }),
    record({ id: "waiting", status: "waiting", human: { prompt: "Approve?" } }),
    record({ id: "completed", status: "completed", state: "done", updatedAt: ago(2_000) }),
    record({ id: "failed", status: "failed", updatedAt: ago(3_000) }),
  ];
  const colored = runStatusLines(records, { ...alive, color: true });
  const plain = runStatusLines(records, alive);

  assert.deepEqual(colored.map(stripVTControlCharacters), plain);
  assert.ok(plain.every((line) => !line.includes("\x1b")));
  const symbols = colored.filter((line) => !line.startsWith(" ")).map((line) => line.slice(0, line.indexOf(" ")));
  assert.deepEqual(symbols, ["\x1b[36m●\x1b[0m", "\x1b[33m◆\x1b[0m", "\x1b[32m✓\x1b[0m", "\x1b[31m✕\x1b[0m"]);
  assert.ok(colored[0]!.includes("\x1b[36mreview\x1b[0m"));
  assert.ok(colored[2]!.includes("\x1b[33minput needed\x1b[0m"));
  assert.equal(colored[3], "  \x1b[33mApprove?\x1b[0m");
});

test("a session sees the runs it owns and unowned runs inside its project", () => {
  const shown = (change: Partial<RunStatusRecord>, options = alive) =>
    runStatusLines([record(change)], options).length > 0;

  assert.equal(shown({ owner: "session", cwd: "/elsewhere" }), true);
  assert.equal(shown({ owner: "other-session", cwd: "/work/project" }), false);
  // A run started from inside another Machine is that run's detail, not the session's.
  assert.equal(shown({ owner: "session", parent: "outer-run" }), false);
  assert.equal(shown({ owner: "session" }, { ...alive, sessionId: undefined as unknown as string }), false);
  assert.equal(shown({ cwd: "/work/project" }), true);
  assert.equal(shown({ cwd: "/work/project/packages/child" }), true);
  assert.equal(shown({ cwd: "/work/project" }, { ...alive, projectDir: "/work/project/" }), true);
  assert.equal(shown({ cwd: "/work/project-other" }), false);
  assert.equal(shown({ cwd: "/work" }), false);
  assert.equal(shown({ cwd: "project" }), false);
  assert.equal(shown({ cwd: "/work/project" }, { ...alive, projectDir: undefined as unknown as string }), false);
});

test("active runs stay visible and finished runs leave after thirty seconds", () => {
  const ids = (records: RunStatusRecord[]) => runStatusLines(records, alive).map((line) => line.split(" ")[1]);

  assert.deepEqual(ids([
    record({ id: "old-run", startedAt: ago(7_200_000), updatedAt: ago(7_200_000) }),
    record({ id: "old-wait", status: "waiting", startedAt: ago(7_200_000), updatedAt: ago(3_600_000) }),
    record({ id: "done-30", status: "completed", updatedAt: ago(30_000) }),
    record({ id: "done-31", status: "completed", updatedAt: ago(30_001) }),
    record({ id: "fail-29", status: "failed", updatedAt: ago(29_000) }),
    record({ id: "fail-31", status: "failed", updatedAt: ago(31_000) }),
  ]), ["old-wait", "old-run", "fail-29", "done-30"]);
});

test("an active record whose process is gone is shown as lost for thirty seconds", () => {
  const options = { ...alive, isAlive: (pid: number) => pid !== 4242 };
  const lost = record({
    id: "lost-run", pid: 4242, state: "review", startedAt: ago(100_000), updatedAt: ago(20_000),
    agent: { harness: "claude" },
  });
  assert.deepEqual(runStatusLines([lost], options), ["✕ lost-run  ticket › lost · 1m 20s"]);
  assert.equal(runStatusLines([lost], { ...options, color: true })[0]!.startsWith("\x1b[31m✕\x1b[0m"), true);
  assert.deepEqual(runStatusLines([{ ...lost, status: "waiting", human: { prompt: "Approve?" } }], options), [
    "✕ lost-run  ticket › lost · 1m 20s",
  ]);
  assert.deepEqual(runStatusLines([{ ...lost, updatedAt: ago(31_000) }], options), []);
  assert.deepEqual(
    runStatusLines([lost, record({ id: "live-run", updatedAt: ago(50_000) })], options).map((line) => line.split(" ")[1]),
    ["live-run", "lost-run"],
  );

  const exited = spawnSync(process.execPath, ["-e", ""]).pid;
  const probed = { now, sessionId: "session", color: false };
  assert.match(runStatusLines([record({ pid: exited, owner: "session" })], probed)[0]!, /› lost · /u);
  assert.match(runStatusLines([record({ pid: process.pid, owner: "session", state: "work" })], probed)[0]!, /› work · /u);
});

test("at most five runs are shown, active first and then most recently updated", () => {
  const records = [
    record({ id: "done-new", status: "completed", updatedAt: ago(1_000) }),
    record({ id: "run-old", updatedAt: ago(90_000) }),
    record({ id: "done-old", status: "completed", updatedAt: ago(9_000) }),
    record({ id: "wait-new", status: "waiting", updatedAt: ago(2_000) }),
    record({ id: "fail-mid", status: "failed", updatedAt: ago(5_000) }),
    record({ id: "run-mid", updatedAt: ago(40_000) }),
    record({ id: "done-mid", status: "completed", updatedAt: ago(4_000) }),
  ];
  const lines = runStatusLines(records, alive);

  assert.deepEqual(lines.map((line) => line.split(" ")[1]), ["wait-new", "run-mid", "run-old", "done-new", "done-mid", "2"]);
  assert.equal(lines.at(-1), "… 2 more");
  assert.equal(runStatusLines(records.slice(0, 5), alive).length, 5);
  assert.equal(runStatusLines(records, { ...alive, color: true }).at(-1), "\x1b[2m… 2 more\x1b[0m");
});

test("lines are truncated to the visible width without counting colour", () => {
  const long = record({
    id: "1a2b3c4d", machine: "implementation-workflow", state: "review", startedAt: ago(5_000),
    agent: { harness: "claude", model: "a-very-long-model-name", thinking: "high" },
  });
  const full = "● 1a2b3c4d  implementation-workflow › review · 5s";
  assert.deepEqual(runStatusLines([long], { ...alive, columns: full.length }), [full, "  claude · a-very-long-model-name · high"]);
  assert.deepEqual(runStatusLines([long], { ...alive, columns: 24 }), [
    "● 1a2b3c4d  implementat…",
    "  claude · a-very-long-…",
  ]);

  assert.ok(runStatusLines([long], { ...alive, columns: 24 }).every((line) => [...line].length === 24));

  const colored = runStatusLines([long], { ...alive, columns: 24, color: true });
  assert.deepEqual(colored.map(stripVTControlCharacters), runStatusLines([long], { ...alive, columns: 24 }));
  assert.equal(colored[0], "\x1b[36m●\x1b[0m \x1b[2m1a2b3c4d\x1b[0m  \x1b[1mimplementat…\x1b[0m");
  assert.ok(runStatusLines([record({ machine: "m".repeat(400) })], alive).every((line) => [...line].length === 120));
});

test("truncation measures terminal columns, not characters", () => {
  const lines = (change: Partial<RunStatusRecord>, columns: number, color = false) =>
    runStatusLines([record({ id: "1a2b3c4d", startedAt: ago(5_000), ...change })], { ...alive, columns, color });

  // Each CJK character and each emoji fills two columns.
  assert.deepEqual(lines({ machine: "審査".repeat(20), state: "review" }, 24), ["● 1a2b3c4d  審査審査審…"]);
  assert.deepEqual(lines({ machine: "審査".repeat(20), state: "review" }, 25), ["● 1a2b3c4d  審査審査審査…"]);
  assert.deepEqual(lines({ machine: "🚀".repeat(20), state: "review" }, 19), ["● 1a2b3c4d  🚀🚀🚀…"]);
  assert.deepEqual(lines({ machine: "審査", state: "確認" }, 28), ["● 1a2b3c4d  審査 › 確認 · 5s"]);
  assert.deepEqual(lines({ machine: "審査", state: "確認" }, 27), ["● 1a2b3c4d  審査 › 確認 · …"]);
  assert.deepEqual(
    lines({ machine: "審査".repeat(20), state: "review" }, 24, true),
    ["\x1b[36m●\x1b[0m \x1b[2m1a2b3c4d\x1b[0m  \x1b[1m審査審査審…\x1b[0m"],
  );

  // A combining mark or a joiner is drawn on the character before it and stays with it.
  const waiting = { status: "waiting", human: { prompt: "e\u0301".repeat(30) } } as const;
  assert.equal(lines(waiting, 12)[1], `  ${"e\u0301".repeat(9)}…`);
  assert.equal(lines({ ...waiting, human: { prompt: "e\u0301".repeat(10) } }, 12)[1], `  ${"e\u0301".repeat(10)}`);
  assert.equal(lines({ ...waiting, human: { prompt: "a\u200db".repeat(10) } }, 6)[1], "  a\u200dba\u200d…");
});

test("recorded text cannot inject control sequences, and invalid records are skipped", () => {
  const lines = runStatusLines([
    record({
      id: "hostile", machine: "tick\x1b[2Jet", state: "re\tview", status: "waiting",
      human: { prompt: "Approve\x1b]0;title\x07?\r\nmore" },
    }),
    { ...record({ id: "wrong-schema" }), schemaVersion: 2 },
    { ...record({ id: "wrong-pid" }), pid: -1 },
    { ...record({ id: "wrong-status" }), status: "paused" },
    { ...record({ id: "wrong-time" }), updatedAt: "soon" },
    { ...record({ id: "wrong-human" }), human: {} },
    {},
  ], { ...alive, color: true });

  assert.equal(lines.length, 2);
  assert.ok(lines.every((line) => !/[\u0000-\u001a\u001c-\u001f\u007f]/u.test(line.replace(/\x1b\[[0-9;]*m/gu, ""))));
  assert.deepEqual(lines.map(stripVTControlCharacters), ["◆ hostile  tick [2Jet › input needed · 0s", "  Approve ]0;title ?"]);
});

test("the script prints the visible runs for the Claude Code session on stdin", async (context) => {
  const directory = await temporaryDirectory(context);
  const started = new Date(Date.now() - 5_000).toISOString();
  await writeFile(join(directory, "owned.json"), JSON.stringify(record({
    id: "owned-run", owner: "session", cwd: "/elsewhere", state: "review", pid: process.pid,
    startedAt: started, updatedAt: started, agent: { harness: "claude", model: "opus", thinking: "high" },
  })));
  await writeFile(join(directory, "local.json"), JSON.stringify(record({
    id: "local-run", cwd: "/work/project/child", status: "completed", state: "done",
    startedAt: started, updatedAt: new Date().toISOString(),
  })));
  await writeFile(join(directory, "foreign.json"), JSON.stringify(record({
    id: "foreign", owner: "other", cwd: "/work/project", pid: process.pid, startedAt: started, updatedAt: started,
  })));
  await writeFile(join(directory, "malformed.json"), "{");
  await writeFile(join(directory, ".owned.json.1.tmp"), "{");
  const stdin = JSON.stringify({ session_id: "session", workspace: { project_dir: "/work/project", current_dir: "/tmp" }, cwd: "/tmp" });

  const plain = runScript(stdin, { MACHINES_RUN_STATUS_DIR: directory, NO_COLOR: "1" });
  assert.equal(plain.status, 0, plain.stderr);
  assert.match(plain.stdout, /^● owned-ru  ticket › review · \d+s\n  claude · opus · high\n✓ local-ru  ticket › done · \d+s\n$/u);

  const colored = runScript(stdin, { MACHINES_RUN_STATUS_DIR: directory });
  assert.equal(stripVTControlCharacters(colored.stdout), plain.stdout);
  assert.ok(colored.stdout.startsWith("\x1b[36m●\x1b[0m "));
  // NO_COLOR disables colour whenever it is set, even to an empty value.
  assert.equal(runScript(stdin, { MACHINES_RUN_STATUS_DIR: directory, NO_COLOR: "" }).stdout, plain.stdout);
  assert.equal(runScript(stdin, { MACHINES_RUN_STATUS_DIR: directory, NO_COLOR: "0" }).stdout, plain.stdout);

  const narrow = runScript(stdin, { MACHINES_RUN_STATUS_DIR: directory, NO_COLOR: "1", COLUMNS: "12" });
  assert.deepEqual(narrow.stdout.split("\n"), ["● owned-ru …", "  claude · …", "✓ local-ru …", ""]);
  const invalidWidth = runScript(stdin, { MACHINES_RUN_STATUS_DIR: directory, NO_COLOR: "1", COLUMNS: "wide" });
  assert.equal(invalidWidth.stdout, plain.stdout);

  for (const fallback of [
    { session_id: "none", workspace: { current_dir: "/work/project" }, cwd: "/tmp" },
    { session_id: "none", cwd: "/work/project" },
  ]) {
    const scoped = runScript(JSON.stringify(fallback), { MACHINES_RUN_STATUS_DIR: directory, NO_COLOR: "1" });
    assert.match(scoped.stdout, /^✓ local-ru  ticket › done · \d+s\n$/u);
  }

  const link = join(directory, "linked-statusline.mjs");
  await symlink(script, link);
  const linked = spawnSync(process.execPath, [link], {
    input: stdin, encoding: "utf8", env: { PATH: process.env.PATH, MACHINES_RUN_STATUS_DIR: directory, NO_COLOR: "1" },
  });
  assert.equal(linked.stdout, plain.stdout);
});

test("the script is silent and successful when it has nothing valid to show", async (context) => {
  const directory = await temporaryDirectory(context);
  await writeFile(join(directory, "run.json"), JSON.stringify(record({ owner: "session", pid: process.pid })));
  const stdin = JSON.stringify({ session_id: "session", cwd: "/work/project" });
  const visible = runScript(stdin, { MACHINES_RUN_STATUS_DIR: directory });
  assert.notEqual(visible.stdout, "");

  for (const [input, environment] of [
    [stdin, {}],
    [stdin, { MACHINES_RUN_STATUS_DIR: "" }],
    [stdin, { MACHINES_RUN_STATUS_DIR: join(directory, "missing") }],
    [stdin, { MACHINES_RUN_STATUS_DIR: join(directory, "run.json") }],
    ["", { MACHINES_RUN_STATUS_DIR: directory }],
    ["not json", { MACHINES_RUN_STATUS_DIR: directory }],
    ["null", { MACHINES_RUN_STATUS_DIR: directory }],
    ["[]", { MACHINES_RUN_STATUS_DIR: directory }],
    ['{"session_id":7,"workspace":"nowhere","cwd":{}}', { MACHINES_RUN_STATUS_DIR: directory }],
    ['{"session_id":"another","cwd":"/elsewhere"}', { MACHINES_RUN_STATUS_DIR: directory }],
  ] as const) {
    const result = runScript(input, environment);
    assert.deepEqual(
      { status: result.status, stdout: result.stdout, stderr: result.stderr },
      { status: 0, stdout: "", stderr: "" },
      `${input} ${JSON.stringify(environment)}`,
    );
  }
});

test("the script starts without the runtime or any dependency", async () => {
  const source = await readFile(script, "utf8");
  const specifiers = [...source.matchAll(/\bfrom\s+"([^"]+)"|\bimport\s*\(\s*"([^"]+)"/gu)].map((match) => match[1] ?? match[2]);
  assert.ok(specifiers.length > 0);
  assert.deepEqual(specifiers.filter((specifier) => !specifier!.startsWith("node:")), []);
});

function record(change: Partial<RunStatusRecord> = {}): RunStatusRecord {
  return {
    schemaVersion: 1,
    id: "run",
    pid: 1,
    machine: "ticket",
    path: "/work/project/.machines/ticket.ts",
    cwd: "/work/project",
    status: "running",
    startedAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    ...change,
  };
}

function ago(milliseconds: number): string {
  return new Date(now - milliseconds).toISOString();
}

function runScript(input: string, environment: Readonly<Record<string, string>>) {
  return spawnSync(process.execPath, [script], {
    input, encoding: "utf8", env: { PATH: process.env.PATH, ...environment },
  });
}

async function temporaryDirectory(context: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "machines-statusline-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
