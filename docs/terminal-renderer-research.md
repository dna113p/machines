# Terminal renderer research

Research snapshot: 2026-08-31.

## Recommendation

Use **`yocto-spinner` 1.2.2** for the first live Machines status line.

It is the smallest current option that solves the important problem, not merely the visible one:

- one in-place status line;
- automatic coordination with both `process.stdout.write()` and `process.stderr.write()`;
- no ownership of stdin;
- plain, non-animated output outside an interactive terminal;
- one direct dependency and Node 18.19+ support.

That makes it a better fit than Ora for this deliberately small CLI. Ora remains the safer fallback if testing finds an unhandled terminal edge case.

There is one UI rule no spinner library removes: **stop or suspend animation before asking a Human for input**. `yocto-spinner` leaves stdin usable, but terminal echo can still visually fight any status line that redraws while the person types. Ora has the same issue when configured with the required `discardStdin: false`.

## Why it fits the current ACP adapter

The current [ACP adapter](../src/acp.ts) pipes the child and forwards visible output through `process.stdout.write()` and `process.stderr.write()`. `yocto-spinner` hooks both interactive process streams, clears its line around external writes, and redraws after a complete line. That is exactly the current output path.

This conclusion would change if an Agent process were later launched with inherited stdio. Writes made directly by a child to the terminal bypass JavaScript stream hooks; neither Yocto nor Ora can coordinate those automatically. Such output would need to remain piped through the parent display.

## Comparison

Package sizes below are the package's own published unpacked size, not the total installed dependency tree. Dependency counts are direct runtime dependencies. Both come from the npm registry metadata linked in each row.

