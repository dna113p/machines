import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
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

test("records of both schema versions are shown alike", () => {
  const request = { requestId: "request-1", choices: ["approve", "deny"], suggestions: ["later"], discussion: true };
  const lines = (schemaVersion: 1 | 2, human: RunStatusRecord["human"]) => runStatusLines([
    record({ schemaVersion, id: "running-run", state: "review", agent: { harness: "claude" } }),
    record({ schemaVersion, id: "waiting-run", status: "waiting", state: "approve", human }),
  ], alive);
  const expected = ["● running-  ticket › review · 0s", "  claude", "◆ waiting-  ticket › input needed · 0s", "  Approve the plan?"];

  assert.deepEqual(lines(1, { prompt: "Approve the plan?" }), expected);
  assert.deepEqual(lines(2, { prompt: "Approve the plan?", ...request }), expected);
  // What answers a request is never drawn on the status line.
  assert.doesNotMatch(lines(2, { prompt: "Approve the plan?", ...request }).join("\n"), /request-1|deny|later/u);
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

test("a watched run is shown whoever owns it and wherever it works, once, as any other run is", () => {
  const theirs = record({
    id: "1a2b3c4d-0000", owner: "another-session", cwd: "/elsewhere", label: "org-9 → machines: Watch runs", state: "change",
    startedAt: ago(65_000), stateSince: ago(5_000), updatedAt: ago(1_000),
    agent: { harness: "claude", model: "claude-opus-5-5" },
  });
  const unowned = record({ id: "5e6f7a8b-0000", cwd: "/elsewhere/child", state: "review", updatedAt: ago(2_000) });
  const mine = record({ id: "9c0d1e2f-0000", owner: "session", cwd: "/elsewhere", label: "org-9: Mine", state: "verify" });
  const records = [theirs, unowned, mine];
  const lines = (watches?: readonly unknown[], sessionId = "session") =>
    runStatusLines(records, { ...alive, sessionId, ...(watches === undefined ? {} : { watches: watches as object[] }) });
  const own = ["● org-9: Mine", "  ticket › verify · 0s"];
  const watched = ["● org-9 → machines: Watch runs", "  ticket › change · 5s (1m 5s total) · claude-opus-5-5"];

  // A session that watches nothing sees what it always saw.
  assert.deepEqual(lines(), own);
  assert.deepEqual(lines([]), own);
  assert.deepEqual(lines([{ text: "org-7" }, { dir: "/work/other" }]), own);
  assert.deepEqual(lines([{ text: "1a2b" }]), [...own, ...watched]);
  assert.deepEqual(lines([{ dir: "/elsewhere/child" }]), [...own, "● 5e6f7a8b  ticket › review · 0s"]);
  // A run its session owns, or that several entries name, is still one run.
  assert.deepEqual(lines([{ text: "org-9" }, { text: "1a2b" }, { text: "9c0d" }, { dir: "/elsewhere" }, { text: "org-9" }]), [
    ...own, ...watched, "● 5e6f7a8b  ticket › review · 0s",
  ]);
  // The list belongs to the session that reads it, not to the runs.
  assert.deepEqual(lines([{ text: "org-9" }], "third-session"), [...own, ...watched]);
  assert.deepEqual(lines(undefined, "third-session"), []);

  // A sub-run stays its parent's detail, and what is not a watch names nothing.
  assert.deepEqual(runStatusLines([{ ...theirs, parent: "outer-run" }], { ...alive, watches: [{ text: "org-9" }, { text: "1a2b" }] }), []);
  const invalid = [null, 7, "org-9", [], {}, { text: "" }, { text: 9 }, { dir: "elsewhere" }, { dir: 7 }, { text: "org-9", dir: "/elsewhere" }];
  assert.deepEqual(lines(invalid), own);
  assert.deepEqual(lines([...invalid, { text: "5e6f" }]), [...own, "● 5e6f7a8b  ticket › review · 0s"]);

  // A run answered through its host shows its request as any waiting run does.
  const hosted = { ...theirs, status: "waiting", agent: undefined, answeredBy: "host", human: { prompt: "Approve the plan?\nIt changes three files." } };
  const shown = runStatusLines([hosted], { ...alive, watches: [{ text: "org-9" }] });
  assert.deepEqual(shown, ["◆ org-9 → machines: Watch runs", "  ticket › input needed · 5s (1m 5s total)", "  Approve the plan?"]);
  assert.deepEqual(runStatusLines([{ ...hosted, answeredBy: undefined, owner: "session" }], alive), shown);
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
    { ...record({ id: "wrong-schema" }), schemaVersion: 3 },
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

test("the script also shows what its session watches, and a list it cannot read changes nothing", async (context) => {
  const directory = await temporaryDirectory(context);
  const started = new Date(Date.now() - 5_000).toISOString();
  const published = (change: Partial<RunStatusRecord>) => writeFile(
    join(directory, `${change.id}.json`),
    JSON.stringify(record({ pid: process.pid, startedAt: started, updatedAt: started, ...change })),
  );
  const updated = (secondsAgo: number) => new Date(Date.now() - secondsAgo * 1_000).toISOString();
  await published({ id: "owned-run", owner: "session", cwd: "/elsewhere", state: "review", updatedAt: updated(2) });
  await published({
    id: "foreign-run", owner: "another", cwd: "/work/project", label: "org-9: Watch runs", state: "change", updatedAt: updated(0),
  });
  await published({ id: "distant-run", cwd: "/work/other/child", state: "verify", updatedAt: updated(1) });
  await published({ id: "inner-run", parent: "foreign-run", label: "org-9: A step", cwd: "/work/other" });
  const show = (sessionId: unknown = "session") => runScript(
    JSON.stringify({ session_id: sessionId, workspace: { project_dir: "/work/project" } }),
    { MACHINES_RUN_STATUS_DIR: directory, NO_COLOR: "1" },
  );
  const before = show();
  assert.match(before.stdout, /^● owned-ru  ticket › review · \d+s\n$/u);
  const unchanged = (written: string) => {
    const result = show();
    assert.deepEqual(
      { status: result.status, stderr: result.stderr, stdout: result.stdout.replace(/\d+s/gu, "0s") },
      { status: 0, stderr: "", stdout: before.stdout.replace(/\d+s/gu, "0s") },
      written,
    );
  };

  const list = join(directory, ".watch.session.json");
  for (const text of ["{", "", "null", "[]", '"org-9"', '{"watches":{"text":"org-9"}}', '{"watches":[null,{"text":""},{"dir":"other"}]}']) {
    await writeFile(list, text);
    unchanged(text);
  }
  await rm(list);
  await mkdir(list);
  unchanged("a directory");
  await rm(list, { recursive: true });
  // Another session's list, and a session id that would leave the directory, name nothing.
  const watches = JSON.stringify({ schemaVersion: 1, watches: [{ text: "org-9" }, { dir: "/work/other" }] });
  await writeFile(join(directory, ".watch.another.json"), watches);
  await mkdir(join(directory, ".watch.nested"));
  await writeFile(join(directory, ".watch.nested", "session.json"), watches);
  unchanged("another session's list");
  for (const sessionId of ["nested/session", "../escaped", ".hidden", "", 7, null]) {
    assert.deepEqual({ status: show(sessionId).status, stdout: show(sessionId).stdout }, { status: 0, stdout: "" });
  }

  await writeFile(list, watches);
  assert.match(show().stdout, new RegExp([
    "^● org-9: Watch runs", "  ticket › change · \\d+s", "● distant-  ticket › verify · \\d+s", "● owned-ru  ticket › review · \\d+s", "$",
  ].join("\n"), "u"));
});

test("with nothing set, the script reads the standard directory of its home", async (context) => {
  const root = await temporaryDirectory(context);
  const stdin = JSON.stringify({ session_id: "session", cwd: "/work/project" });
  const unset = { MACHINES_RUN_STATUS_DIR: undefined, NO_COLOR: "1" };
  const homes: ReadonlyArray<readonly [string, Readonly<Record<string, string | undefined>>, string]> = [
    ["the process's home", { ...unset, HOME: join(root, "home") }, join(root, "home", ".local", "state", "machines", "runs")],
    ["XDG_STATE_HOME", { ...unset, HOME: join(root, "unused"), XDG_STATE_HOME: join(root, "xdg") }, join(root, "xdg", "machines", "runs")],
    [
      "the Machines home",
      { ...unset, HOME: join(root, "unused"), XDG_STATE_HOME: join(root, "unused"), MACHINES_USER_HOME: join(root, "machines-home") },
      join(root, "machines-home", ".local", "state", "machines", "runs"),
    ],
  ];
  for (const [name, environment, directory] of homes) {
    // Before any run has published there, the directory is missing: no runs, and no error.
    const missing = runScript(stdin, environment);
    assert.deepEqual({ status: missing.status, stdout: missing.stdout, stderr: missing.stderr }, { status: 0, stdout: "", stderr: "" }, name);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "run.json"), JSON.stringify(record({ id: `${name} run`, owner: "session", pid: process.pid })));
    await writeFile(join(directory, ".watch.session.json"), JSON.stringify({ watches: [] }));
    const shown = runScript(stdin, environment);
    assert.match(shown.stdout, new RegExp(`^● ${name.slice(0, 8)}  ticket › starting · `, "u"), `${name}: ${shown.stderr}`);
    // The switch turns the reader off as it turns the writers off.
    for (const off of ["off", ""]) assert.equal(runScript(stdin, { ...environment, MACHINES_RUN_STATUS_DIR: off }).stdout, "", name);
  }
  // Reading makes nothing.
  assert.deepEqual((await readdir(root)).sort(), ["home", "machines-home", "xdg"]);
});

test("the script is silent and successful when it has nothing valid to show", async (context) => {
  const directory = await temporaryDirectory(context);
  await writeFile(join(directory, "run.json"), JSON.stringify(record({ owner: "session", pid: process.pid })));
  const stdin = JSON.stringify({ session_id: "session", cwd: "/work/project" });
  const visible = runScript(stdin, { MACHINES_RUN_STATUS_DIR: directory });
  assert.notEqual(visible.stdout, "");

  for (const [input, environment] of [
    [stdin, { MACHINES_RUN_STATUS_DIR: "off" }],
    [stdin, { MACHINES_RUN_STATUS_DIR: "" }],
    [stdin, { MACHINES_RUN_STATUS_DIR: undefined, MACHINES_USER_HOME: "relative/home" }],
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
    schemaVersion: 2,
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

/** Runs the script with publication off unless `environment` says where; an undefined value unsets its variable. */
function runScript(input: string, environment: Readonly<Record<string, string | undefined>>) {
  return spawnSync(process.execPath, [script], {
    input, encoding: "utf8", env: { PATH: process.env.PATH, MACHINES_RUN_STATUS_DIR: "off", ...environment },
  });
}

async function temporaryDirectory(context: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "machines-statusline-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
