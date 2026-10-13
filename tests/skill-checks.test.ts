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

const builderHabits: [number, string][] = [
  [1, "every gate, not only up to the first failure"],
  [2, "gate list in one place"],
  [3, "fail before implementation"],
  [4, "compares the changed paths"],
  [5, "not the reviewer's verdict word"],
  [6, "never by their wording"],
  [7, "work kept and a written note"],
  [8, "wrong, already done, or underspecified"],
  [9, "are the workflow's to run"],
];

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

test("builder states the nine check habits under one heading, each in at most three lines", () => {
  const source = read(builder);
  const owned = items(section(source, checksHeading));
  const problems: string[] = [];
  for (const [habit, phrase] of builderHabits) {
    const found = carriers(owned, phrase);
    // Exactly one carrier, so removing the habit cannot leave its pin satisfied elsewhere.
    if (found.length !== 1) {
      problems.push(`habit ${habit}: "${phrase}" is stated ${found.length} times under "${checksHeading}", expected once`);
    } else if (found[0]!.length > 3) {
      problems.push(`habit ${habit}: "${phrase}" is stated in ${found[0]!.length} lines, at most three allowed`);
    }
  }
  assert.deepEqual(problems, []);
  assert.ok(flat(source).includes("an agent's claim of completion is not verification"));
  assert.ok(lineCount(source) < 140, `${builder} has ${lineCount(source)} lines, must stay under 140`);
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
  assert.ok(flat(source).includes("no per-run cancel, arbitrary message, or resume operation"));
  assert.ok(lineCount(source) < 170, `${delegation} has ${lineCount(source)} lines, must stay under 170`);
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
  assert.equal(blocks[anchors[0]! + 2], "### Handling a usage limit in the Machine");
  assert.equal(source.split("#checks-the-machine-owns").length - 1, 1, "the guide points to the heading once");

  const [path, fragment] = href.split("#");
  const target = resolve(dirname(resolve(root, authoring)), path!);
  assert.ok(statSync(target).isFile());
  const slugs = lines(readFileSync(target, "utf8"))
    .filter((line) => /^#+ /u.test(line))
    .map((line) => line.replace(/^#+ /u, "").toLowerCase().replace(/[^\w\- ]/gu, "").replaceAll(" ", "-"));
  assert.ok(slugs.includes(fragment!), `${builder} has no heading for #${fragment}`);
});
