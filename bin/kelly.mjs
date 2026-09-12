#!/usr/bin/env node
// Kelly launcher: sets profile and default state directory before any module initialization.
// Source code root and state root are distinct concepts.

import os from "node:os";
import path from "node:path";

// Set Kelly profile FIRST, before any env loading or config parsing
process.env.AGENT_PROFILE = "kelly";

// Determine Kelly's state directory (separate from source root)
// Priority: explicit KELLY_DATA_DIR → ~/.kelly → other KELLY_* vars
const kellyHome = path.join(os.homedir(), ".kelly");
if (!process.env.KELLY_DATA_DIR && !process.env.KELLY_MEMORY_DIR) {
  // Only set defaults if not explicitly overridden
  if (!process.env.KELLY_DATA_DIR) process.env.KELLY_DATA_DIR = path.join(kellyHome, "data");
  if (!process.env.KELLY_MEMORY_DIR) process.env.KELLY_MEMORY_DIR = path.join(kellyHome, "memory");
}

// Do NOT load Henry's .env; let profile-aware config handle Kelly vars
// (The repo's .env is loaded for Henry; Kelly has separate state)

import { register } from "tsx/esm/api";
register();

// Set the profile in the TypeScript runtime before importing cli
const { setActiveProfile } = await import("../src/profile.ts");
setActiveProfile("kelly");

await import("../src/cli.ts");
