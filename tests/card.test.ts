import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const html = readFileSync(new URL("../codex/machines/ui/machines.html", import.meta.url), "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/u)?.[1];
assert.ok(script, "The shipped card contains its executable script");

test("polling retains the current Human input, draft, focus, and selection", async () => {
  const card = createCard();
  const input = card.input();
  input.value = "Please cover the edge case";
  input.focus();
  input.selectionStart = 7;
  input.selectionEnd = 12;

  card.poll();
  card.calls[0]!.resolve({ structuredContent: { runs: [waiting({ elapsedSeconds: 2 })] } });
  await flush();

  assert.equal(card.input(), input);
  assert.equal(input.value, "Please cover the edge case");
  assert.equal(card.document.activeElement, input);
  assert.equal(input.selectionStart, 7);
  assert.equal(input.selectionEnd, 12);
});

test("a new Human request clears the draft even with the same prompt", () => {
  const card = createCard();
  const previous = card.input();
  previous.value = "draft for the first request";
  card.notify(waiting({ human: { requestId: "request-2", prompt: "Your feedback?" } }));
  assert.notEqual(card.input(), previous);
  assert.equal(card.input().value, "");

  const next = card.input();
  next.value = "draft for this run";
  card.notify(waiting({ id: "run-2", human: { requestId: "request-2", prompt: "Your feedback?" } }));
  assert.notEqual(card.input(), next);
  assert.equal(card.input().value, "");
});

test("a failed MCP response preserves the draft and shows the tool error", async () => {
  const card = createCard();
  const input = card.input();
  input.value = "Keep this feedback";
  input.focus();
  card.submit();
  assert.equal(card.input(), input);
  assert.equal(input.disabled, true);
  assert.equal(JSON.stringify(card.calls[0]!.args), JSON.stringify({
    runId: "run-1", requestId: "request-1", response: "Keep this feedback",
  }));

  card.calls[0]!.resolve({ isError: true, content: [{ type: "text", text: "Response could not be delivered" }] });
  await flush();

  assert.equal(card.input(), input);
  assert.equal(input.value, "Keep this feedback");
  assert.equal(input.disabled, false);
  assert.equal(card.document.activeElement, input);
  assert.equal(card.element("error").hidden, false);
  assert.equal(card.element("error").textContent, "Response could not be delivered");
  assert.equal(card.timerCount(), 1, "polling resumes after a failed response");

  card.poll();
  card.calls[1]!.resolve({ structuredContent: { runs: [waiting()] } });
  await flush();
  assert.equal(card.element("error").textContent, "Response could not be delivered", "status polling does not erase an actionable submission error");
  card.notify(waiting({ human: { requestId: "request-2", prompt: "Your feedback?" } }));
  assert.equal(card.element("error").hidden, true);
});

test("a stale status response cannot restore a Human request after submission", async () => {
  const card = createCard();
  card.poll();
  card.input().value = "approved";
  card.submit();
  card.calls[1]!.resolve({ structuredContent: { run: waiting({ status: "running", human: undefined }) } });
  await flush();
  card.calls[0]!.resolve({ structuredContent: { runs: [waiting()] } });
  await flush();

  assert.equal(card.element("status").textContent, "running");
  assert.equal(card.element("human").hidden, true);
  assert.equal(card.timerCount(), 1);
});

test("notifications supersede in-flight polling without overlapping polls", async () => {
  const card = createCard();
  card.poll();
  card.notify(waiting({ state: "newer-state" }));
  assert.equal(card.timerCount(), 0, "the outstanding status request owns the next schedule");
  card.calls[0]!.resolve({ structuredContent: { runs: [waiting({ state: "older-state" })] } });
  await flush();

  assert.equal(card.element("state").textContent, "newer-state");
  assert.equal(card.timerCount(), 1);
});

test("MCP status errors are visible and polling retries", async () => {
  const card = createCard();
  card.poll();
  card.calls[0]!.resolve({ result: { isError: true, content: [{ type: "text", text: "Status unavailable" }] } });
  await flush();

  assert.equal(card.element("error").hidden, false);
  assert.equal(card.element("error").textContent, "Status unavailable");
  assert.equal(card.timerCount(), 1);
  assert.equal(card.nextDelay(), 3000);

  card.notify(waiting({ status: "completed", human: undefined }));
  assert.equal(card.element("error").hidden, true, "fresh notifications clear recovered status errors");
  assert.equal(card.timerCount(), 0);
});

test("an incomplete tool result reports an error and continues polling", async () => {
  const card = createCard();
  card.poll();
  card.calls[0]!.resolve({ structuredContent: { runs: [] } });
  await flush();

  assert.equal(card.element("error").hidden, false);
  assert.match(card.element("error").textContent, /did not return a run/u);
  assert.equal(card.timerCount(), 1);
  assert.equal(card.nextDelay(), 3000);
});

test("page shutdown cancels scheduling and ignores outstanding results", async () => {
  const card = createCard();
  card.poll();
  card.dispatch("pagehide", {});
  card.calls[0]!.resolve({ structuredContent: { runs: [waiting({ state: "after-shutdown" })] } });
  await flush();

  assert.equal(card.timerCount(), 0);
  assert.equal(card.element("state").textContent, "review");
});

function waiting(overrides: Record<string, unknown> = {}) {
  return {
    id: "run-1", machine: "review", status: "waiting", state: "review", elapsedSeconds: 1,
    human: { requestId: "request-1", prompt: "Your feedback?" }, ...overrides,
  };
}

function createCard() {
  // Execute the shipped script with only the DOM, bridge, and timer surfaces it uses.
  // Timers and tool promises are controlled separately to reproduce response races.
  const document: { activeElement?: Element; getElementById: (id: string) => Element; createElement: (tag: string) => Element } = {
    getElementById: (id) => {
      const element = elements.get(id);
      assert.ok(element, `The card has an element with id ${id}`);
      return element;
    },
    createElement: (tag) => new Element(tag, document),
  };
  const elements = new Map([...html.matchAll(/id="([^"]+)"/gu)].map((match) => [match[1]!, new Element("div", document)]));
  const calls: { name: string; args: unknown; resolve: (value: unknown) => void }[] = [];
  const timers = new Map<number, { callback: () => unknown; delay: number }>();
  const listeners = new Map<string, ((event: unknown) => void)[]>();
  let nextTimer = 1;
  const window = {
    parent: {},
    openai: {
      toolOutput: { run: waiting() },
      callTool: (name: string, args: unknown) => new Promise((resolve) => calls.push({ name, args, resolve })),
    },
    addEventListener: (name: string, listener: (event: unknown) => void) => {
      listeners.set(name, [...listeners.get(name) ?? [], listener]);
    },
  };
  const dispatch = (name: string, event: unknown) => listeners.get(name)?.forEach((listener) => listener(event));
  runInNewContext(script!, {
    window, document,
    setTimeout: (callback: () => unknown, delay: number) => {
      const id = nextTimer++;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout: (id: number) => timers.delete(id),
  });
  return {
    calls, document, dispatch,
    element: document.getElementById,
    input: () => findChild(document.getElementById("actions"), "input"),
    submit: () => findChild(document.getElementById("actions"), "form").onsubmit!({ preventDefault() {} }),
    notify: (run: unknown) => dispatch("message", { source: window.parent, data: {
      jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { structuredContent: { run } },
    } }),
    poll: () => {
      const entry = timers.entries().next().value;
      assert.ok(entry, "The card has scheduled a poll");
      timers.delete(entry[0]);
      entry[1].callback();
    },
    timerCount: () => timers.size,
    nextDelay: () => timers.values().next().value?.delay,
  };
}

class Element {
  children: Element[] = [];
  textContent = "";
  className = "";
  value = "";
  hidden = false;
  #disabled = false;
  type = "";
  placeholder = "";
  selectionStart = 0;
  selectionEnd = 0;
  onclick?: () => unknown;
  onsubmit?: (event: { preventDefault: () => void }) => unknown;
  tag: string;
  document: { activeElement?: Element };

  constructor(tag: string, document: { activeElement?: Element }) {
    this.tag = tag;
    this.document = document;
  }

  get disabled() { return this.#disabled; }
  set disabled(value: boolean) {
    this.#disabled = value;
    if (value && this.document.activeElement === this) this.document.activeElement = undefined;
  }

  append(...children: Element[]) { this.children.push(...children); }
  replaceChildren(...children: Element[]) {
    if (this.document.activeElement && this.contains(this.document.activeElement)) this.document.activeElement = undefined;
    this.children = children;
  }
  contains(element: Element): boolean { return this === element || this.children.some((child) => child.contains(element)); }
  focus() { this.document.activeElement = this; }
  setAttribute() {}
  querySelectorAll(selector: string): Element[] {
    return this.children.flatMap((child) => [
      ...(selector.split(",").map((tag) => tag.trim()).includes(child.tag) ? [child] : []),
      ...child.querySelectorAll(selector),
    ]);
  }
}

function findChild(element: Element, tag: string): Element {
  const found = element.querySelectorAll(tag)[0];
  assert.ok(found, `The card renders a ${tag}`);
  return found;
}

async function flush() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
