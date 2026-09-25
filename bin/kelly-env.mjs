// Resolves where a Kelly install keeps its state, before any module reads the environment.
//
// Order: an exported shell value wins, then the repository's own .env (root-anchored, so the
// caller's cwd never matters), then the historical default ~/.kelly/{data,memory}. The .env
// must be read FIRST: applying the ~/.kelly default before it would make a .env value
// impossible, and every clone on one Mac would silently share a single catalogue, user list
// and memory.

import os from "node:os";
import path from "node:path";
import dotenv from "dotenv";

const STATE_KEYS = [["KELLY_DATA_DIR", "data"], ["KELLY_MEMORY_DIR", "memory"]];

/** `~` and `~/x` expand to the home directory; relative paths resolve from the repository root. */
export function resolveStateDir(value, root, homedir = os.homedir()) {
  if (value === "~") return homedir;
  if (value.startsWith("~/")) return path.join(homedir, value.slice(2));
  return path.resolve(root, value);
}

export function applyKellyStateEnv({ root, env = process.env, homedir = os.homedir(), loadDotenv = true } = {}) {
  // dotenv never overrides a variable that is already set, so an exported value still wins.
  if (loadDotenv) dotenv.config({ path: path.join(root, ".env"), processEnv: env, quiet: true });
  for (const [key, sub] of STATE_KEYS) {
    env[key] = env[key] ? resolveStateDir(env[key], root, homedir) : path.join(homedir, ".kelly", sub);
  }
  return env;
}
