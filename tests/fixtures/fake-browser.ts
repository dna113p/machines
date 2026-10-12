import { createHash } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { createContext, runInContext } from "node:vm";

// A DevTools endpoint with no browser behind it. A tab loads the HTML a test gives it into the small DOM
// below and runs the page's scripts there, so code that drives a browser is tested without starting one.

export interface FakeBrowserOptions {
  /** The HTML a tab opened at `url` loads. The address itself is never fetched. */
  readonly page: (url: URL) => string;
  /** Receives the page's own `fetch` calls, which do not reach the network either. */
  readonly fetch: (url: URL, init: { readonly method?: string; readonly body?: string }) => void;
}

export interface FakeBrowser {
  readonly cdpUrl: string;
  readonly close: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// The DOM: only what the fake pages and the code under test use.

type Listener = (event: PageEvent) => unknown;

class PageDataTransfer {
  readonly #data = new Map<string, string>();

  setData(format: string, value: string): void {
    this.#data.set(format, value);
  }

  getData(format: string): string {
    return this.#data.get(format) ?? "";
  }
}

class PageEvent {
  readonly type: string;
  readonly bubbles: boolean;
  readonly key: string | undefined;
  readonly clipboardData: PageDataTransfer | undefined;
  target: PageTarget | undefined;
  defaultPrevented = false;

  constructor(type: string, init: { bubbles?: boolean; key?: string; clipboardData?: PageDataTransfer } = {}) {
    this.type = type;
    this.bubbles = init.bubbles ?? false;
    this.key = init.key;
    this.clipboardData = init.clipboardData;
  }

  preventDefault(): void {
    this.defaultPrevented = true;
  }
}

class PageTarget {
  parentNode: PageTarget | undefined;
  readonly #listeners = new Map<string, Set<Listener>>();

  addEventListener(type: string, listener: Listener, options: { once?: boolean } = {}): void {
    const listeners = this.#listeners.get(type) ?? new Set<Listener>();
    this.#listeners.set(type, listeners);
    const added: Listener = options.once !== true ? listener : event => {
      listeners.delete(added);
      return listener(event);
    };
    listeners.add(added);
  }

