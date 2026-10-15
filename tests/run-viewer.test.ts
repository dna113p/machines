import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, type TestContext } from "node:test";

import { runStatusLines } from "../claude/statusline.mjs";
import { createRunStatusPublisher } from "../src/run-status.ts";
import {
  readRunStatuses,
  readRunWatches,
  runSessionId,
  runsForViewer,
  settledRunVisibleMilliseconds,
  type RunStatusRecord,
  type RunViewer,
  type RunWatch,
  type ViewerRun,
} from "../src/run-viewer.ts";

const now = Date.parse("2026-03-04T05:06:07.000Z");
const viewer: RunViewer = { sessionId: "session", projectDir: "/work/project" };
const alive = { now, isAlive: () => true };

test("a viewer shows the runs its session owns, unowned runs inside its project, and the runs it watches", () => {
  const shown = (change: Partial<RunStatusRecord>, seen: RunViewer = viewer) =>
    runsForViewer([record(change)], seen, alive).map((run) => run.shown);

  // Each reason alone.
  assert.deepEqual(shown({ owner: "session", cwd: "/elsewhere" }), ["owned"]);
  assert.deepEqual(shown({ cwd: "/work/project" }), ["project"]);
  assert.deepEqual(shown({ cwd: "/work/project/packages/child" }), ["project"]);
  assert.deepEqual(shown({ cwd: "/work/project" }, { ...viewer, projectDir: "/work/project/" }), ["project"]);
  assert.deepEqual(shown({ owner: "another", cwd: "/elsewhere", label: "org-9: Theirs" }, { ...viewer, watches: [{ text: "org-9" }] }), ["watched"]);
  assert.deepEqual(shown({ cwd: "/elsewhere/child" }, { ...viewer, watches: [{ dir: "/elsewhere" }] }), ["watched"]);

  // Another session's run is hidden wherever it works, unless it is watched.
  assert.deepEqual(shown({ owner: "another", cwd: "/work/project" }), []);
  assert.deepEqual(shown({ owner: "another", cwd: "/work/project" }, { ...viewer, watches: [{ dir: "/work/project" }] }), ["watched"]);
  // Without a project only owned and watched runs are selected.
  assert.deepEqual(shown({ cwd: "/work/project" }, { sessionId: "session" }), []);
  assert.deepEqual(shown({ cwd: "/work/project" }, { sessionId: "session", projectDir: "work/project" }), []);
  assert.deepEqual(shown({ cwd: "/work/project-other" }), []);
  assert.deepEqual(shown({ cwd: "/work" }), []);
  assert.deepEqual(shown({ cwd: "project" }), []);
  // A watched directory is compared as a project directory is, however it was written.
  assert.deepEqual(shown({ cwd: "/elsewhere" }, { ...viewer, watches: [{ dir: "/elsewhere/" }] }), ["watched"]);
  assert.deepEqual(shown({ cwd: "elsewhere" }, { ...viewer, watches: [{ dir: "elsewhere" }] }), []);

  // A sub-run is its parent's detail whatever would otherwise show it.
  const everything: RunViewer = { ...viewer, watches: [{ text: "run" }, { dir: "/work" }] };
  assert.deepEqual(shown({ owner: "session", parent: "outer-run" }, everything), []);
  assert.deepEqual(shown({ cwd: "/work/project", parent: "outer-run" }, everything), []);

  // Several reasons still show one run, under the first reason that holds.
  const combined: RunViewer = { ...viewer, watches: [{ text: "run" }, { dir: "/work/project" }, { text: "run" }, { text: "org-9" }] };
  assert.deepEqual(shown({ owner: "session", cwd: "/work/project", label: "org-9: Mine" }, combined), ["owned"]);
  assert.deepEqual(shown({ cwd: "/work/project", label: "org-9: Unowned" }, combined), ["project"]);
  assert.deepEqual(shown({ owner: "another", cwd: "/work/project", label: "org-9: Theirs" }, combined), ["watched"]);
  const records = [
    record({ id: "mine", owner: "session" }), record({ id: "unowned" }), record({ id: "theirs", owner: "another" }),
    record({ id: "hidden", owner: "another", cwd: "/elsewhere" }),
  ];
  const runs = runsForViewer(records, { ...viewer, watches: [{ dir: "/work/project" }, { text: "mine" }, { text: "theirs" }] }, alive);
  assert.deepEqual(runs.map((run) => [run.id, run.shown]), [["mine", "owned"], ["unowned", "project"], ["theirs", "watched"]]);
});

