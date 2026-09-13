import path from "node:path";
import { fileURLToPath } from "node:url";

/** Resolve a checked-in provider schema from both src/ and compiled dist/. */
export function providerSchemaPath(fileName: string): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../schemas", fileName);
}