  dispatchEvent(event: PageEvent): boolean {
    event.target ??= this;
    for (let node: PageTarget | undefined = this; node !== undefined; node = event.bubbles ? node.parentNode : undefined) {
      for (const listener of [...node.#listeners.get(event.type) ?? []]) listener(event);
    }
    return !event.defaultPrevented;
  }
}

class PageText {
  parentNode: PageElement | undefined;
  readonly data: string;

  constructor(data: string) {
    this.data = data;
  }

  remove(): void {
    const siblings = this.parentNode?.childNodes;
    if (siblings !== undefined) siblings.splice(siblings.indexOf(this), 1);
    this.parentNode = undefined;
  }
}

type PageNode = PageElement | PageText;
type Matcher = (element: PageElement) => boolean;

const blocks = new Set(["body", "div", "form", "html", "main", "p"]);
const rowHeight = 10;
const matchers = new Map<string, Matcher>();
let rows = 0;

const dataAttribute = (name: string) => `data-${name.replace(/[A-Z]/gu, letter => `-${letter.toLowerCase()}`)}`;

/** Reads a selector list of compound selectors: a tag, ids, classes, and `[name]`, `[name="value"]`, `[name$="value"]`. */
function matcher(selector: string): Matcher {
  const known = matchers.get(selector);
  if (known !== undefined) return known;
  const alternatives = (selector.match(/(?:[^,"]|"[^"]*")+/gu) ?? []).map(source => {
    const tests: Matcher[] = [];
    let rest = source.trim();
    const take = (pattern: RegExp) => {
      const found = pattern.exec(rest);
      if (found !== null) rest = rest.slice(found[0].length);
      return found;
    };
    const tag = take(/^[a-z][\w-]*/iu)?.[0].toLowerCase();
    if (tag !== undefined) tests.push(element => element.localName === tag);
    while (rest !== "") {
      const id = take(/^#([\w-]+)/u)?.[1];
      const name = id === undefined ? take(/^\.([\w-]+)/u)?.[1] : undefined;
      const attribute = id === undefined && name === undefined ? take(/^\[([\w-]+)(?:(\$?=)"([^"]*)")?\]/u) : null;
      if (id !== undefined) tests.push(element => element.id === id);
      else if (name !== undefined) tests.push(element => element.className.split(/\s+/u).includes(name));
      else if (attribute !== null) {
        const [, key = "", operator, expected = ""] = attribute;
        tests.push(element => {
          const value = element.getAttribute(key);
          if (value === null) return false;
          return operator === undefined || (operator === "=" ? value === expected : value.endsWith(expected));
        });
      } else throw new Error(`The fake page does not support the selector "${source.trim()}"`);
    }
    if (tests.length === 0) throw new Error(`The fake page does not support the selector "${selector}"`);
    return (element: PageElement) => tests.every(test => test(element));
  });
  const compiled: Matcher = element => alternatives.some(test => test(element));
  matchers.set(selector, compiled);
  return compiled;
}

class PageElement extends PageTarget {
  readonly ownerDocument: PageDocument;
  readonly localName: string;
  readonly attributes = new Map<string, string>();
  readonly childNodes: PageNode[] = [];
  readonly dataset: Record<string, string>;
  /** A template's inert contents. */
  readonly content: PageElement | undefined;
  /** Where the element is drawn. Each has a row of its own, so a point on the page names one element. */
  readonly row = rows++;

  constructor(ownerDocument: PageDocument, localName: string) {
    super();
    this.ownerDocument = ownerDocument;
    this.localName = localName;
    this.content = localName === "template" ? new PageElement(ownerDocument, "#fragment") : undefined;
    this.dataset = new Proxy({}, {
      get: (_, name) => typeof name === "string" ? this.attributes.get(dataAttribute(name)) : undefined,
      set: (_, name, value) => {
        this.attributes.set(dataAttribute(String(name)), String(value));
        return true;
      },
    });
  }

  get id(): string {
    return this.attributes.get("id") ?? "";
  }

  get className(): string {
    return this.attributes.get("class") ?? "";
  }

  set className(value: string) {
    this.attributes.set("class", value);
  }

  get hidden(): boolean {
    return this.attributes.has("hidden");
  }

  set hidden(value: boolean) {
    if (value) this.attributes.set("hidden", "");
    else this.attributes.delete("hidden");
  }

  get parentElement(): PageElement | null {
    return this.parentNode instanceof PageElement ? this.parentNode : null;
  }

  get children(): PageElement[] {
    return this.childNodes.filter(child => child instanceof PageElement);
  }

  get lastElementChild(): PageElement | null {
    return this.children.at(-1) ?? null;
  }

  get isConnected(): boolean {
    for (let node: PageTarget | undefined = this; node !== undefined; node = node.parentNode) {
      if (node === this.ownerDocument) return true;
    }
    return false;
  }

  /** Drawn on the page: connected, and neither it nor an element around it is hidden. */
  get shown(): boolean {
    for (let node: PageElement | null = this; node !== null; node = node.parentElement) {
      if (node.hidden) return false;
    }
    return this.isConnected;
  }

  get textContent(): string {
    return this.childNodes.map(child => child instanceof PageText ? child.data : child.textContent).join("");
  }

  set textContent(text: string) {
    this.replaceChildren(text);
  }

  /** The text as drawn: hidden parts are left out and each block is a line of its own. */
  get innerText(): string {
    const lines: string[] = [];
    let line = "";
    const end = () => {
      if (line !== "") lines.push(line);
      line = "";
    };
    const read = (node: PageNode): void => {
      if (node instanceof PageText) {
        line += node.data;
        return;
      }
      if (node.hidden) return;
      const block = blocks.has(node.localName);
      if (block) end();
      node.childNodes.forEach(read);
      if (block) end();
    };
    this.childNodes.forEach(read);
    end();
    return lines.join("\n");
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, String(value));
  }

  append(...nodes: (PageNode | string)[]): void {
    for (const given of nodes) {
      const node = typeof given === "string" ? new PageText(given) : given;
      // Appending a fragment moves what it holds.
      if (node instanceof PageElement && node.localName === "#fragment") {
        this.append(...node.childNodes);
        continue;
      }
      node.remove();
      node.parentNode = this;
      this.childNodes.push(node);
    }
  }

  remove(): void {
    const siblings = this.parentElement?.childNodes;
    if (siblings !== undefined) siblings.splice(siblings.indexOf(this), 1);
    this.parentNode = undefined;
  }

  replaceWith(node: PageElement): void {
    const parent = this.parentElement;
    if (parent === null) return;
    node.remove();
    parent.childNodes.splice(parent.childNodes.indexOf(this), 1, node);
    node.parentNode = parent;
    this.parentNode = undefined;
  }

  replaceChildren(...nodes: (PageNode | string)[]): void {
    for (const child of [...this.childNodes]) child.remove();
    this.append(...nodes);
  }

  cloneNode(deep = false): PageElement {
    const copy = this.localName === "#fragment"
      ? new PageElement(this.ownerDocument, this.localName)
      : this.ownerDocument.createElement(this.localName);
    for (const [name, value] of this.attributes) copy.attributes.set(name, value);
    if (deep) copy.append(...this.childNodes.map(child => child instanceof PageText ? new PageText(child.data) : child.cloneNode(true)));
    return copy;
  }

  contains(other: PageTarget | null): boolean {
    for (let node = other ?? undefined; node !== undefined; node = node.parentNode) {
      if (node === this) return true;
    }
    return false;
  }

  descendants(): PageElement[] {
    return this.children.flatMap(child => [child, ...child.descendants()]);
  }

  matches(selector: string): boolean {
    return matcher(selector)(this);
  }

  closest(selector: string): PageElement | null {
    for (let node: PageElement | null = this; node !== null; node = node.parentElement) {
      if (node.matches(selector)) return node;
    }
    return null;
  }

  querySelectorAll(selector: string): PageElement[] {
    return this.descendants().filter(matcher(selector));
  }

  querySelector(selector: string): PageElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  getBoundingClientRect(): { left: number; top: number; width: number; height: number } {
    return this.shown
      ? { left: 0, top: this.row * rowHeight, width: rowHeight, height: rowHeight }
      : { left: 0, top: 0, width: 0, height: 0 };
  }

  scrollIntoView(): void { /* every element is always in view */ }

  focus(): void {
    this.ownerDocument.activeElement = this;
  }
}

class PageButton extends PageElement {
  get disabled(): boolean {
    return this.attributes.has("disabled");
  }

  set disabled(value: boolean) {
    if (value) this.attributes.set("disabled", "");
    else this.attributes.delete("disabled");
  }
}

class PageTextArea extends PageElement {
  #value = "";

  get value(): string {
    return this.#value;
  }

  set value(value: string) {
    this.#value = value;
  }
}

class PageDocument extends PageTarget {
  readonly documentElement: PageElement;
  activeElement: PageElement | undefined;

  constructor() {
    super();
    this.documentElement = this.createElement("html");
    this.documentElement.parentNode = this;
  }

  get body(): PageElement | null {
    return this.documentElement.children.find(child => child.localName === "body") ?? null;
  }

  createElement(name: string): PageElement {
    const localName = name.toLowerCase();
    if (localName === "button") return new PageButton(this, localName);
    if (localName === "textarea") return new PageTextArea(this, localName);
    return new PageElement(this, localName);
  }

  getElementById(id: string): PageElement | null {
    return this.querySelector(`#${id}`);
  }

  querySelectorAll(selector: string): PageElement[] {
    return [this.documentElement, ...this.documentElement.descendants()].filter(matcher(selector));
  }

  querySelector(selector: string): PageElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

const entities: Readonly<Record<string, string>> = { amp: "&", gt: ">", lt: "<", quot: '"', uarr: "↑" };
const decode = (text: string) => text.replace(/&(\w+);/gu, (whole, name: string) => entities[name] ?? whole);

/** Reads the well-formed markup the fake pages use into the document and returns the pages' scripts. */
function loadHtml(document: PageDocument, html: string): string[] {
  const scripts: string[] = [];
  const open: PageElement[] = [];
  const token = /<!--[\s\S]*?-->|<![^>]*>|<\/[\w-]+>|<([\w-]+)((?:\s+[\w-]+(?:="[^"]*")?)*)\s*>|[^<]+/gy;
  let read = 0;
  for (let found = token.exec(html); found !== null; found = token.exec(html)) {
    const [text, tag, attributes = ""] = found;
    if (text.startsWith("</")) open.pop();
    else if (tag !== undefined) {
      const name = tag.toLowerCase();
      const element = name === "html" ? document.documentElement : document.createElement(name);
      for (const [, key = "", value = ""] of attributes.matchAll(/([\w-]+)(?:="([^"]*)")?/gu)) {
        element.setAttribute(key, decode(value));
      }
      if (name !== "html") open.at(-1)?.append(element);
      if (name === "script") {
        const end = html.indexOf("</script>", token.lastIndex);
        scripts.push(html.slice(token.lastIndex, end));
        token.lastIndex = end + "</script>".length;
      } else if (name !== "meta") open.push(element.content ?? element);
    } else if (!text.startsWith("<") && text.trim() !== "") open.at(-1)?.append(decode(text));
    read = token.lastIndex;
  }
  if (read !== html.length) throw new Error(`The fake page cannot read its markup from character ${read}`);
  return scripts;
}

// ---------------------------------------------------------------------------
// Tabs and the DevTools protocol

type Command = (method: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>;

interface Tab {
  readonly id: string;
  readonly url: () => string;
  readonly command: Command;
  readonly close: () => void;
}

function openTab(id: string, address: string, options: FakeBrowserOptions): Tab {
  let url = new URL(address);
  const document = new PageDocument();
  const timers = new Set<NodeJS.Timeout>();
  const visit = (_state: unknown, _title: string, path: string) => { url = new URL(path, url); };
  const context = createContext({
    document,
    location: {
      get href() { return url.href; },
      get pathname() { return url.pathname; },
      get search() { return url.search; },
    },
    history: { pushState: visit, replaceState: visit },
    fetch: async (path: string, init: { method?: string; body?: string } = {}) => {
      options.fetch(new URL(path, url), init);
      return { ok: true, status: 204 };
    },
    setTimeout: (run: () => void, ms: number) => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        run();
      }, ms);
      timers.add(timer);
    },
    URLSearchParams,
    Event: PageEvent,
    ClipboardEvent: PageEvent,
    DataTransfer: PageDataTransfer,
    HTMLElement: PageElement,
    HTMLButtonElement: PageButton,
    HTMLTextAreaElement: PageTextArea,
  });
  for (const script of loadHtml(document, options.page(url))) runInContext(script, context);

  const command: Command = async (method, params) => {
    switch (method) {
      case "Runtime.enable":
      case "Page.enable":
      case "Page.bringToFront":
        return {};
      case "Runtime.evaluate":
        try {
          const value: unknown = await runInContext(String(params.expression), context);
          return { result: value === undefined ? { type: "undefined" } : { type: typeof value, value } };
        } catch (cause) {
          return { result: { type: "object" }, exceptionDetails: { text: "Uncaught", exception: { description: String(cause) } } };
        }
      case "Input.dispatchMouseEvent": {
        const row = Math.floor(Number(params.y) / rowHeight);
        const target = document.documentElement.descendants().find(element => element.shown && element.row === row);
        if (target === undefined || (target instanceof PageButton && target.disabled)) return {};
        if (params.type === "mousePressed") target.focus();
        const events = params.type === "mousePressed" ? ["pointerdown", "mousedown"]
          : params.type === "mouseReleased" ? ["pointerup", "mouseup", "click"]
          : ["mousemove"];
        for (const type of events) target.dispatchEvent(new PageEvent(type, { bubbles: true }));
        return {};
      }
      case "Input.dispatchKeyEvent": {
        const target = document.activeElement?.isConnected === true ? document.activeElement : document.body;
        const type = params.type === "keyDown" ? "keydown" : "keyup";
        target?.dispatchEvent(new PageEvent(type, { bubbles: true, key: String(params.key) }));
        return {};
      }
      case "Input.insertText": {
        const target = document.activeElement;
        if (target?.getAttribute("contenteditable") !== "true") return {};
        target.append(String(params.text));
        target.dispatchEvent(new PageEvent("input", { bubbles: true }));
        return {};
      }
      default:
        throw new Error(`The fake browser does not answer ${method}`);
    }
  };
  return {
    id,
    url: () => url.href,
    command,
    close: () => {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    },
  };
}

/** Completes a WebSocket handshake and returns a function that sends one text message. */
function acceptWebSocket(request: IncomingMessage, socket: Duplex, receive: (text: string) => void): (text: string) => void {
  const accept = createHash("sha1")
    .update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  let buffered = Buffer.alloc(0);
  const fragments: Buffer[] = [];
  socket.on("data", (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk]);
    // A client frame: two header bytes, an extended length for longer payloads, a four-byte mask, the payload.
    while (buffered.length >= 2) {
      let length = buffered.readUInt8(1) & 0x7f;
      let header = 2;
      if (length === 126 && buffered.length >= 4) {
        length = buffered.readUInt16BE(2);
        header = 4;
      } else if (length === 127 && buffered.length >= 10) {
        length = Number(buffered.readBigUInt64BE(2));
        header = 10;
      } else if (length >= 126) return;
      const end = header + 4 + length;
      if (buffered.length < end) return;
      const first = buffered.readUInt8(0);
      const mask = buffered.subarray(header, header + 4);
      const payload = Buffer.from(buffered.subarray(header + 4, end));
      for (let index = 0; index < payload.length; index += 1) {
        payload.writeUInt8(payload.readUInt8(index) ^ mask.readUInt8(index % 4), index);
      }
      buffered = buffered.subarray(end);
      const opcode = first & 0x0f;
      if (opcode === 0x8) {
        socket.end(Buffer.from([0x88, 0]));
        return;
      }
      if (opcode > 0x2) continue;
      fragments.push(payload);
      if ((first & 0x80) !== 0) receive(Buffer.concat(fragments.splice(0)).toString("utf8"));
    }
  });
  return text => {
    if (!socket.writable) return;
    const payload = Buffer.from(text, "utf8");
    const header = payload.length < 126 ? Buffer.from([0x81, payload.length])
      : payload.length < 65_536 ? Buffer.from([0x81, 126, payload.length >> 8, payload.length & 0xff])
      : Buffer.concat([Buffer.from([0x81, 127]), Buffer.alloc(8)]);
    if (header.length === 10) header.writeBigUInt64BE(BigInt(payload.length), 2);
    socket.write(Buffer.concat([header, payload]));
  };
}

/** Starts a DevTools endpoint on a local port. It speaks the HTTP and WebSocket parts a DevTools client uses. */
export async function startFakeBrowser(options: FakeBrowserOptions): Promise<FakeBrowser> {
  const tabs = new Map<string, Tab>();
  const sockets = new Set<Duplex>();
  let opened = 0;
  let host = "";
  const browserCommand: Command = async (method, params) => {
    if (method !== "Target.createTarget") throw new Error(`The fake browser does not answer ${method}`);
    const tab = openTab(`tab-${opened += 1}`, String(params.url), options);
    tabs.set(tab.id, tab);
    return { targetId: tab.id };
  };

  const server = createServer((request, response) => {
    const send = (body: unknown) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    const closing = tabs.get(/^\/json\/close\/(.+)$/u.exec(request.url ?? "")?.[1] ?? "");
    if (request.url === "/json/version") send({ Browser: "Fake", webSocketDebuggerUrl: `ws://${host}/devtools/browser` });
    else if (request.url === "/json/list") {
      send([...tabs.values()].map(tab => ({
        id: tab.id,
        type: "page",
        url: tab.url(),
        webSocketDebuggerUrl: `ws://${host}/devtools/page/${tab.id}`,
      })));
    } else if (closing !== undefined) {
      closing.close();
      tabs.delete(closing.id);
      send("Target is closing");
    } else {
      response.writeHead(404);
      response.end();
    }
  });
  server.on("upgrade", (request: IncomingMessage, socket: Duplex) => {
    const command = request.url === "/devtools/browser" ? browserCommand
      : tabs.get(/^\/devtools\/page\/(.+)$/u.exec(request.url ?? "")?.[1] ?? "")?.command;
    if (command === undefined) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => { /* the client went away */ });
    const reply = acceptWebSocket(request, socket, text => {
      const { id, method, params = {} } = JSON.parse(text) as { id: number; method: string; params?: Record<string, unknown> };
      command(method, params).then(
        result => reply(JSON.stringify({ id, result })),
        (cause: unknown) => reply(JSON.stringify({ id, error: { message: cause instanceof Error ? cause.message : String(cause) } })),
      );
    });
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  host = `127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    cdpUrl: `http://${host}`,
    close: async () => {
      for (const tab of tabs.values()) tab.close();
      for (const socket of sockets) socket.destroy();
      await new Promise(done => server.close(done));
    },
  };
}
