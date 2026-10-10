import { terminalHuman } from "../../src/terminal-human.ts";

// Stands in for a terminal: the picker needs TTY streams and raw mode, and
// reports what it did to them once its question is withdrawn.
const rawModes: boolean[] = [];
Object.assign(process.stdin, {
  isTTY: true,
  isRaw: false,
  setRawMode(mode: boolean) {
    rawModes.push(mode);
    return process.stdin;
  },
});
Object.assign(process.stdout, { isTTY: true });

const asked = new AbortController();
const answer = terminalHuman({ prompt: "Approve?", choices: ["approve", "deny"] }, asked.signal);
setTimeout(() => asked.abort(new Error("answered elsewhere")), 50);
const outcome = await answer.catch((cause: Error) => `rejected: ${cause.message}`);

console.error(JSON.stringify({
  outcome,
  rawModes,
  keypressListeners: process.stdin.listenerCount("keypress"),
  paused: process.stdin.isPaused(),
}));
