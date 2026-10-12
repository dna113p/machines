import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, type TestContext } from "node:test";

import { runStatusLines } from "../claude/statusline.mjs";
import { readRunStatuses, type RunStatusRecord } from "../src/run-status.ts";
import { readRunWatches, runWatchMatches, runWatchPath, writeRunWatches, type RunWatch } from "../src/run-watch.ts";

const session = { CLAUDE_CODE_SESSION_ID: "session" };

test("a session adds, lists, and removes what it watches", async (context) => {
  const directory = join(await temporaryDirectory(context), "status");
  const watching = (environment: Readonly<Record<string, string>> = session) => machine(directory, environment, "watch").stdout;
  assert.equal(watching(), "This session watches no other runs.\n");
  // Looking at an empty list does not create the directory that runs publish to.
  await assert.rejects(stat(directory), /ENOENT/u);
  await mkdir(directory);
  assert.equal(machine(directory, session, "runs", "--all").stdout, "No Machine runs are published.\n");
  const exited = spawnSync(process.execPath, ["-e", ""]).pid;
  const records: Array<Partial<RunStatusRecord>> = [
    { id: "1a2b3c4d-run", label: "org-9 → machines: Watch runs", owner: "another-session", cwd: "/work/machines" },
    { id: "5e6f7a8b-run", label: "org-90: Later", cwd: "/work/dispatch/child" },
    { id: "9c0d1e2f-run", label: "org-9: A step of the first", parent: "1a2b3c4d-run", cwd: "/work/dispatch" },
    { id: "plain-run", cwd: "/elsewhere" },
    { id: "finished-run", label: "org-9: Done", status: "completed", state: "done" },
    { id: "lost-run", pid: exited, status: "waiting", human: { prompt: "Gone?", requestId: "lost" }, cwd: "/work/dispatch" },
  ];
  for (const [index, record] of records.entries()) {
    await writeRecord(directory, { ...record, startedAt: `2026-03-04T05:06:0${index}.000Z` });
  }

  const first = machine(directory, session, "watch", "org-9");
  assert.deepEqual({ status: first.status, stderr: first.stderr, stdout: first.stdout }, {
    status: 0, stderr: "",
    // A run that finished is still published, and says so.
    stdout: "Watching org-9\n  1a2b3c4d-run\tticket\trunning\tstarting\torg-9 → machines: Watch runs\n"
      + "  finished-run\tticket\tcompleted\tdone\torg-9: Done\n",
  });
  // The path is kept absolute, wherever the command ran and however it was written.
  assert.equal(
    machine(directory, session, "watch", "--dir", "/work/dispatch/").stdout,
    "Watching --dir /work/dispatch\n  5e6f7a8b-run\tticket\trunning\tstarting\torg-90: Later\n  lost-run\tticket\tlost\tstarting\n",
  );
  // A ticket can be watched before any run of it exists.
  assert.equal(machine(directory, session, "watch", "org-7").stdout, "Watching org-7\n  no published run matches yet\n");
  assert.equal(machine(directory, session, "watch", " plain ").stdout, "Watching plain\n  plain-run\tticket\trunning\tstarting\n");
  assert.equal(machine(directory, session, "watch", "org-9").status, 0);

  const file = join(directory, ".watch.session.json");
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), {
    schemaVersion: 1,
    watches: [{ text: "org-9" }, { dir: "/work/dispatch" }, { text: "org-7" }, { text: "plain" }],
  });
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.deepEqual((await readdir(directory)).filter((name) => name.startsWith(".")), [".watch.session.json"]);
  assert.equal(readRunStatuses(directory).length, records.length);

  assert.equal(watching(), [
    "org-9", "  1a2b3c4d-run\tticket\trunning\tstarting\torg-9 → machines: Watch runs",
    "  finished-run\tticket\tcompleted\tdone\torg-9: Done",
    "--dir /work/dispatch", "  5e6f7a8b-run\tticket\trunning\tstarting\torg-90: Later", "  lost-run\tticket\tlost\tstarting",
    "org-7", "  no published run matches yet",
    "plain", "  plain-run\tticket\trunning\tstarting",
    "",
  ].join("\n"));

  // machine runs lists the runs of every session and project, so that a session can find what to watch.
  const unmarked = [
    "1a2b3c4d-run\tticket\trunning\tstarting\torg-9 → machines: Watch runs",
    "5e6f7a8b-run\tticket\trunning\tstarting\torg-90: Later",
    "9c0d1e2f-run\tticket\trunning\tstarting\torg-9: A step of the first",
    "plain-run\tticket\trunning\tstarting",
    "",
  ];
  assert.equal(machine(directory, {}, "runs").stdout, unmarked.join("\n"));
  assert.equal(machine(directory, { CLAUDE_CODE_SESSION_ID: "another-session" }, "runs").stdout, unmarked.join("\n"));
  assert.equal(machine(directory, session, "runs").stdout, [
    `${unmarked[0]}\twatched`, `${unmarked[1]}\twatched`, unmarked[2], `${unmarked[3]}\t\twatched`, "",
  ].join("\n"));
  // With --all it lists every published run: also the ones still recorded after they finished or lost their process.
  const settled = ["finished-run\tticket\tcompleted\tdone\torg-9: Done", "lost-run\tticket\tlost\tstarting"];
  assert.equal(machine(directory, {}, "runs", "--all").stdout, [...unmarked.slice(0, 4), ...settled, ""].join("\n"));
  assert.equal(machine(directory, session, "runs", "--all").stdout, [
    `${unmarked[0]}\twatched`, `${unmarked[1]}\twatched`, unmarked[2], `${unmarked[3]}\t\twatched`,
    `${settled[0]}\twatched`, `${settled[1]}\t\twatched`, "",
  ].join("\n"));
  const ids = (...args: string[]) => (JSON.parse(machine(directory, session, "runs", ...args).stdout) as RunStatusRecord[]).map((record) => record.id);
  assert.deepEqual(ids("--json"), ["1a2b3c4d-run", "5e6f7a8b-run", "9c0d1e2f-run", "plain-run"]);
  for (const args of [["--all", "--json"], ["--json", "--all"]]) {
    assert.deepEqual(ids(...args), ["1a2b3c4d-run", "5e6f7a8b-run", "9c0d1e2f-run", "plain-run", "finished-run", "lost-run"]);
  }
  assert.match(machine(directory, session, "runs", "--all", "--all").stderr, /^ {2}machine runs \[--json\] \[--all\]$/mu);

  // Each session has its own list, and MACHINES_RUN_OWNER names the session as it names a run's owner.
  const explicit = { MACHINES_RUN_OWNER: "explicit", CLAUDE_CODE_SESSION_ID: "session" };
  assert.equal(watching(explicit), "This session watches no other runs.\n");
  const relative = spawnSync(process.execPath, [resolve("src/cli.ts"), "watch", "--dir", "child"], {
    cwd: directory, encoding: "utf8", env: { PATH: process.env.PATH, MACHINES_RUN_STATUS_DIR: directory, ...explicit },
  });
  assert.equal(relative.stdout, `Watching --dir ${join(directory, "child")}\n  no published run matches yet\n`);
  assert.deepEqual(readRunWatches(directory, "explicit"), [{ dir: join(directory, "child") }]);

  assert.equal(machine(directory, session, "unwatch", "org-7").stdout, "No longer watching org-7\n");
  const again = machine(directory, session, "unwatch", "org-7");
  assert.deepEqual({ status: again.status, stdout: again.stdout }, { status: 0, stdout: "This session was not watching org-7\n" });
  assert.equal(machine(directory, session, "unwatch", "--dir", "/work/dispatch").stdout, "No longer watching --dir /work/dispatch\n");
  assert.deepEqual(readRunWatches(directory, "session"), [{ text: "org-9" }, { text: "plain" }]);
  assert.equal(machine(directory, session, "unwatch", "--all").stdout, "This session watches no other runs.\n");
  assert.equal(watching(), "This session watches no other runs.\n");
  assert.deepEqual((await readdir(directory)).filter((name) => name.startsWith(".")), [".watch.explicit.json"]);
  assert.equal(machine(directory, session, "unwatch", "--all").status, 0);
});

