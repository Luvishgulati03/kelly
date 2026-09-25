#!/usr/bin/env node
// Kelly launcher: sets the profile and state directories before any module initialization.
// Source code root and state root are distinct concepts.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyKellyStateEnv } from "./kelly-env.mjs";

// Set Kelly profile FIRST, before any env loading or config parsing
process.env.AGENT_PROFILE = "kelly";

// State directories: exported shell value > this repository's .env > ~/.kelly/{data,memory}.
// The repo .env is read here, before the default is applied, so a second install on the same
// Mac can keep its own KELLY_DATA_DIR / KELLY_MEMORY_DIR. Test processes never read it.
applyKellyStateEnv({
  root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
  loadDotenv: process.env.HENRY_TEST_ISOLATION !== "1",
});

import { register } from "tsx/esm/api";
register();

// Set the profile in the TypeScript runtime before importing cli
const { setActiveProfile } = await import("../src/profile.ts");
setActiveProfile("kelly");

if (process.argv[2] === "start") {
  const { startKelly } = await import("./start.mjs");
  await startKelly(process.argv.slice(3)).catch((error) => {
    console.error(`Kelly startup failed: ${error.message}`);
    process.exitCode = 1;
  });
} else {
  await import("../src/cli.ts");
}
