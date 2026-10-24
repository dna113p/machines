import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const builder = "skills/machine-builder/SKILL.md";
const delegation = "skills/machine-delegation/SKILL.md";
const authoring = "docs/authoring.md";
const checksHeading = "## Checks the Machine owns";
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

// Pins survive re-wrapping, inline markup, and a typographic apostrophe.
const flat = (text: string) => text.replace(/[`*]/gu, "").replace(/’/gu, "'").replace(/\s+/gu, " ").trim().toLowerCase();
const lineCount = (source: string) => source.split("\n").length - (source.endsWith("\n") ? 1 : 0);
const lines = (source: string) => source.split("\n");

/** Lines under one `## ` heading, up to the next `## ` heading or the end of the file. */
function section(source: string, heading: string): string[] {
  const all = lines(source);
  const starts = all.flatMap((line, index) => (line === heading ? [index] : []));
  assert.equal(starts.length, 1, `expected exactly one "${heading}" heading`);
  const start = starts[0]! + 1;
  const length = all.slice(start).findIndex((line) => line.startsWith("## "));
  return all.slice(start, length < 0 ? undefined : start + length);
}

/** A list item with its wrapped lines, or a paragraph: the unit one habit is stated in. */
function items(body: string[]): string[][] {
  const found: string[][] = [];
  let current: string[] = [];
  for (const line of body) {
    if (line.trim() === "" || /^(?:-|\d+\.) /u.test(line)) {
      if (current.length > 0) found.push(current);
      current = [];
    }
    if (line.trim() !== "") current.push(line);
  }
  if (current.length > 0) found.push(current);
  return found;
}

const isListItem = (item: string[]) => /^(?:-|\d+\.) /u.test(item[0] ?? "");
const carriers = (all: string[][], phrase: string) => all.filter((item) => flat(item.join("\n")).includes(flat(phrase)));

// Products, harnesses, models, ticket ids, and checkouts of the workspace this guidance came from.
const workspaceNames = [
  /\b(?:codex|claude|pi|agy|jev|laya|von|deepseek|openrouter|chatgpt|gpt|gemini|opus|sonnet|haiku)\b/iu,
  /\b(?:dispatch|drip|machine[ -]shop|machine[ -]wars|rig[ -]bridge|machines-org|dna113p|dnatop)\b/iu,
  /\borg-\d+\b/iu,
  /#\d+\b/u,
  /\/home\/|~\//u,
];
function named(label: string, text: string): string[] {
  return workspaceNames.flatMap((name) => {
    const hit = name.exec(text);
    return hit ? [`${label} names "${hit[0]}"`] : [];
  });
}

const setup = "skills/machine-project-setup/SKILL.md";
const rule = "restrict by reversibility, not by judgment";

/** Lines under one `### ` heading matching `pattern`, up to the next `## ` or `### ` heading. */
function subsection(body: string[], pattern: RegExp): string[] {
  const starts = body.flatMap((line, index) => (line.startsWith("### ") && pattern.test(line.slice(4)) ? [index] : []));
  assert.equal(starts.length, 1, `expected exactly one "### " heading matching ${pattern}`);
  const start = starts[0]! + 1;
  const length = body.slice(start).findIndex((line) => /^#{2,3} /u.test(line));
  return body.slice(start, length < 0 ? undefined : start + length);
}

const cells = (row: string) => row.trim().replace(/^\|/u, "").replace(/\|$/u, "").split("|").map((cell) => cell.trim());

/**
 * The reported and enforced sides of the rule, from a two-column table headed
 * Reported and Enforced, or from two lists each introduced by a line naming its side.
 */
function columns(source: string): { reported: string; enforced: string } | undefined {
  const all = lines(source);
  for (const [index, line] of all.entries()) {
    if (!line.trim().startsWith("|")) continue;
    const header = cells(line);
    if (header.length !== 2 || !/reported/iu.test(header[0]!) || !/enforced/iu.test(header[1]!)) continue;
    if (!/^\|?\s*:?-{3,}:?\s*\|\s*:?-{3,}:?\s*\|?\s*$/u.test(all[index + 1] ?? "")) continue;
    const rows = [];
    for (const row of all.slice(index + 2)) {
      if (!row.trim().startsWith("|")) break;
      rows.push(cells(row));
    }
    if (rows.length === 0 || rows.some((row) => row.length !== 2)) continue;
    return { reported: rows.map((row) => row[0]).join("\n"), enforced: rows.map((row) => row[1]).join("\n") };
  }
  const list = (side: RegExp) => {
    const at = all.findIndex((line, index) => side.test(line) && !/^(?:-|\d+\.) /u.test(line) && /^(?:-|\d+\.) /u.test(all[index + 1] ?? all[index + 2] ?? ""));
    if (at < 0) return undefined;
    const body = all.slice(at + 1);
    const start = body.findIndex((line) => line.trim() !== "");
    const end = body.slice(start).findIndex((line) => line.trim() === "");
    return body.slice(start, end < 0 ? undefined : start + end).join("\n");
  };
  const reported = list(/\breported\b/iu);
  const enforced = list(/\benforced\b/iu);
  return reported && enforced ? { reported, enforced } : undefined;
}

/** Each habit the builder always follows: its pin, and words its one carrier must also hold. */
const alwaysHabits: [string, string[]][] = [
  ["gate list in one place", []],
  ["layered", ["focused", "when", "concurrent"]],
  ["never an agent's claim", ["operation"]],
  ["hard stop", ["forbidden", "irreversible"]],
  ["open findings", ["draft", "green"]],
  ["not the reviewer's verdict word", ["advisory"]],
  ["never by their wording", []],
  ["work kept and a written note", []],
  ["are the workflow's to run", []],
];

/** Each careful pattern the builder adds only on request. */
const onRequestHabits: [string, string[]][] = [
  ["tests first", ["red"]],
  ["wrong, already done, or underspecified", []],
  ["compares the changed paths", []],
  ["second review round", []],
  ["budget", ["human"]],
];

// Careful-pattern wording that must not survive as a default anywhere else in the builder.
const carefulOnly = ["tests first", "fail before implementation", "wrong, already done, or underspecified", "compares the changed paths", "falsify", "scope check"];

const assignmentFields = [
  "Its goal",
  "The paths it may change",
  "Its acceptance criteria",
  "How it will be verified",
  "What is forbidden",
];
const scopingRule = "cannot be filled means the unit is not scoped yet";

const supervisionHabits: [number, string][] = [
  [5, "not the reviewer's verdict word"],
  [7, "work kept and a written note"],
  [7, "a completed run to read, not a failure to retry blindly"],
  [9, "are the workflow's to run"],
];

test("each of the three skills states the reversibility rule with what is reported and what is enforced", () => {
  const problems: string[] = [];
  for (const path of [builder, delegation, setup]) {
    const source = read(path);
    if (!flat(source).includes(rule)) problems.push(`${path} does not state "${rule}"`);
    const sides = columns(source);
    if (sides === undefined) {
      problems.push(`${path} has no two-column Reported/Enforced table and no Reported and Enforced lists`);
      continue;
    }
    const reported = flat(sides.reported);
    const enforced = flat(sides.enforced);
    for (const word of ["scope", "assumption"]) {
      if (!reported.includes(word)) problems.push(`${path}: the reported side does not name ${word}`);
    }
    for (const word of ["forbidden", "irreversible"]) {
      if (!enforced.includes(word)) problems.push(`${path}: the enforced side does not name ${word}`);
    }
  }
  assert.deepEqual(problems, []);
});

test("builder's checks list what it always does and, apart, what it adds on request", () => {
  const source = read(builder);
  const owned = section(source, checksHeading);
  const problems: string[] = [];
  for (const [heading, pattern, habits] of [
    ["Always", /^always\b/iu, alwaysHabits],
    ["On request", /^on request\b/iu, onRequestHabits],
  ] as const) {
    const listed = items(subsection(owned, pattern));
    for (const [phrase, words] of habits) {
      const found = carriers(listed, phrase);
      // Exactly one carrier, so removing the habit cannot leave its pin satisfied elsewhere.
      if (found.length !== 1) {
        problems.push(`"${phrase}" is stated ${found.length} times under "### ${heading}", expected once`);
        continue;
      }
      if (found[0]!.length > 4) problems.push(`"${phrase}" is stated in ${found[0]!.length} lines, at most four allowed`);
      const text = flat(found[0]!.join("\n"));
      for (const word of words) {
        if (!new RegExp(`\\b${word}`, "u").test(text)) problems.push(`the "${phrase}" item under "### ${heading}" does not say ${word}`);
      }
    }
    for (const item of listed.filter(isListItem)) {
      if (!/\b(?:reported|enforced)\b/u.test(flat(item.join("\n")))) {
        problems.push(`an item under "### ${heading}" does not name its column: ${item[0]}`);
      }
    }
  }
  assert.deepEqual(problems, []);
  assert.ok(flat(source).includes("an agent's claim of completion is not verification"));
  assert.ok(lineCount(source) < 165, `${builder} has ${lineCount(source)} lines, must stay under 165`);
});

test("builder no longer makes tests first, falsify, a scope check, or a Human sleep a default step", () => {
  const source = read(builder);
  const all = lines(source);
  const onRequest = subsection(section(source, checksHeading), /^on request\b/iu);
  const start = all.findIndex((line) => /^### on request\b/iu.test(line)) + 1;
  const outside = flat([...all.slice(0, start), ...all.slice(start + onRequest.length)].join("\n"));
  const problems = carefulOnly.filter((phrase) => outside.includes(flat(phrase))).map((phrase) => `"${phrase}" appears outside "### On request"`);
  assert.deepEqual(problems, []);
  const always = flat(subsection(section(source, checksHeading), /^always\b/iu).join("\n"));
  assert.doesNotMatch(always, /sleep on one human question/u);
  assert.doesNotMatch(always, /every gate, not only up to the first failure/u);
});

test("builder's recovery asks a person only for an irreversible decision or a login", () => {
  const recovery = flat(section(read(builder), "## Recovering from failures").join("\n"));
  assert.ok(!recovery.includes("a decision, scope change, used-up budget, or login"), "recovery still sends a scope change and a used-up budget to a person");
  for (const phrase of [
    "an irreversible decision or a login: ask a person",
    "a scope change is reported",
    "a used-up budget with green checks delivers",
  ]) {
    assert.ok(recovery.includes(phrase), `"## Recovering from failures" must say "${phrase}"`);
  }
});

test("builder's new section is about Machines in general and leaves existing lines alone", () => {
  const source = read(builder);
  assert.deepEqual(named(`"${checksHeading}"`, section(source, checksHeading).join("\n")), []);
  const all = lines(source);
  for (const kept of [
    "route failures to repair, escalation, or a blocked result. Required checks must",
    "pass before success; an Agent's claim of completion is not verification. Use",
    "and any branch that still requires a configured harness or human interaction.",
  ]) {
    assert.ok(all.includes(kept), `${builder} changed an existing line: ${kept}`);
  }
});

test("delegation lists the five assignment fields and the scoping rule with a complete assignment", () => {
  const source = read(delegation);
  const supplied = items(section(source, "## Supply a complete assignment"));
  const problems: string[] = [];
  const positions: number[] = [];
  for (const field of assignmentFields) {
    const found = carriers(supplied, field).filter(isListItem);
    if (found.length !== 1) {
      problems.push(`habit 10: field "${field}" is in ${found.length} list items, expected one`);
    } else {
      positions.push(supplied.indexOf(found[0]!));
      if (found[0]!.length > 2) problems.push(`habit 10: field "${field}" takes ${found[0]!.length} lines, the list must stay short`);
    }
  }
  const rule = carriers(supplied, scopingRule);
  if (rule.length !== 1) problems.push(`habit 10: "${scopingRule}" is stated ${rule.length} times, expected once`);
  assert.deepEqual(problems, []);
  const first = positions[0]!;
  assert.deepEqual(positions, [first, first + 1, first + 2, first + 3, first + 4], "the five fields must be one list, in order");
  assert.ok(supplied.indexOf(rule[0]!) >= first + 4, "the scoping rule must close the list of fields");
  const all = lines(source);
  for (const kept of [
    "- The bounded objective, relevant facts, and acceptance criteria.",
    "- The absolute workspace, files or references to read, and ownership of any edits.",
    "- Applicable constraints, permitted effects, and what should produce a blocked outcome.",
    "- A result location readable by the coordinator, and what evidence it must contain.",
  ]) {
    assert.ok(all.includes(kept), `${delegation} changed an existing line: ${kept}`);
  }
});

test("delegation states habits 5, 7, and 9 where it supervises a run and reads its result", () => {
  const source = read(delegation);
  const supervised = items([...section(source, "## Launch and supervise"), "", ...section(source, "## Collect and integrate")]);
  const problems: string[] = [];
  for (const [habit, phrase] of supervisionHabits) {
    const found = carriers(supervised, phrase);
    if (found.length !== 1) problems.push(`habit ${habit}: "${phrase}" is stated ${found.length} times, expected once`);
  }
  assert.deepEqual(problems, []);
  const parked = flat(carriers(supervised, "a completed run to read, not a failure to retry blindly")[0]!.join("\n"));
  assert.match(parked, /\bblocked\b/u);
  assert.match(parked, /\bparked\b/u);
  // A run with green checks delivers; only a stop on an enforced item parks.
  for (const word of [/\bgreen checks\b/u, /\bdeliver/u, /\benforced\b/u]) {
    assert.ok(word.test(parked), `the parked-run paragraph must say ${word}`);
  }
  assert.ok(flat(source).includes("no per-run cancel, arbitrary message, or resume operation"));
  assert.ok(lineCount(source) < 185, `${delegation} has ${lineCount(source)} lines, must stay under 185`);
});

test("delegation keeps Human states for the enforced column only, and a wake still answers no Human decision", () => {
  const source = read(delegation);
  const chosen = flat(section(source, "## Choose or create the Machine").join("\n"));
  assert.ok(!flat(source).includes("human states for decisions that belong to the user"), "the Human-states sentence still names decisions that belong to the user");
  assert.match(chosen, /human states only for enforced[- ]column decisions/u);
  assert.ok(
    flat(source).includes("a wake never authorizes an agent to answer a human decision itself"),
    "the rule that a wake never answers a Human decision must stay",
  );
});

test("delegation's assignment asks for the trusted result fields", () => {
  const supplied = items(section(read(delegation), "## Supply a complete assignment")).filter(isListItem);
  const problems: string[] = [];
  for (const [field, words] of [
    ["assumptions", []],
    ["scopeAdditions", []],
    ["openQuestions", ["irreversible"]],
    ["needs", ["blocked"]],
  ] as const) {
    const found = supplied.filter((item) => new RegExp(`\\b${field.toLowerCase()}\\b`, "u").test(flat(item.join("\n"))));
    if (found.length !== 1) {
      problems.push(`result field "${field}" is in ${found.length} list items, expected one`);
      continue;
    }
    for (const word of words) {
      if (!flat(found[0]!.join("\n")).includes(word)) problems.push(`result field "${field}" does not say ${word}`);
    }
  }
  assert.deepEqual(problems, []);
});

test("delegation's added guidance is about Machines in general and leaves existing lines alone", () => {
  const source = read(delegation);
  const supplied = items(section(source, "## Supply a complete assignment"));
  const supervised = items([...section(source, "## Launch and supervise"), "", ...section(source, "## Collect and integrate")]);
  const added = [
    ...[...assignmentFields, scopingRule].map((phrase) => [phrase, carriers(supplied, phrase)] as const),
    ...supervisionHabits.map(([, phrase]) => [phrase, carriers(supervised, phrase)] as const),
  ];
  const problems: string[] = [];
  for (const [phrase, found] of added) {
    if (found.length === 0) problems.push(`"${phrase}" is missing`);
    for (const item of found) problems.push(...named(`the guidance stating "${phrase}"`, item.join("\n")));
  }
  assert.deepEqual(problems, []);
  const all = lines(source);
  for (const kept of [
    "| `completed` | Check the final state and read the result artifacts. A final state such as `blocked` or `rejected` also counts as a completed run. |",
    "new decision when the request requires one. A desire to finish is not an answer.",
    "The current tools have no per-run cancel, arbitrary message, or resume operation.",
    "inspect existing effects before restarting; a new run is not a continuation or rollback.",
    "artifact paths; a run ID alone is not the delegated deliverable.",
  ]) {
    assert.ok(all.includes(kept), `${delegation} changed an existing line: ${kept}`);
  }
});

test("the authoring guide points to the builder's checks in one short paragraph", () => {
  const source = read(authoring);
  const href = "../skills/machine-builder/SKILL.md#checks-the-machine-owns";
  const blocks = source.split(/\n{2,}/u);
  const anchors = blocks.flatMap((block, index) =>
    flat(block).endsWith("add verification operations where the workflow has a concrete condition to check.") ? [index] : [],
  );
  assert.equal(anchors.length, 1, "the paragraph the pointer follows must stay as it is");
  const pointer = blocks[anchors[0]! + 1] ?? "";
  assert.ok(pointer.includes(`](${href})`), `the paragraph after the verification Operations sentence must link to ${href}`);
  assert.doesNotMatch(pointer, /^#/mu, "the pointer adds no heading");
  assert.ok(lines(pointer).length <= 4, "the pointer is one short paragraph");
  const layered = blocks[anchors[0]! + 2] ?? "";
  assert.doesNotMatch(layered, /^#/mu, "layered checks follow the pointer as a paragraph, not a heading");
  for (const word of ["layered", "when", "draft", "open findings"]) {
    assert.ok(new RegExp(`\\b${word}\\b`, "u").test(flat(layered)), `the paragraph after the pointer must describe ${word}`);
  }
  assert.equal(blocks[anchors[0]! + 3], "### Handling a usage limit in the Machine");
  assert.equal(source.split("#checks-the-machine-owns").length - 1, 1, "the guide points to the heading once");

  const [path, fragment] = href.split("#");
  const target = resolve(dirname(resolve(root, authoring)), path!);
  assert.ok(statSync(target).isFile());
  const slugs = lines(readFileSync(target, "utf8"))
    .filter((line) => /^#+ /u.test(line))
    .map((line) => line.replace(/^#+ /u, "").toLowerCase().replace(/[^\w\- ]/gu, "").replaceAll(" ", "-"));
  assert.ok(slugs.includes(fragment!), `${builder} has no heading for #${fragment}`);
});

test("the integrations guide keeps sleeping for enforced decisions and names layered gates for setup", () => {
  const source = read("docs/integrations.md");
  const all = lines(source);
  const continuing = flat(subsection(all, /^continuing a run$/iu).join("\n"));
  assert.match(continuing, /\benforced\b/u, "\"### Continuing a run\" must say sleeping on a Human request is for enforced decisions");
  assert.ok(continuing.includes("authoring.md#"), "the note links to the authoring guidance on delivering with open findings");
  const orchestrator = flat(section(source, "## Project orchestrator setup").join("\n"));
  assert.match(orchestrator, /\blayered gates\b/u);
  assert.match(orchestrator, /\badvisory review\b/u);
});

test("the README's rules of thumb state the rule, layered gates and delivering with open findings", () => {
  const all = lines(read("README.md"));
  const start = all.indexOf("A few rules of thumb:");
  assert.ok(start >= 0, "README.md keeps its rules of thumb");
  const end = all.slice(start + 1).findIndex((line) => line.startsWith("#") || /^[A-Z]/u.test(line));
  const rules = items(all.slice(start + 1, end < 0 ? undefined : start + 1 + end)).filter(isListItem);
  const found = carriers(rules, rule);
  assert.equal(found.length, 1, `one rule of thumb states "${rule}"`);
  const text = flat(found[0]!.join("\n"));
  assert.match(text, /\blayered\b/u);
  assert.match(text, /\bopen findings\b/u);
});
