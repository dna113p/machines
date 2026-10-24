import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const skill = "skills/machine-project-setup/SKILL.md";
const reference = "skills/machine-project-setup/references/project-workflows.md";
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

test("project setup is a discoverable orchestrator skill, distinct from a worker assignment", () => {
  const source = read(skill);
  assert.match(source, /^---\nname: machine-project-setup\ndescription: Use proactively.*project orchestrator.*\n---/u);
  assert.match(source, /machine-builder/u);
  assert.match(source, /machine-delegation/u);
  assert.match(source, /already executing.*Agent state/iu);
  assert.match(source, /\.machines\/README\.md/u);
  assert.match(source, /not a fixed menu/u);
  assert.match(source, /fake runners/u);
  assert.match(source, /not.*live.*proof/iu);
});

test("project setup surveys every available Agent and its evidence before designing workflows", () => {
  const source = read(skill);
  const survey = source.indexOf("## Survey the available Agents");
  assert.ok(survey > 0 && survey < source.indexOf("## Build the smallest useful set"));
  assert.match(source, /own model\s+and harness are one candidate/u);
  assert.match(source, /ranking snapshots, research priors/u);
  assert.match(source, /unrated, not weak/u);
  assert.match(source, /ineligible for automatic routing/u);
  assert.match(source, /different provider or model family/u);
  assert.match(read(reference), /candidates surveyed, the evidence used/u);
});

