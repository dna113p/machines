export const description = "Represents the shadowed directory discovery fixture.";

export default function shadowedDirectoryMachine() {
  throw new Error("shared.ts should win over shared/index.ts");
}
