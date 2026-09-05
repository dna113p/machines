import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const destination = join(root, "build/codex/machines");
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
for (const entry of ["dist", "docs", "skills", "README.md", "AGENTS.md", "LICENSE", "package.json", "package-lock.json"]) {
  await cp(join(root, entry), join(destination, entry), { recursive: true });
}
for (const entry of [".codex-plugin", ".mcp.json"]) {
  await cp(join(root, "codex/machines", entry), join(destination, entry), { recursive: true });
}

// Keep the lockfile unchanged for npm ci; scripts are deliberately disabled.
execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", [
  "ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund",
], { cwd: destination, stdio: "inherit" });
const metadata = JSON.parse(await readFile(join(destination, "package.json"), "utf8"));
delete metadata.scripts;
delete metadata.devDependencies;
await writeFile(join(destination, "package.json"), `${JSON.stringify(metadata, null, 2)}\n`);
console.log(`Portable Codex plugin: ${destination}`);