test("watching says why it cannot be done", async (context) => {
  const root = await temporaryDirectory(context);
  const directory = join(root, "status");
  const refused = (environment: Readonly<Record<string, string>>, ...args: string[]) => {
    const result = machine(args[0] === "off" ? "" : directory, environment, ...(args[0] === "off" ? args.slice(1) : args));
    assert.deepEqual({ status: result.status, stdout: result.stdout }, { status: 1, stdout: "" }, args.join(" "));
    return result.stderr;
  };

  for (const args of [["watch"], ["watch", "org-9"], ["unwatch", "org-9"], ["unwatch", "--all"]]) {
    assert.match(refused(session, "off", ...args), /^Run status publication is off: set MACHINES_RUN_STATUS_DIR /u);
    assert.match(refused({}, ...args), /^No session to watch for: set MACHINES_RUN_OWNER /u);
    // The session id becomes part of a file name.
    for (const id of ["../escaped", "nested/session", ".hidden"]) {
      assert.match(refused({ MACHINES_RUN_OWNER: id }, ...args), /^Session id ".*" cannot name a watch list/u);
    }
  }
  for (const text of ["", "  ", "--", "\n"]) {
    assert.match(refused(session, "watch", ...(text === "--" ? ["--"] : ["--", text])), /^Expected the start of a run id or label/u);
  }
  // A line break at either end is still a second line, not space to trim.
  for (const text of ["org-9\norg-10", "org-9\n", "\norg-9", "org-9\r\n", " org-9 \n "]) {
    assert.match(refused(session, "watch", "--", text), /^A watch is one line/u, JSON.stringify(text));
    assert.match(refused(session, "unwatch", "--", text), /^A watch is one line/u, JSON.stringify(text));
  }
  assert.match(refused(session, "watch", "--dir"), /^Usage: machine watch \[<run-id-or-label-start> \| --dir <path>\]\n$/u);
  assert.match(refused(session, "watch", "--dir", "/a", "/b"), /^Usage: machine watch /u);
  assert.match(refused(session, "watch", "--all"), /^Usage: machine watch /u);
  assert.match(refused(session, "unwatch", "--all", "org-9"), /^Usage: machine unwatch /u);
  assert.match(refused(session, "unwatch", "--dir"), /^Usage: machine unwatch <run-id-or-label-start> \| --dir <path> \| --all\n$/u);
  const usage = refused(session, "unwatch");
  assert.match(usage, /^ {2}machine watch \[<run-id-or-label-start> \| --dir <path>\]$/mu);
  assert.match(usage, /^ {2}machine unwatch <run-id-or-label-start> \| --dir <path> \| --all$/mu);
  assert.deepEqual(await readdir(root), []);

  // Text that looks like an option is watched after "--".
  assert.equal(machine(directory, session, "watch", "--", "--dir").stdout, "Watching --dir\n  no published run matches yet\n");
  assert.deepEqual(readRunWatches(directory, "session"), [{ text: "--dir" }]);
  assert.deepEqual(await readdir(root), ["status"]);
});

