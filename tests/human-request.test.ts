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

test("Human page reads comments as HTML does, so a comment hides no tag", () => {
  for (const page of [
    '<!-- <a title=" --><img src=x onerror=alert(1)>"> -->',
    '<!-- <a title=" <img src=x onerror=alert(1)>">',
    '<!-- --!><img src=x onerror=alert(1)> -->',
    '<!--><img src=x onerror=alert(1)>', '<!---><img src=x onerror=alert(1)>',
    '<!x <a title="><img src=x onerror=alert(1)>">',
    '<?x <a title="><img src=x onerror=alert(1)>">',
    '</1 <a title="><img src=x onerror=alert(1)>">',
    '<svg><![CDATA[x]]></svg>', '<!DOCTYPE html>',
    '<!--', '<!---',
  ]) {
    assert.throws(() => human("Choose", { submitted: "done" }, { page }), /page/u, page);
  }
  for (const page of [
    '<p>a</p><!-- a note --><p>b</p>', '<!----><p>x</p>', '<!--><p>x</p>',
    '<!---><p>x</p>', '<!----!><p>x</p>',
    '<!-- <img src=x onerror=alert(1)> --><p>x</p>',
  ]) {
    human("Choose", { submitted: "done" }, { page });
  }
});

test("Human page reads textarea and title content as text and refuses markup inside them", () => {
  for (const page of [
    '<textarea><a title="</textarea><img src=x onerror=alert(1)>"></textarea>',
    '<textarea><a title="<img src=x onerror=alert(1)>">',
    '<textarea>plain', '<title>plain', '<textarea/>plain',
    '<title><b>x</b></title>',
    '<svg><title><img src=x onerror=alert(1)></title></svg>',
    '<svg><textarea><img src=x onerror=alert(1)></textarea></svg>',
    '<textarea>x</textareax>', '<textarea>x</textarea\u00a0>',
    '<textarea><!-- note --></textarea>', '<title><?x></title>',
    '<textarea>x</textarea onmouseover=alert(1)>',
    '<textarea>x</textarea><img src=x onerror=alert(1)>',
  ]) {
    assert.throws(() => human("Choose", { submitted: "done" }, { page }), /page/u, page);
  }
  for (const page of [
    '<textarea>a < b and plain text</textarea>', '<title>Plain</title><p>x</p>',
    '<TEXTAREA>x</TEXTAREA >', '<textarea/>x</textarea>',
    ...["\t", "\n", "\f", "\r", " ", "/"].map(space => `<title>x</title${space}>`),
  ]) {
    human("Choose", { submitted: "done" }, { page });
  }
});

test("Human page refuses elements whose content a browser reads as raw text", () => {
  for (const name of ["noscript", "plaintext", "xmp", "noembed", "noframes"]) {
    const page = `<${name}>plain</${name}>`;
    assert.throws(() => human("Choose", { submitted: "done" }, { page }), /page/u, page);
  }
});

test("Human suggestion presentation validates membership and names both lists when neither exists", () => {
  for (const field of ["recommended", "effects", "discards"] as const) {
    const value = { recommended: "retry", effects: {}, discards: [] }[field];
    assert.throws(() => human("Choose", { submitted: "done" }, { [field]: value } as HumanOptions),
      new RegExp(`Human ${field} requires choices or suggestions`));
  }
  const suggestions = ["retry", "discard"];
  for (const [options, message] of [
    [{ recommended: "unknown" }, "Human recommended must be one of the suggestions"],
    [{ effects: { unknown: "Does nothing." } }, "Human effects contains an unknown suggestion: unknown"],
    [{ effects: [] }, "Human effects must map suggestions to sentences"],
    [{ discards: ["unknown"] }, "Human discards must contain only suggestions"],
    [{ discards: ["discard", "discard"] }, "Human discards must not repeat a suggestion"],
    [{ recommended: "retry", discards: ["retry"] }, "Human discards must not include the recommended suggestion"],
  ] as const) {
    assert.throws(() => human("Choose", { submitted: "done" }, { suggestions, ...options } as HumanOptions),
      (error: unknown) => error instanceof Error && error.message.includes(message));
  }
  // JavaScript callers with both lists retain choices precedence.
  assert.throws(() => human("Choose", { submitted: "done" }, {
    choices: ["approve"], suggestions, recommended: "retry",
  } as unknown as HumanOptions), /Human recommended must be one of the choices/u);
});
