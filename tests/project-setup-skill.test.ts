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

test("builder and delegation guide project-level gaps to the setup skill", () => {
  for (const name of ["machine-builder", "machine-delegation"]) {
    assert.match(read(`skills/${name}/SKILL.md`), /\[machine-project-setup\]\(\.\.\/machine-project-setup\/SKILL\.md\)/u);
  }
});