test("a watch names runs by the start of their id, by a whole leading part of their label, or by where they work", () => {
  const now = Date.parse("2026-03-04T05:06:07.000Z");
  const cases: Array<[RunWatch, Partial<RunStatusRecord>, boolean]> = [
    [{ text: "org-9" }, { label: "org-9 → machines: Watch runs" }, true],
    [{ text: "org-9" }, { label: "org-9: Watch runs" }, true],
    [{ text: "org-9" }, { label: "org-9" }, true],
    [{ text: "org-9" }, { label: "org-9.1 Watch runs" }, true],
    [{ text: "org-9" }, { label: "org-90 Watch runs" }, false],
    [{ text: "org-9" }, { label: "org-9a: Watch runs" }, false],
    [{ text: "org-9" }, { label: "org-9-fix: Watch runs" }, false],
    [{ text: "org-9" }, { label: "org-9_fix: Watch runs" }, false],
    [{ text: "org-9" }, { label: "org-9é: Watch runs" }, false],
    [{ text: "org-9" }, { label: "For org-9: Watch runs" }, false],
    [{ text: "org-9" }, { label: "ORG-9: Watch runs" }, false],
    [{ text: "org-9" }, {}, false],
    [{ text: "org" }, { label: "org-9: Watch runs" }, false],
    [{ text: "org-9:" }, { label: "org-9: Watch runs" }, true],
    [{ text: "org-9 → machines" }, { label: "org-9 → machines: Watch runs" }, true],
    [{ text: "org-9 → machines" }, { label: "org-9 → machines-dispatch: Watch runs" }, false],
    // An id is matched by any prefix, as the status line shows only its start.
    [{ text: "1a2b3c4d" }, { id: "1a2b3c4d-0000-4000-8000-000000000000" }, true],
    [{ text: "1a2b3c4d-0000-4000-8000-000000000000" }, { id: "1a2b3c4d-0000-4000-8000-000000000000" }, true],
    [{ text: "a2b3" }, { id: "1a2b3c4d-0000-4000-8000-000000000000" }, false],
    [{ text: "org-9" }, { id: "org-90" }, true],
    [{ dir: "/work/other" }, { cwd: "/work/other" }, true],
    [{ dir: "/work/other" }, { cwd: "/work/other/packages/child" }, true],
    [{ dir: "/work/other" }, { cwd: "/work/other-project" }, false],
    [{ dir: "/work/other" }, { cwd: "/work" }, false],
    [{ dir: "/work/other" }, { cwd: "other" }, false],
    [{ dir: "/" }, { cwd: "/anywhere/at/all" }, true],
    // A sub-run is its parent's detail however it is named.
    [{ text: "org-9" }, { label: "org-9: Watch runs", parent: "outer-run" }, false],
    [{ text: "run" }, { parent: "outer-run" }, false],
    [{ dir: "/work/other" }, { cwd: "/work/other", parent: "outer-run" }, false],
  ];
  for (const [watch, change, expected] of cases) {
    const record: RunStatusRecord = {
      schemaVersion: 2, id: "run", pid: 1, owner: "another-session", machine: "ticket", path: "/work/ticket.ts",
      cwd: "/elsewhere", status: "running", startedAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(),
      ...change,
    };
    const described = `${JSON.stringify(watch)} ${JSON.stringify(change)}`;
    assert.equal(runWatchMatches(watch, record), expected, described);
    // The status line decides for itself, without this module, and must agree.
    const shown = runStatusLines([record], {
      now, sessionId: "session", projectDir: "/work/project", color: false, isAlive: () => true, watches: [watch],
    });
    assert.equal(shown.length > 0, expected, described);
  }
});