test("a viewer's run is its record with its effective status and how its request is answered", () => {
  const published = record({
    id: "1a2b3c4d", owner: "session", label: "org-9: Release", state: "approve", stateSince: ago(5_000),
    status: "waiting", human: { prompt: "Publish?", requestId: "request-1", choices: ["publish", "hold"] },
    limit: { text: "waiting for a reset" }, deliveries: ["delivery"], updatedAt: ago(1_000),
  });
  // Nothing of the record is changed or dropped, and nothing is added for presentation.
  assert.deepEqual(runsForViewer([published], viewer, alive), [{
    ...published, shown: "owned", answer: { via: "respond", runId: "1a2b3c4d", requestId: "request-1" },
  }]);
  assert.deepEqual(Object.keys(runsForViewer([published], viewer, alive)[0]!), [...Object.keys(published), "shown", "answer"]);

  const answer = (change: Partial<RunStatusRecord>, isAlive = () => true) =>
    runsForViewer([{ ...published, ...change }], viewer, { now, isAlive })[0]!.answer;
  // A run answered through its host has no request id to give machine respond.
  assert.deepEqual(answer({ answeredBy: "host", human: { prompt: "Publish?" } }), { via: "host" });
  assert.deepEqual(answer({ answeredBy: "host" }), { via: "host" });
  // A record from before requests had ids, and a run that is not waiting on one, have nothing to answer.
  assert.equal(answer({ schemaVersion: 1, human: { prompt: "Publish?" } }), undefined);
  assert.equal(answer({ human: undefined }), undefined);
  assert.equal(answer({ status: "running" }), undefined);
  assert.equal(answer({ status: "completed" }), undefined);
  assert.equal(answer({}, () => false), undefined);
});

test("a run recorded as running or waiting whose process is gone is lost", () => {
  const options = { now, isAlive: (pid: number) => pid !== 4242 };
  const statuses = (records: RunStatusRecord[]) => runsForViewer(records, viewer, options).map((run) => [run.id, run.status]);
  assert.deepEqual(statuses([
    record({ id: "live", pid: 1 }),
    record({ id: "lost-running", pid: 4242, updatedAt: ago(1_000) }),
    record({ id: "lost-waiting", pid: 4242, status: "waiting", human: { prompt: "Gone?", requestId: "request" }, updatedAt: ago(2_000) }),
    // A run that settled says how; its process is expected to be gone.
    record({ id: "completed", pid: 4242, status: "completed", updatedAt: ago(3_000) }),
    record({ id: "failed", pid: 4242, status: "failed", error: "boom", updatedAt: ago(4_000) }),
  ]), [["live", "running"], ["lost-running", "lost"], ["lost-waiting", "lost"], ["completed", "completed"], ["failed", "failed"]]);

  // The default probe asks the operating system.
  const exited = spawnSync(process.execPath, ["-e", ""]).pid;
  const probed = runsForViewer([record({ id: "gone", pid: exited }), record({ id: "here", pid: process.pid })], viewer, { now });
  assert.deepEqual(probed.map((run) => [run.id, run.status]), [["here", "running"], ["gone", "lost"]]);
});

test("a settled or lost run stays for thirty seconds, and all keeps it for as long as it is recorded", () => {
  assert.equal(settledRunVisibleMilliseconds, 30_000);
  const options = { now, isAlive: (pid: number) => pid !== 4242 };
  const records = [
    record({ id: "old-run", startedAt: ago(7_200_000), updatedAt: ago(7_200_000) }),
    record({ id: "old-wait", status: "waiting", startedAt: ago(7_200_000), updatedAt: ago(3_600_000) }),
    record({ id: "done-30", status: "completed", updatedAt: ago(30_000) }),
    record({ id: "done-31", status: "completed", updatedAt: ago(30_001) }),
    record({ id: "fail-29", status: "failed", updatedAt: ago(29_999) }),
    record({ id: "fail-31", status: "failed", updatedAt: ago(31_000) }),
    record({ id: "lost-30", pid: 4242, updatedAt: ago(30_000) }),
    record({ id: "lost-31", pid: 4242, status: "waiting", updatedAt: ago(30_001) }),
  ];
  const ids = (all?: boolean) => runsForViewer(records, viewer, { ...options, ...(all === undefined ? {} : { all }) }).map((run) => run.id);
  // A run that can still change stays however long it has been quiet.
  assert.deepEqual(ids(), ["old-wait", "old-run", "fail-29", "done-30", "lost-30"]);
  assert.deepEqual(ids(false), ids());
  assert.deepEqual(ids(true), ["old-wait", "old-run", "fail-29", "done-30", "lost-30", "done-31", "lost-31", "fail-31"]);
  // The clock is the caller's: a moment later the runs at the boundary have dropped out.
  assert.deepEqual(runsForViewer(records, viewer, { ...options, now: now + 1 }).map((run) => run.id), ["old-wait", "old-run", "fail-29"]);
});

