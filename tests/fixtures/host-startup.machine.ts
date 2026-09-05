import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";

// Preflight has not returned a MachineHostRun yet, but already owns processes.
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
await writeFile("child.pid", String(child.pid));
await new Promise<never>(() => {});