test("a watch list that cannot be read watches nothing, and writing one forgets lists left by old sessions", async (context) => {
  const directory = await temporaryDirectory(context);
  const file = runWatchPath(directory, "session");
  assert.deepEqual(readRunWatches(directory, "session"), []);
  assert.deepEqual(readRunWatches(join(directory, "missing"), "session"), []);
  for (const text of ["{", "", "null", "[]", "7", '{"watches":"org-9"}', '{"schemaVersion":1}']) {
    await writeFile(file, text);
    assert.deepEqual(readRunWatches(directory, "session"), [], text);
    assert.equal(machine(directory, session, "watch").stdout, "This session watches no other runs.\n", text);
  }
  // An entry this version does not understand is passed over, and the rest still count.
  await writeFile(file, JSON.stringify({
    schemaVersion: 1,
    watches: [{ text: "org-9" }, { text: 7 }, { text: "" }, "org-8", null, { dir: "relative" }, { text: "a", dir: "/b" },
      { dir: "/work/other/" }, { machine: "ticket" }],
  }));
  assert.deepEqual(readRunWatches(directory, "session"), [{ text: "org-9" }, { dir: "/work/other" }]);

  // A session id that could leave the directory names no list at all.
  await mkdir(join(directory, ".watch.nested"));
  await writeFile(join(directory, ".watch.nested", "session.json"), JSON.stringify({ watches: [{ text: "org-9" }] }));
  assert.deepEqual(readRunWatches(directory, "nested/session"), []);
  assert.throws(() => writeRunWatches(directory, "nested/session", [{ text: "org-9" }]), /cannot name a watch list/u);
  assert.throws(() => writeRunWatches(directory, "", []), /cannot name a watch list/u);

  const day = 24 * 60 * 60 * 1_000;
  const aged = async (name: string, days: number) => {
    await writeFile(join(directory, name), name.startsWith(".watch.") ? JSON.stringify({ watches: [{ text: "org-1" }] }) : "{}");
    const then = new Date(Date.now() - days * day);
    await utimes(join(directory, name), then, then);
  };
  await aged(".watch.forgotten.json", 31);
  await aged(".watch.dormant.json", 29);
  await aged(".watch.session.json", 31);
  // Only watch lists are pruned here; records and responses have their own rules.
  await aged("old-run.json", 31);
  await aged("old-run.inbox", 31);
  await aged(".old-run.8b5f0b0e.inbox.sent", 31);
  await aged(".watch.txt", 31);

  // Removing an entry rewrites the list too.
  assert.equal(machine(directory, session, "watch", "org-9").status, 0);
  assert.deepEqual((await readdir(directory)).sort(), [
    ".old-run.8b5f0b0e.inbox.sent", ".watch.dormant.json", ".watch.nested", ".watch.session.json", ".watch.txt",
    "old-run.inbox", "old-run.json",
  ]);
  assert.deepEqual(readRunWatches(directory, "session"), [{ text: "org-1" }, { text: "org-9" }]);
  assert.deepEqual(readRunWatches(directory, "dormant"), [{ text: "org-1" }]);
});

function machine(directory: string, environment: Readonly<Record<string, string>>, ...args: string[]) {
  return spawnSync(process.execPath, [resolve("src/cli.ts"), ...args], {
    encoding: "utf8", env: { PATH: process.env.PATH, MACHINES_RUN_STATUS_DIR: directory, ...environment },
  });
}

async function writeRecord(directory: string, change: Partial<RunStatusRecord>): Promise<void> {
  const now = new Date().toISOString();
  const record = {
    schemaVersion: 2, id: "run", pid: process.pid, machine: "ticket", path: "/work/.machines/ticket.ts", cwd: "/work",
    status: "running", startedAt: now, updatedAt: now, ...change,
  };
  await writeFile(join(directory, `${record.id}.json`), JSON.stringify(record));
}

async function temporaryDirectory(context: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "machines-run-watch-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
