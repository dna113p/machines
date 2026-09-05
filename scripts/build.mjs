import { execFileSync } from "node:child_process";
import { chmod, cp, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
await rm(new URL("../dist", import.meta.url), { recursive: true, force: true });
execFileSync(process.execPath, ["node_modules/typescript/bin/tsc", "-p", "tsconfig.build.json"], {
  cwd: root,
  stdio: "inherit",
});
const assets = new URL("../dist/codex/machines/ui/", import.meta.url);
await mkdir(assets, { recursive: true });
await cp(new URL("../codex/machines/ui/", import.meta.url), assets, { recursive: true });
await chmod(new URL("../dist/src/cli.js", import.meta.url), 0o755);
