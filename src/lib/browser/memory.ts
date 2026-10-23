import projectMemory from "../../../.tiphys/MEMORY.md?raw";

/** Project memory bundled at build time; the browser cannot read arbitrary disk files. */
export function browserProjectMemory(): string {
  return projectMemory.trim();
}