| Option | ACP stdout/stderr coordination | Human input | Non-TTY behavior | Footprint / Node | Maintenance | Verdict |
|---|---|---|---|---|---|---|
| [`yocto-spinner` 1.2.2](https://github.com/sindresorhus/yocto-spinner) | Yes. Its [implementation](https://github.com/sindresorhus/yocto-spinner/blob/main/index.js) hooks the active stream plus interactive stdout and stderr, clears around writes, and defers redraw after partial output until a newline. | Does not read, discard, or put stdin into raw mode. Suspend it while a Human types for clean terminal echo. | Detects TTY, `TERM=dumb`, and CI. Outside an interactive terminal it emits static newline-terminated text and does not start the animation timer. | [20,327 bytes; 1 dependency; Node >=18.19](https://registry.npmjs.org/yocto-spinner/1.2.2) | Active; current source and package updated July 2026. | **Best match.** Smallest option that also handles the ACP write collision. |
| [`ora` 9.4.1](https://github.com/sindresorhus/ora) | Yes. Current [source](https://github.com/sindresorhus/ora/blob/main/index.js) hooks stdout/stderr and uses a short timeout for partial writes. | Defaults to discarding TTY input. Must use `discardStdin: false`; its [documentation](https://github.com/sindresorhus/ora#discardstdin) warns this can allow line twitching while typing. | Automatically disables animation outside TTY/inside CI but still logs text. | [40,673 bytes; 8 dependencies; Node >=20](https://registry.npmjs.org/ora/9.4.1) | Mature and active; current package updated June 2026. | Strong runner-up, but its extra features and stdin machinery are unnecessary here. |
| [`log-update` 8.0.0](https://github.com/sindresorhus/log-update) | No automatic interception. It offers explicit `persist()`, `clear()`, and redraw primitives, so Machines would have to own and route every output write. | Does not touch stdin. | Its [implementation](https://github.com/sindresorhus/log-update/blob/main/index.js) is a low-level renderer, not a TTY/CI fallback policy; the caller must guard it. | [18,027 bytes; 6 dependencies; Node >=22](https://registry.npmjs.org/log-update/8.0.0) | Active; current package updated April 2026. | Useful for a future multi-line widget, but more Machines code for today's one line. |
| [`nanospinner` 1.2.2](https://github.com/usmanyunusov/nanospinner) | No. Its [source](https://github.com/usmanyunusov/nanospinner/blob/master/src/index.ts) writes its own frames but does not coordinate arbitrary stdout/stderr writes. | Does not touch stdin. | Disables its loop when not in a TTY and prints a static starting line, but state-update fallback would need caller policy. | [10,853 bytes; 1 dependency; no Node engine declared](https://registry.npmjs.org/nanospinner/1.2.2) | Last source push was December 2024. | Smaller on paper, but it does not solve ACP output collisions. |
| [`picospinner` 3.1.2](https://github.com/tinylibs/picospinner) | No. Its shared [renderer](https://github.com/tinylibs/picospinner/blob/main/src/renderer.ts) tracks and clears only its own components; arbitrary writes bypass that bookkeeping. | Does not touch stdin. | No TTY/CI guard is present in the renderer, so redirected updates can contain cursor-control sequences. | [26,646 bytes; 0 dependencies; Node >=18](https://registry.npmjs.org/picospinner/3.1.2) | Active; current package published July 2026. | The notable new zero-dependency option, but ACP output coordination matters more than dependency count. |
| [`@topcli/spinner` 4.2.1](https://github.com/TopCli/Spinner) | No automatic stdout/stderr coordination. It is designed mainly for multiple simultaneous spinners. | Does not deliberately own stdin. | Current [implementation](https://github.com/TopCli/Spinner/blob/main/src/Spinner.class.ts) assumes cursor-capable output and terminal columns; no built-in pipe/CI fallback is evident. | [30,981 bytes; 1 dependency; Node >=22](https://registry.npmjs.org/@topcli/spinner/4.2.1) | Active; source updated August 2026. | New and current, but its multi-spinner focus adds the wrong capability and misses required output handling. |
| [`@clack/prompts` 1.7.0](https://github.com/bombshell-dev/clack/tree/main/packages/prompts) | Its [spinner](https://github.com/bombshell-dev/clack/blob/main/packages/prompts/src/spinner.ts) manages only its own output; it does not intercept ACP writes. | The spinner intentionally calls Clack's [`block()`](https://github.com/bombshell-dev/clack/blob/main/packages/core/src/utils/index.ts), which creates a readline interface and puts TTY stdin into raw mode. It must be stopped before another Human prompt. | Has CI-specific output behavior, but it is a full prompt/UI package rather than a narrow renderer. | [116,266 bytes; 4 dependencies; Node >=20.12](https://registry.npmjs.org/@clack/prompts/1.7.0) | Very active; source updated August 2026. | Attractive if Clack owned the entire Human UI, but that would broaden scope and couple two independent concerns. |
| Native Node `readline` / TTY methods | No automatic coordination. Node supplies [`clearLine`, `cursorTo`, and `moveCursor`](https://nodejs.org/api/readline.html#readlineclearlinestream-dir-callback), not stream multiplexing. | Fully under our control. | Fully under our control. | 0 dependencies. | Part of Node. | Lowest dependency count, but recreates the hard stream-hooking, partial-write, wrapping, signal, and fallback behavior already present in Yocto. |

## Important limits

- A renderer can place the Pi startup banner cleanly above the status line; it cannot decide that the banner should not exist. Suppressing it remains a Pi/`pi-acp` launch-setting concern.
- Use one spinner only. Yocto and Ora both warn against concurrent spinners, and Machines currently has exactly one authoritative state.
- Keep elapsed time in the spinner text and update it on a lightweight timer. The XState observer remains the only source of state transitions.
- For redirected output, plain state lines are more useful than ANSI animation. Do not force-enable a spinner in CI or pipes.

## Minimal shape

The intended adapter remains presentation-only:

```ts
const status = yoctoSpinner({
  text: "worktree-task · implement · 0s",
  handleSignals: false,
}).start();

status.text = "worktree-task · implement · 12s";
status.success("worktree-task · done");
```

No workflow protocol, renderer registry, or second state model is needed.
