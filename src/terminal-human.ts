import {
  clearScreenDown,
  createInterface,
  cursorTo,
  emitKeypressEvents,
  moveCursor,
} from "node:readline";

import { cyan, dim, green } from "yoctocolors";

import type { HumanRequest } from "./index.ts";

export function terminalHuman(request: HumanRequest): Promise<string> {
  const values = request.choices ?? request.suggestions ?? [];
  const allowOther = request.suggestions !== undefined;
  if (
    values.length > 0
    && process.stdin.isTTY
    && process.stdout.isTTY
    && typeof process.stdin.setRawMode === "function"
  ) {
    return selectHumanInput(request.prompt, values, allowOther);
  }

  return readFreeformInput(
    request.prompt,
    values,
    allowOther ? "Suggestions" : "Choices",
  );
}

function readFreeformInput(
  prompt: string,
  values: readonly string[] = [],
  heading = "Suggestions",
): Promise<string> {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  const suggestionText = values.length === 0
    ? ""
    : `\n${heading}:\n${values.map((value) => `- ${value}`).join("\n")}`;

  return new Promise((resolve, reject) => {
    let answered = false;

    terminal.once("close", () => {
      if (!answered) reject(new Error("Terminal input closed before a response"));
    });

    terminal.question(`${prompt}${suggestionText}\n> `, (answer) => {
      answered = true;
      terminal.close();
      resolve(answer);
    });
  });
}

function selectHumanInput(
  prompt: string,
  values: readonly string[],
  allowOther: boolean,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const choices = allowOther ? [...values, "Other…"] : [...values];
    const initialRawMode = process.stdin.isRaw;
    let selected = 0;
    let renderedLines = 0;

    function clearMenu() {
      if (renderedLines === 0) return;
      moveCursor(process.stdout, 0, -renderedLines);
      cursorTo(process.stdout, 0);
      clearScreenDown(process.stdout);
      renderedLines = 0;
    }

    function render() {
      clearMenu();
      const lines = choices.map((choice, index) => (
        index === selected ? `${cyan("❯")} ${cyan(choice)}` : `  ${choice}`
      ));
      lines.push(dim("↑↓ select · enter confirm"));
      process.stdout.write(`${lines.join("\n")}\n`);
      renderedLines = lines.length;
    }

    function cleanup() {
      process.stdin.off("keypress", onKeypress);
      process.stdin.off("end", onInputClosed);
      process.stdin.off("close", onInputClosed);
      process.stdin.setRawMode(initialRawMode ?? false);
      if (!initialRawMode) process.stdin.pause();
    }

    function onInputClosed() {
      cleanup();
      reject(new Error("Terminal input closed before a response"));
    }

    function onKeypress(_character: string | undefined, key: { name?: string; ctrl?: boolean }) {
      if (key.ctrl && key.name === "c") {
        clearMenu();
        cleanup();
        process.kill(process.pid, "SIGINT");
      } else if (key.name === "up" || key.name === "down") {
        const direction = key.name === "up" ? -1 : 1;
        selected = (selected + direction + choices.length) % choices.length;
        render();
      } else if (key.name === "return" || key.name === "enter") {
        const answer = choices[selected];
        if (answer === undefined) return;
        clearMenu();
        cleanup();

        if (!allowOther || selected < values.length) {
          process.stdout.write(`${green("✔")} ${answer}\n`);
          resolve(answer);
        } else {
          void readFreeformInput("Feedback").then(resolve, reject);
        }
      }
    }

    process.stdout.write(`${prompt}\n\n`);
    emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.on("keypress", onKeypress);
    process.stdin.once("end", onInputClosed);
    process.stdin.once("close", onInputClosed);
    process.stdin.resume();
    render();
  });
}
