import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Temp directories a test creates are removed when that test ends (or, for a directory made
 * outside a test, when the process exits). Tests used to leave thousands of `kelly-*` and
 * `henry-*` directories in os.tmpdir().
 */
const leftovers = new Set<string>();
let exitHookInstalled = false;

function removeLater(dir: string): void {
  leftovers.add(dir);
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once("exit", () => {
    for (const leftover of leftovers) {
      try { fs.rmSync(leftover, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });
}

/** A fresh `os.tmpdir()/<prefix>XXXXXX` directory, removed after the test (or at process exit). */
export function tempDir(prefix: string, t?: { after(fn: () => void): void }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  removeLater(dir);
  t?.after(() => {
    leftovers.delete(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}