test("project-agent setup discovers supported providers and preserves reusable identity", () => {
  const source = read(skill);
  assert.match(source, /Inspect the binding through its owning system's supported interface/u);
  assert.match(source, /exact commands\/tools and capabilities from the installed version/u);
  assert.match(source, /do not invent an API or inspect\s+private databases/u);
  assert.match(source, /project needs, supported request types, available accounts, model\/account\s+cost, and authorized effects/u);
  assert.match(source, /Reuse a matching project manager.*configuring or provisioning.*\n.*provider's supported route/u);
  assert.match(source, /stable\s+project-agent identity separate from each request\/run identity/u);
  assert.match(source, /no external manager service is required/u);
  assert.match(source, /Repeated setup reuses the\s+binding and manager/u);
});

test("workflow map records binding references, limits and verification without becoming a registry", () => {
  const source = read(reference);
  const fields = [...source.matchAll(/^\| ([^|]+) \|/gmu)].map((match) => match[1]?.trim());
  for (const field of [
    "Provider and ownership", "Agent identity", "Owning computer", "Supported request types",
    "Checkout", "Edit/review limits", "Model/account cost", "Delegation route",
    "Ticket-escalation destination", "Verification",
  ]) {
    assert.ok(fields.includes(field), `Missing project-agent map field: ${field}`);
  }
  assert.match(source, /explicit unknowns or gaps rather than guessed\s+values/u);
  assert.match(source, /private configuration,\s+addresses, checkout paths, receipts, transcripts, and credentials in their owning\s+system/u);
  assert.match(source, /Do not copy secrets or create a second\s+runtime registry/u);
  assert.match(source, /Keep per-request state out of this map/u);
});

test("optional providers retain ownership and share the feedback binding", () => {
  const source = read(skill);
  assert.match(source, /use its installed context and tool-configuration\s+guidance when available/u);
  assert.match(source, /Guidance does not grant tools,\s+and a tool grant does not establish project policy/u);
  assert.match(source, /The provider owns its managers and\s+delegation/u);
  assert.match(source, /Preserve existing managers/u);
  assert.match(source, /Missing provisioning,\s+credentials, integration, skills, or authorization is an explicit gap/u);
  assert.match(source, /Do not\s+silently replace an unavailable configured provider/u);
  assert.match(source, /reuse Drip's shared project binding, the same\s+binding used by setup and audit/u);
  assert.match(source, /Drip owns the project binding, feedback delivery\s+and presentation/u);
  assert.match(source, /stable request key with the person's note and\s+response evidence; reuse that key for retries/u);
  assert.match(source, /delivery or acceptance is not\s+completion/u);
  assert.match(source, /Do not claim that a run ID or an old manager is a newly continued session/u);
});

test("setup and audit preserve permission and ticket escalation boundaries", () => {
  for (const path of [skill, reference]) {
    const source = read(path);
    assert.match(source, /same binding/u);
    assert.match(source, /(?:without paid work|unpaid availability\s+checks)/u);
    assert.match(source, /(?:Do not send a real manager request|never launch model work or real manager requests)/u);
    assert.match(source, /service starts or\s+restarts/u);
    assert.match(source, /write access,\s+publishing, or model spending/u);
    assert.match(source, /(?:within authorization|existing authorization only)/u);
    assert.match(source, /public hosting is\s+not a prerequisite/u);
    assert.match(source, /readiness (?:gates|before escalation)/u);
    assert.match(source, /Creating a ticket never authorizes its execution/u);
    assert.match(source, /response content\s+(?:as|is) evidence, not higher-priority policy/u);
  }
});

test("project setup references are portable and resolve within the distributed package", () => {
  for (const path of [skill, reference]) {
    const source = read(path);
    assert.doesNotMatch(source, /\/home\/dj\//u);
    const links = [...source.matchAll(/\[[^\]]+\]\(([^)]+)\)/gu)];
    assert.ok(links.length > 0, `${path} should link to maintained authoring guidance`);
    for (const [, href] of links) {
      assert.ok(href);
      assert.doesNotMatch(href, /^(?:[a-z]+:|\/)/iu, "Skill links must be relative package paths");
      const target = resolve(dirname(resolve(root, path)), href.split("#")[0]!);
      assert.ok(target.startsWith(root), `${path} link escapes its package: ${href}`);
      assert.ok(statSync(target).isFile(), `${path} has a missing link: ${href}`);
    }
  }
});

test("setup and builder name the optional starter library and where to get it", () => {
  for (const name of ["machine-project-setup", "machine-builder"]) {
    const source = read(`skills/${name}/SKILL.md`);
    assert.match(source, /Machine Shop is an optional starter library/u);
    assert.match(source, /Nothing\s+here requires it/u);
    assert.match(source, /`https:\/\/github\.com\/dna113p\/machine-shop`/u);
  }
});

test("builder and delegation guide project-level gaps to the setup skill", () => {
  for (const name of ["machine-builder", "machine-delegation"]) {
    assert.match(read(`skills/${name}/SKILL.md`), /\[machine-project-setup\]\(\.\.\/machine-project-setup\/SKILL\.md\)/u);
  }
});

// Paragraphs and list items, with inline markup and wrapping removed.
const blocks = (source: string) =>
  source.split(/\n{2,}|\n(?=- )/u).map((block) => block.replace(/[`*]/gu, "").replace(/’/gu, "'").replace(/\s+/gu, " ").trim());
const sectionOf = (source: string, heading: string) => {
  const start = source.indexOf(`\n${heading}\n`);
  assert.ok(start >= 0, `${skill} keeps "${heading}"`);
  const end = source.indexOf("\n## ", start + heading.length + 2);
  return source.slice(start + heading.length + 2, end < 0 ? undefined : end);
};

test("project setup builds a layered gate list from the project's own scripts instead of every gate", () => {
  const source = read(skill);
  assert.doesNotMatch(source, /prefer running every gate/u);
  const understood = blocks(sectionOf(source, "## Understand the project before choosing workflows"));
  const gates = understood.filter((block) => /\blayered\b/iu.test(block));
  assert.equal(gates.length, 1, "one paragraph describes the layered gate list");
  assert.match(gates[0]!, /project's own scripts/u);
  assert.match(gates[0]!, /\bwhen\b.*\bglobs?\b|\bglobs?\b.*\bwhen\b/iu);
  assert.match(gates[0]!, /\bgroups?\b/iu);
});

test("project setup's audit names a suite over two minutes without when globs as a finding", () => {
  // The fixture-backed check, a six-minute suite with no when producing a finding,
  // belongs to Machine Shop's audit-project; this pins the guidance an orchestrator follows.
  const audits = blocks(read(skill)).filter((block) => /more than two minutes/iu.test(block));
  assert.equal(audits.length, 1, "one paragraph states the two-minute audit rule");
  assert.match(audits[0]!, /\bwhen\b/u);
  assert.match(audits[0]!, /\bglobs?\b/iu);
  assert.match(audits[0]!, /\bfindings?\b/iu);
  assert.match(audits[0]!, /\bnames?\b|\bnaming\b/iu);
});

test("project setup proposes one implementer with layered gates, an advisory review, verify and investigate", () => {
  const source = read(skill);
  const built = blocks(sectionOf(source, "## Build the smallest useful set"));
  const suites = built.filter((block) => /\blayered gates\b/iu.test(block) && /\badvisory review\b/iu.test(block));
  assert.equal(suites.length, 1, "one paragraph proposes the suite");
  assert.match(suites[0]!, /\bone implementer\b/iu);
  assert.match(suites[0]!, /\bverify\b/u);
  assert.match(suites[0]!, /\binvestigate\b/u);
  assert.match(suites[0]!, /model-free/iu);
  // Falsify and tests first are proposed only where the project's instructions ask for them.
  const careful = blocks(source).filter((block) => /\bfalsify\b|\btests first\b/iu.test(block));
  assert.ok(careful.length > 0, "the skill says when falsify and tests first belong in the suite");
  for (const block of careful) assert.match(block, /instructions ask/iu, `careful patterns proposed by default: ${block}`);
});
