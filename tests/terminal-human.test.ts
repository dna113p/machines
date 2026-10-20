import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { terminalHuman } from "../src/terminal-human.ts";
import { presentation, presentedPrompt, suggestedPresentation } from "./sleep-machines.ts";

for (const tty of [false, true]) {
  test(`the ${tty ? "selector" : "free-form prompt"} shows presentation and returns the choice name`, async () => {
    const input = Object.assign(new PassThrough(), {
      isTTY: tty, isRaw: false,
      setRawMode(raw: boolean) { this.isRaw = raw; return this; },
    });
    const output = Object.assign(new PassThrough(), { isTTY: tty });
    let text = "";
    output.on("data", chunk => { text += String(chunk); });
    const stdin = Object.getOwnPropertyDescriptor(process, "stdin")!;
    const stdout = Object.getOwnPropertyDescriptor(process, "stdout")!;
    try {
      Object.defineProperty(process, "stdin", { configurable: true, value: input });
      Object.defineProperty(process, "stdout", { configurable: true, value: output });
      const answer = terminalHuman({ prompt: presentedPrompt, ...presentation });
      if (tty) input.emit("keypress", "\r", { name: "return" });
      else input.write("approve\n");
      assert.equal(await answer, "approve");
      assert.equal(input.isRaw, false);
      assert.ok(text.indexOf(presentation.headline) >= 0);
      assert.ok(text.indexOf(presentation.headline) < text.indexOf(presentedPrompt));
      assert.match(text, /approve \(recommended\)/u);
      assert.doesNotMatch(text, /retry \(recommended\)/u);
      assert.match(text, /discard \(discards work\)/u);
      assert.ok(text.includes(presentation.effects.approve));
    } finally {
      Object.defineProperty(process, "stdin", stdin);
      Object.defineProperty(process, "stdout", stdout);
      input.destroy();
      output.destroy();
    }
  });
}

for (const tty of [false, true]) {
  test(`the ${tty ? "selector" : "free-form prompt"} shows suggestion presentation and accepts a free reply`, async () => {
    const input = Object.assign(new PassThrough(), {
      isTTY: tty, isRaw: false,
      setRawMode(raw: boolean) { this.isRaw = raw; return this; },
    });
    const output = Object.assign(new PassThrough(), { isTTY: tty });
    let text = "";
    output.on("data", chunk => { text += String(chunk); });
    const stdin = Object.getOwnPropertyDescriptor(process, "stdin")!;
    const stdout = Object.getOwnPropertyDescriptor(process, "stdout")!;
    try {
      Object.defineProperty(process, "stdin", { configurable: true, value: input });
      Object.defineProperty(process, "stdout", { configurable: true, value: output });
      const answer = terminalHuman({ prompt: presentedPrompt, ...suggestedPresentation });
      if (tty) {
        input.emit("keypress", undefined, { name: "up" });
        input.emit("keypress", "\r", { name: "return" });
      }
      input.write("something else\n");
      assert.equal(await answer, "something else");
      assert.equal(input.isRaw, false);
      assert.ok(text.indexOf(suggestedPresentation.headline) >= 0);
      assert.ok(text.indexOf(suggestedPresentation.headline) < text.indexOf(presentedPrompt));
      assert.match(text, /more rounds \(recommended\)/u);
      assert.doesNotMatch(text, /stop \(recommended\)/u);
      assert.match(text, /discard \(discards work\)/u);
      assert.ok(text.includes(suggestedPresentation.effects["more rounds"]));
    } finally {
      Object.defineProperty(process, "stdin", stdin);
      Object.defineProperty(process, "stdout", stdout);
      input.destroy();
      output.destroy();
    }
  });
}
