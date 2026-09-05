import { fileURLToPath } from "node:url";
import { startMachineHost } from "../../src/host.ts";

await startMachineHost({
  machine: fileURLToPath(new URL("./host-process.machine.ts", import.meta.url)),
  input: process.argv[2],
  onHumanRequest: () => process.send?.("waiting"),
});