test("runs that can still change come first, then the most recently updated, and ties keep their order", () => {
  const records = [
    record({ id: "done-new", status: "completed", updatedAt: ago(1_000) }),
    record({ id: "run-old", updatedAt: ago(90_000) }),
    record({ id: "lost-mid", pid: 4242, updatedAt: ago(3_000) }),
    record({ id: "wait-new", status: "waiting", updatedAt: ago(2_000) }),
    record({ id: "fail-mid", status: "failed", updatedAt: ago(5_000) }),
    record({ id: "run-mid", updatedAt: ago(40_000) }),
    record({ id: "tie-first", updatedAt: ago(40_000) }),
    record({ id: "done-mid", status: "completed", updatedAt: ago(4_000) }),
    record({ id: "tie-second", status: "waiting", updatedAt: ago(40_000) }),
  ];
  const options = { now, isAlive: (pid: number) => pid !== 4242 };
  const expected = ["wait-new", "run-mid", "tie-first", "tie-second", "run-old", "done-new", "lost-mid", "done-mid", "fail-mid"];
  assert.deepEqual(runsForViewer(records, viewer, options).map((run) => run.id), expected);
  // Nothing is cut off: how many runs fit is the widget's to decide.
  assert.equal(runsForViewer(records, viewer, options).length, records.length);
  // The records are the caller's and are left as they were given.
  assert.deepEqual(records.map((run) => run.id).slice(0, 2), ["done-new", "run-old"]);
});

test("the status line's own copy of the rule shows the same runs in the same order", () => {
  // The status line cannot load the runtime, so it selects for itself: every
  // combination below must give the two the same runs, statuses, and order.
  const owners = ["session", "another", undefined];
  const directories = ["/work/project", "/work/project/packages/child", "/work/project-other", "/elsewhere/child", "project"];
  const statuses = ["running", "waiting", "completed", "failed"] as const;
  const ages = [0, settledRunVisibleMilliseconds - 1, settledRunVisibleMilliseconds, settledRunVisibleMilliseconds + 1, 3_600_000];
  const pool: RunStatusRecord[] = [];
  for (const owner of owners) for (const cwd of directories) for (const status of statuses) {
    for (const pid of [1, 4242]) for (const age of ages) for (const parent of [undefined, "outer-run"]) {
      const index = pool.length;
      const id = `r${String(index).padStart(4, "0")}`;
      pool.push(record({
        id, pid, cwd, status, updatedAt: ago(age), startedAt: ago(age + 60_000),
        ...(owner === undefined ? {} : { owner }),
        ...(parent === undefined ? {} : { parent }),
        // Some runs say what they are for, with a label one watch names and one it does not.
        ...(index % 3 === 0 ? { label: `${index % 2 === 0 ? "org-9" : "org-90"}: ${id}` } : {}),
        ...(status === "waiting" ? { human: { prompt: "Approve?", requestId: `request-${id}` } } : {}),
      }));
    }
  }
  const labels = new Map(pool.flatMap((run) => run.label === undefined ? [] : [[run.label, run.id] as const]));
  // Neighbours in the pool differ in one field; a stride mixes them so that each small group is varied.
  const mixed = pool.map((_, index) => pool[(index * 7) % pool.length]!);
  assert.equal(new Set(mixed).size, pool.length);
  const groups: RunStatusRecord[][] = [pool, mixed, mixed.slice(0, 40)];
  for (let start = 0; start < mixed.length; start += 5) groups.push(mixed.slice(start, start + 5));

  const viewers: RunViewer[] = [
    { sessionId: "session" },
    { sessionId: "session", projectDir: "/work/project" },
    { sessionId: "session", projectDir: "/work/project/" },
    { sessionId: "another", projectDir: "/work/project/packages" },
    { sessionId: "third", projectDir: "work/project" },
  ];
  const lists: RunWatch[][] = [
    [], [{ text: "org-9" }], [{ text: "r00" }], [{ dir: "/elsewhere" }], [{ dir: "/work/project/" }],
    [{ text: "org-90" }, { dir: "/elsewhere/child" }, { text: "r0010" }, { text: "org-90" }], [{ dir: "elsewhere" }],
  ];
  const symbols = { running: "●", waiting: "◆", sleeping: "●", completed: "✓", failed: "✕", lost: "✕" } satisfies Record<ViewerRun["status"], string>;
  const isAlive = (pid: number) => pid !== 4242;
  let compared = 0;
  let shown = 0;
  for (const records of groups) for (const seen of viewers) for (const watches of lists) for (const clock of [now, now + 1, now + 30_000]) {
    const expected = runsForViewer(records, { ...seen, watches }, { now: clock, isAlive });
    const lines = runStatusLines(records, { ...seen, watches, now: clock, isAlive, color: false, columns: 400 });
    const overflow = /^… (\d+) more$/u.exec(lines.at(-1) ?? "");
    const drawn = lines.filter((line) => !line.startsWith("  ") && !line.startsWith("…")).map((line) => {
      // A labelled run leads with its label and an unlabelled one with its id, then two spaces.
      const text = line.slice(2);
      return `${line[0]} ${labels.get(text) ?? text.split("  ")[0]}`;
    });
    const described = JSON.stringify({ first: records[0]!.id, count: records.length, seen, watches, clock: clock - now });
    // The status line draws the first five and counts the rest.
    assert.deepEqual(drawn, expected.slice(0, 5).map((run) => `${symbols[run.status]} ${run.id}`), described);
    assert.equal(overflow === null ? 0 : Number(overflow[1]), Math.max(0, expected.length - 5), described);
    compared += 1;
    shown += expected.length;
  }
  // The comparison is of real selections, not of two empty answers.
  assert.equal(compared, groups.length * viewers.length * lists.length * 3);
  assert.ok(shown > compared, `${shown} runs shown in ${compared} comparisons`);
});

