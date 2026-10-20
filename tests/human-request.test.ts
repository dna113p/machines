import assert from "node:assert/strict";
import { test } from "node:test";
import { human, machine, operation, final, run, type HumanOptions } from "../src/index.ts";

test("Human presentation rejects missing dependencies, malformed values and multiline sentences", () => {
  const invalid: Array<[string, unknown]> = [
    ["recommended", { recommended: "approve" }],
    ["effects", { effects: {} }],
    ["discards", { discards: [] }],
    ["reason", { reason: "Because." }],
    ["headline", { headline: "" }],
    ["headline", { headline: "Two\nlines" }],
    ["headline", { headline: () => "Dynamic" }],
    ["recommended", { choices: ["approve"], recommended: 1 }],
    ["effects", { choices: ["approve"], effects: null }],
    ["effects", { choices: ["approve"], effects: [] }],
    ["effects", { choices: ["approve"], effects: { approve: "" } }],
    ["effects", { choices: ["approve"], effects: { approve: "Two\nlines" } }],
    ["discards", { choices: ["approve"], discards: "approve" }],
    ["discards", { choices: ["approve"], discards: ["approve", "approve"] }],
    ["reason", { choices: ["approve"], recommended: "approve", reason: "" }],
    ["page", { page: () => "<p>Dynamic</p>" }],
  ];
  for (const [field, options] of invalid) {
    assert.throws(() => human("Choose", { submitted: "done" }, options as HumanOptions), new RegExp(field));
  }
});

test("Human presentation is checked again when the request is built", async () => {
  const options = { choices: ["approve"], recommended: "approve" };
  const definition = machine({
    initial: "change",
    states: {
      change: operation(() => { options.recommended = "unknown"; return { type: "changed" }; }, { changed: "ask" }),
      ask: human("Choose", { submitted: "done" }, options),
      done: final(),
    },
  });
  await assert.rejects(run(definition, { human: () => assert.fail("Invalid request reached runner") }), /recommended/u);
});

test("Human page rejects resource attributes and active links without rejecting data attributes or quoted text", () => {
  for (const page of [
    '<img srcset="a.png 1x">', '<video poster="a.png">', '<table background="a.png">',
    '<form action="/submit">', '<button formaction="/submit">Go</button>', '<div data="resource">',
    '<svg><use href="#shape"></use></svg>', '<svg><use xlink:href="#shape"></use></svg>',
    '<a href="javascript:alert(1)">Go</a>', '<a href="data:text/html,hi">Go</a>',
    '<a href="java&#x73;cript&colon;alert(1)">Go</a>', '<a href="java\nscript:alert(1)">Go</a>',
    '<p title="a > b" onclick="go()">Go</p>', '<p ONCLICK>Go</p>', '<p style>Go</p>',
    '<font color="red">Text</font>', '<body>Text</body>',
  ]) {
    assert.throws(() => human("Choose", { submitted: "done" }, { page }), /page/u, page);
  }
  human("Choose", { submitted: "done" }, {
    page: '<p data-x="1" title="src=x and a > b">&lt;script&gt;</p><a href="/details">Details</a>',
  });
});

test("Human page refuses a stray '<' or unbalanced quote that would hide a tag's attributes", () => {
  for (const page of [
    "<img src=x onerror=alert(1) <>",
    '<a href="javascript:alert(1)" <>go</a>',
    '<img src=x onerror=alert(1) a=b">',
    "<img onerror=alert(1) title='>",
    // Whitespace around '=' and '/' between attributes do not hide anything either.
    '<a href = "javascript:alert(1)">go</a>',
    "<img/onerror=alert(1)>",
  ]) {
    assert.throws(() => human("Choose", { submitted: "done" }, { page }), /page/u, page);
  }
  // Text that is not a tag is still accepted.
  for (const page of ["<p>a < b and 3 > 2</p>", "<p>I <3 this</p>", '<p title="a < b">x</p>']) {
    human("Choose", { submitted: "done" }, { page });
  }
});