test("a session is named by MACHINES_RUN_OWNER, then by what Claude Code, Codex, and Pi give the commands they start", async (context) => {
  const named = { MACHINES_RUN_OWNER: "owner", CLAUDE_CODE_SESSION_ID: "claude", CODEX_THREAD_ID: "codex", PI_SESSION_ID: "pi" };
  const without = (...names: Array<keyof typeof named>) =>
    Object.fromEntries(Object.entries(named).filter(([name]) => !names.includes(name as keyof typeof named)));
  assert.equal(runSessionId(named), "owner");
  assert.equal(runSessionId({ ...named, MACHINES_RUN_OWNER: "" }), "claude");
  assert.equal(runSessionId(without("MACHINES_RUN_OWNER")), "claude");
  assert.equal(runSessionId(without("MACHINES_RUN_OWNER", "CLAUDE_CODE_SESSION_ID")), "codex");
  assert.equal(runSessionId(without("MACHINES_RUN_OWNER", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID")), "pi");
  assert.equal(runSessionId({ CODEX_THREAD_ID: "", PI_SESSION_ID: "" }), undefined);
  assert.equal(runSessionId({}), undefined);

  // The same rule names the owner of a run and the session whose list machine watch changes.
  const directory = await temporaryDirectory(context);
  const run = { machine: "ticket", path: "/work/.machines/ticket.ts", cwd: "/work" };
  createRunStatusPublisher({ ...run, id: "from-codex" }, { MACHINES_RUN_STATUS_DIR: directory, CODEX_THREAD_ID: "codex" });
  createRunStatusPublisher({ ...run, id: "from-pi" }, { MACHINES_RUN_STATUS_DIR: directory, PI_SESSION_ID: "pi" });
  assert.deepEqual(
    Object.fromEntries(readRunStatuses(directory).map((published) => [published.id, published.owner])),
    { "from-codex": "codex", "from-pi": "pi" },
  );
  for (const [variable, session] of [["CODEX_THREAD_ID", "codex"], ["PI_SESSION_ID", "pi"]] as const) {
    assert.equal(machine(directory, { [variable]: session }, "watch", "org-9").stdout, "Watching org-9\n  no published run matches yet\n");
    assert.deepEqual(readRunWatches(directory, session), [{ text: "org-9" }]);
    assert.deepEqual(
      (JSON.parse(machine(directory, { [variable]: session }, "runs", "--for", "--json").stdout) as ViewerRun[]).map((shown) => shown.id),
      [`from-${session}`],
    );
  }
});

test("machine runs --for lists the runs one viewer shows, as text and as JSON", async (context) => {
  const root = await temporaryDirectory(context);
  const directory = join(root, "status");
  const project = join(root, "project");
  await mkdir(directory);
  const exited = spawnSync(process.execPath, ["-e", ""]).pid;
  const past = (milliseconds: number) => new Date(Date.now() - milliseconds).toISOString();
  const records: Array<Partial<RunStatusRecord>> = [
    {
      id: "mine", owner: "viewer", cwd: "/elsewhere", status: "waiting", state: "approve", updatedAt: past(1_000),
      human: { prompt: "Publish?", requestId: "request-1", choices: ["publish", "hold"] },
    },
    { id: "hosted", owner: "viewer", cwd: "/elsewhere", status: "waiting", answeredBy: "host", human: { prompt: "Approve?" }, updatedAt: past(2_000) },
    { id: "in-project", cwd: join(project, "packages", "child"), updatedAt: past(3_000) },
    { id: "beside-project", cwd: `${project}-other`, updatedAt: past(3_500) },
    { id: "theirs", owner: "another", label: "org-9: Theirs", cwd: "/elsewhere", updatedAt: past(4_000) },
    { id: "sub-run", owner: "viewer", parent: "mine", updatedAt: past(500) },
    { id: "done-old", owner: "viewer", status: "completed", state: "done", updatedAt: past(600_000) },
    { id: "lost-old", owner: "viewer", pid: exited, status: "waiting", human: { prompt: "Gone?", requestId: "lost" }, updatedAt: past(700_000) },
  ];
  for (const [index, change] of records.entries()) {
    await writeRecord(directory, { ...change, startedAt: `2026-03-04T05:06:0${index}.000Z` });
  }
  const shown = (environment: Readonly<Record<string, string>>, ...args: string[]) => {
    const listed = machine(directory, environment, "runs", ...args, "--json");
    assert.equal(listed.status, 0, listed.stderr);
    return (JSON.parse(listed.stdout) as ViewerRun[]).map((run) => `${run.id} ${run.status} ${run.shown}`);
  };
  const own = ["mine waiting owned", "hosted waiting owned"];

  // An explicit session needs nothing in the environment; without a project only owned and watched runs are selected.
  assert.deepEqual(shown({}, "--for", "viewer"), own);
  assert.deepEqual(shown({ CLAUDE_CODE_SESSION_ID: "another" }, "--for", "viewer"), own);
  // With no session after it, --for means this process's own, by the rule that names a run's owner.
  assert.deepEqual(shown({ MACHINES_RUN_OWNER: "viewer" }, "--for"), own);
  assert.deepEqual(shown({ CLAUDE_CODE_SESSION_ID: "viewer" }, "--for"), own);
  assert.deepEqual(shown({ MACHINES_RUN_OWNER: "viewer", CLAUDE_CODE_SESSION_ID: "another" }, "--for", "--project", project), [
    ...own, "in-project running project",
  ]);
  assert.deepEqual(shown({ MACHINES_RUN_OWNER: "another" }, "--for"), ["theirs running owned"]);
  assert.deepEqual(shown({}, "--for", "nobody"), []);
  assert.equal(machine(directory, {}, "runs", "--for", "nobody").stdout, "Session nobody shows no Machine runs.\n");

  // The project directory is compared absolute, wherever the command ran and however the path was written.
  assert.deepEqual(shown({}, "--for", "viewer", "--project", project), [...own, "in-project running project"]);
  assert.deepEqual(shown({}, "--project", `${project}/`, "--for", "viewer"), [...own, "in-project running project"]);
  assert.deepEqual(shown({}, "--for", "viewer", "--project", join(project, "packages", "child", "deeper")), own);
  assert.deepEqual(shown({}, "--for", "viewer", "--project", join(root, "elsewhere")), own);
  assert.deepEqual(shown({}, "--for", "nobody", "--project", root), ["in-project running project", "beside-project running project"]);
  const relative = spawnSync(process.execPath, [resolve("src/cli.ts"), "runs", "--for", "viewer", "--project", "project", "--json"], {
    cwd: root, encoding: "utf8", env: { PATH: process.env.PATH, MACHINES_RUN_STATUS_DIR: directory },
  });
  assert.deepEqual((JSON.parse(relative.stdout) as ViewerRun[]).map((run) => run.id), ["mine", "hosted", "in-project"]);

  // What the viewer watches is read from its own list, whoever asks.
  assert.equal(machine(directory, {}, "watch", "--for", "viewer", "org-9").status, 0);
  const watching = [...own, "in-project running project", "theirs running watched"];
  assert.deepEqual(shown({}, "--for", "viewer", "--project", project), watching);
  assert.deepEqual(shown({}, "--for", "another", "--project", project), ["in-project running project", "theirs running owned"]);

  // A run that just settled, or just lost its process, is still shown; older ones only with --all.
  await writeRecord(directory, { id: "done-new", owner: "viewer", status: "completed", state: "done", startedAt: "2026-03-04T05:06:08.000Z" });
  await writeRecord(directory, {
    id: "lost-new", owner: "viewer", pid: exited, status: "waiting", human: { prompt: "Gone?", requestId: "lost" },
    startedAt: "2026-03-04T05:06:09.000Z", updatedAt: past(5_000),
  });
  const listed = machine(directory, {}, "runs", "--for", "viewer", "--project", project, "--json");
  const runs = JSON.parse(listed.stdout) as ViewerRun[];
  assert.deepEqual(runs.map((run) => `${run.id} ${run.status} ${run.shown}`), [...watching, "done-new completed owned", "lost-new lost owned"]);
  assert.match(listed.stdout, /^\[\n {2}\{\n {4}"schemaVersion": 2,\n/u);
  // Each item is the published record, with its effective status, why it is shown, and how its request is answered.
  const published = new Map(readRunStatuses(directory).map((run) => [run.id, run]));
  assert.deepEqual(runs.map(({ shown: _shown, answer: _answer, ...run }) => run), [
    published.get("mine"), published.get("hosted"), published.get("in-project"), published.get("theirs"), published.get("done-new"),
    { ...published.get("lost-new"), status: "lost" },
  ]);
  assert.deepEqual(runs.map((run) => run.answer), [
    { via: "respond", runId: "mine", requestId: "request-1" }, { via: "host" }, undefined, undefined, undefined, undefined,
  ]);
  assert.deepEqual(runs.map((run) => "answer" in run), [true, true, false, false, false, false]);

  // Without --json the same runs, in the same order, in the columns machine runs always printed.
  const text = machine(directory, {}, "runs", "--project", project, "--for", "viewer");
  assert.deepEqual({ status: text.status, stderr: text.stderr }, { status: 0, stderr: "" });
  assert.equal(text.stdout, [
    "mine\tticket\twaiting\tapprove",
    "  Publish?",
    "  request: request-1",
    "  choices: publish, hold",
    "hosted\tticket\twaiting\tstarting",
    "  Approve?",
    "  answered through its host",
    "in-project\tticket\trunning\tstarting",
    "theirs\tticket\trunning\tstarting\torg-9: Theirs\twatched",
    "done-new\tticket\tcompleted\tdone",
    "lost-new\tticket\tlost\tstarting",
    "",
  ].join("\n"));

  const everything = [...watching, "done-new completed owned", "lost-new lost owned", "done-old completed owned", "lost-old lost owned"];
  assert.deepEqual(shown({}, "--for", "viewer", "--project", project, "--all"), everything);
  assert.deepEqual(shown({}, "--all", "--for", "viewer", "--project", project), everything);
  assert.match(machine(directory, {}, "runs", "--for", "viewer", "--all").stdout, /^done-old\tticket\tcompleted\tdone\nlost-old\tticket\tlost\tstarting\n$/mu);
  // A sub-run is never a viewer's, and the rest of the directory is as it was.
  assert.equal(everything.some((run) => run.startsWith("sub-run")), false);
  assert.deepEqual((await readdir(directory)).filter((name) => name.startsWith(".")), [".watch.viewer.json"]);

  // Without --for the listing is of every session and project, as records and nothing more.
  const all = machine(directory, { MACHINES_RUN_OWNER: "viewer" }, "runs", "--json");
  assert.deepEqual(JSON.parse(all.stdout), readRunStatuses(directory)
    .filter((run) => run.status !== "completed" && run.pid !== exited)
    .sort((left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt)));
  assert.deepEqual(
    (JSON.parse(all.stdout) as RunStatusRecord[]).map((run) => run.id),
    ["mine", "hosted", "in-project", "beside-project", "theirs", "sub-run"],
  );
  assert.doesNotMatch(all.stdout, /"shown"|"answer"/u);
  assert.equal(machine(directory, { MACHINES_RUN_OWNER: "viewer" }, "runs").stdout, [
    "mine\tticket\twaiting\tapprove", "  Publish?", "  request: request-1", "  choices: publish, hold",
    "hosted\tticket\twaiting\tstarting", "  Approve?", "  answered through its host",
    "in-project\tticket\trunning\tstarting",
    "beside-project\tticket\trunning\tstarting",
    "theirs\tticket\trunning\tstarting\torg-9: Theirs\twatched",
    "sub-run\tticket\trunning\tstarting",
    "",
  ].join("\n"));
});

test("machine runs --for orders runs updated together as the library and the status line script do", async (context) => {
  const directory = await temporaryDirectory(context);
  const updated = Date.now() - 1_000;
  const ids = ["aaaa", "zzzz", "mmmm", "bbbb"];
  const published = (id: string, startedAt: number, change: Partial<RunStatusRecord> = {}) => writeRecord(directory, {
    id, owner: "viewer", updatedAt: new Date(updated).toISOString(), startedAt: new Date(startedAt).toISOString(), ...change,
  });
  for (const id of ids) await published(id, updated);
  // The directory gives its records in an order of its own. Start times that run
  // against it would show a listing that sorted by them before it selected.
  const order = readRunStatuses(directory).map((run) => run.id);
  for (const [index, id] of order.entries()) await published(id, updated - index * 60_000);
  // One run that can still be told apart by its update, and one that settled, around the four that tie.
  await published("newer", updated - 600_000, { updatedAt: new Date(updated + 500).toISOString() });
  await published("done", updated - 900_000, { status: "completed", state: "done" });

  const read = readRunStatuses(directory);
  const tied = read.map((run) => run.id).filter((id) => ids.includes(id));
  const byStart = [...read].sort((left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt)).map((run) => run.id);
  assert.deepEqual(byStart.filter((id) => ids.includes(id)), [...tied].reverse());

  const expected = runsForViewer(read, { sessionId: "viewer", watches: [] }).map((run) => run.id);
  assert.deepEqual(expected, ["newer", ...tied, "done"]);
  for (const args of [["--for", "viewer"], ["--for", "viewer", "--all"], ["--for", "viewer", "--project", "/elsewhere"]]) {
    const listed = machine(directory, {}, "runs", ...args, "--json");
    assert.equal(listed.status, 0, listed.stderr);
    assert.deepEqual((JSON.parse(listed.stdout) as ViewerRun[]).map((run) => run.id), expected, args.join(" "));
  }
  const text = machine(directory, {}, "runs", "--for", "viewer");
  assert.deepEqual(text.stdout.trimEnd().split("\n").map((line) => line.split("\t")[0]), expected);

  // The status line script reads the same directory for the same session; it draws the first five.
  const line = spawnSync(process.execPath, [resolve("claude/statusline.mjs")], {
    input: JSON.stringify({ session_id: "viewer", cwd: "/elsewhere" }), encoding: "utf8",
    env: { PATH: process.env.PATH, MACHINES_RUN_STATUS_DIR: directory, NO_COLOR: "1", COLUMNS: "400" },
  });
  assert.equal(line.status, 0, line.stderr);
  const drawn = line.stdout.trimEnd().split("\n").filter((shown) => !shown.startsWith("  ") && !shown.startsWith("…"));
  assert.deepEqual(drawn.map((shown) => shown.slice(2).split("  ")[0]), expected.slice(0, 5));
  assert.match(line.stdout, /^… 1 more$/mu);

  // Without --for the listing stays by start time, as another application reads it.
  const every = machine(directory, {}, "runs", "--all", "--json");
  assert.deepEqual((JSON.parse(every.stdout) as RunStatusRecord[]).map((run) => run.id), byStart);
});

test("machine runs --for says why it cannot list, and takes no option it does not know", async (context) => {
  const root = await temporaryDirectory(context);
  const directory = join(root, "status");
  const refused = (environment: Readonly<Record<string, string>>, ...args: string[]) => {
    const result = machine(directory, environment, "runs", ...args);
    assert.deepEqual({ status: result.status, stdout: result.stdout }, { status: 1, stdout: "" }, args.join(" "));
    return result.stderr;
  };

  // With no session named and none in the environment there is no viewer to list for.
  for (const args of [["--for"], ["--for", "--json"], ["--for", "--project", root], ["--all", "--for"]]) {
    assert.match(refused({}, ...args), /^No session to watch for: set MACHINES_RUN_OWNER /u);
  }
  // The session id names the viewer's watch list, so it must be safe as a file name.
  for (const id of ["../escaped", "nested/session", ".hidden", ""]) {
    assert.match(refused({}, "--for", id), /^Session id ".*" cannot name a watch list/u);
    assert.match(refused({ MACHINES_RUN_OWNER: id === "" ? "." : id }, "--for"), /^Session id ".*" cannot name a watch list/u);
  }
  assert.equal(refused({}, "--for", "viewer", "--project", ""), "Expected a directory after --project\n");
  const off = machine("off", {}, "runs", "--for", "viewer");
  assert.match(off.stderr, /^Run status publication is off: unset MACHINES_RUN_STATUS_DIR /u);

  const usage = [
    ["--project", root], ["--project", root, "--json"], ["--for", "viewer", "--project"], ["--for", "viewer", "--project", "--json"],
    ["--for", "viewer", "--for", "other"], ["--for", "--for"], ["--for", "viewer", "other"], ["--for", "viewer", "--project", root, "--project", root],
    ["--for", "viewer", "--json", "--json"], ["--for", "viewer", "--verbose"], ["--for=viewer"],
  ];
  for (const args of usage) {
    const message = refused({ MACHINES_RUN_OWNER: "viewer" }, ...args);
    assert.match(message, /^ {2}machine runs \[--json\] \[--all\]$/mu, args.join(" "));
    assert.match(message, /^ {2}machine runs --for \[<session>\] \[--project <dir>\] \[--json\] \[--all\]$/mu, args.join(" "));
  }
  // Listing for a viewer reads, and creates nothing.
  assert.equal(machine(directory, {}, "runs", "--for", "viewer").stdout, "Session viewer shows no Machine runs.\n");
  assert.equal(machine(directory, {}, "runs", "--for", "viewer", "--json").stdout, "[]\n");
  assert.deepEqual(await readdir(root), []);
});

test("machine watch --for and unwatch --for change the list of the session they name", async (context) => {
  const root = await temporaryDirectory(context);
  const directory = join(root, "status");
  const own = { CLAUDE_CODE_SESSION_ID: "own" };
  await mkdir(directory);
  await writeRecord(directory, { id: "1a2b3c4d-run", label: "org-9: Watch runs", owner: "another", cwd: "/work/machines" });

  // A server that draws a viewer's widgets needs no variable to manage that viewer's list.
  assert.equal(machine(directory, {}, "watch", "--for", "viewer").stdout, "Session viewer watches no other runs.\n");
  const first = machine(directory, {}, "watch", "--for", "viewer", "org-9");
  assert.deepEqual({ status: first.status, stderr: first.stderr, stdout: first.stdout }, {
    status: 0, stderr: "", stdout: "Watching org-9\n  1a2b3c4d-run\tticket\trunning\tstarting\torg-9: Watch runs\n",
  });
  // A session of its own does not change whose list is named.
  assert.equal(machine(directory, own, "watch", "--for", "viewer", "--dir", "/work/dispatch/").stdout, "Watching --dir /work/dispatch\n  no published run matches yet\n");
  assert.equal(machine(directory, own, "watch", "--for", "viewer", "--", "--for").stdout, "Watching --for\n  no published run matches yet\n");
  assert.equal(machine(directory, own, "watch", "--for", "viewer", "two", "words").stdout, "Watching two words\n  no published run matches yet\n");
  assert.deepEqual(readRunWatches(directory, "viewer"), [{ text: "org-9" }, { dir: "/work/dispatch" }, { text: "--for" }, { text: "two words" }]);
  assert.deepEqual(readRunWatches(directory, "own"), []);
  assert.deepEqual((await readdir(directory)).filter((name) => name.startsWith(".")), [".watch.viewer.json"]);
  assert.equal(machine(directory, own, "watch", "--for", "viewer").stdout, [
    "org-9", "  1a2b3c4d-run\tticket\trunning\tstarting\torg-9: Watch runs",
    "--dir /work/dispatch", "  no published run matches yet",
    "--for", "  no published run matches yet",
    "two words", "  no published run matches yet",
    "",
  ].join("\n"));

  // Without --for the commands are about this process's own session, as they always were.
  assert.equal(machine(directory, own, "watch").stdout, "This session watches no other runs.\n");
  assert.equal(machine(directory, own, "watch", "--", "--for", "viewer").stdout, "Watching --for viewer\n  no published run matches yet\n");
  assert.equal(machine(directory, own, "unwatch", "org-9").stdout, "This session was not watching org-9\n");
  assert.deepEqual(readRunWatches(directory, "own"), [{ text: "--for viewer" }]);

  assert.equal(machine(directory, own, "unwatch", "--for", "viewer", "org-9").stdout, "No longer watching org-9\n");
  assert.equal(machine(directory, {}, "unwatch", "--for", "viewer", "org-9").stdout, "Session viewer was not watching org-9\n");
  assert.equal(machine(directory, {}, "unwatch", "--for", "viewer", "--dir", "/work/dispatch").stdout, "No longer watching --dir /work/dispatch\n");
  assert.equal(machine(directory, {}, "unwatch", "--for", "viewer", "two", "words").stdout, "No longer watching two words\n");
  assert.deepEqual(readRunWatches(directory, "viewer"), [{ text: "--for" }]);
  assert.equal(machine(directory, {}, "unwatch", "--for", "viewer", "--all").stdout, "Session viewer watches no other runs.\n");
  assert.deepEqual(readRunWatches(directory, "own"), [{ text: "--for viewer" }]);
  assert.deepEqual((await readdir(directory)).filter((name) => name.startsWith(".")), [".watch.own.json"]);

  const refused = (...args: string[]) => {
    const result = machine(directory, own, ...args);
    assert.deepEqual({ status: result.status, stdout: result.stdout }, { status: 1, stdout: "" }, args.join(" "));
    return result.stderr;
  };
  const watchFor = "Usage: machine watch --for <session> [<run-id-or-label-start> | --dir <path>]\n";
  const unwatchFor = "Usage: machine unwatch --for <session> <run-id-or-label-start> | --dir <path> | --all\n";
  // A session always follows --for here: without one the commands already mean this process's own.
  assert.equal(refused("watch", "--for"), watchFor);
  assert.equal(refused("watch", "--for", "--dir", "/work"), watchFor);
  assert.equal(refused("watch", "--for", "viewer", "--dir"), watchFor);
  assert.equal(refused("watch", "--for", "viewer", "--all"), watchFor);
  assert.equal(refused("unwatch", "--for"), unwatchFor);
  assert.equal(refused("unwatch", "--for", "viewer"), unwatchFor);
  assert.equal(refused("unwatch", "--for", "viewer", "--all", "org-9"), unwatchFor);
  assert.equal(refused("unwatch", "--for", "viewer", "--dir"), unwatchFor);
  for (const id of ["../escaped", "nested/session", ".hidden"]) {
    assert.match(refused("watch", "--for", id, "org-9"), /^Session id ".*" cannot name a watch list/u);
    assert.match(refused("unwatch", "--for", id, "--all"), /^Session id ".*" cannot name a watch list/u);
  }
  const usage = refused("unwatch");
  assert.match(usage, /^ {2}machine watch --for <session> \[<run-id-or-label-start> \| --dir <path>\]$/mu);
  assert.match(usage, /^ {2}machine unwatch --for <session> <run-id-or-label-start> \| --dir <path> \| --all$/mu);
  assert.deepEqual(readRunWatches(directory, "own"), [{ text: "--for viewer" }]);
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

/** Runs one `machine` command with publication in `directory` and nothing else that names a session. */
function machine(directory: string, environment: Readonly<Record<string, string>>, ...args: string[]) {
  return spawnSync(process.execPath, [resolve("src/cli.ts"), ...args], {
    encoding: "utf8", env: { PATH: process.env.PATH, MACHINES_RUN_STATUS_DIR: directory, ...environment },
  });
}

async function writeRecord(directory: string, change: Partial<RunStatusRecord>): Promise<void> {
  const written = new Date().toISOString();
  const published = {
    schemaVersion: 2, id: "run", pid: process.pid, machine: "ticket", path: "/work/.machines/ticket.ts", cwd: "/work",
    status: "running", startedAt: written, updatedAt: written, ...change,
  };
  await writeFile(join(directory, `${published.id}.json`), JSON.stringify(published));
}

async function temporaryDirectory(context: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "machines-run-viewer-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
