import { test } from "node:test";
import assert from "node:assert";
import { setActiveProfile, getActiveProfile, isServiceExcluded } from "../src/profile.ts";
import { loadConfig } from "../src/config.ts";
import path from "node:path";
import os from "node:os";

test("profile: henry is default", () => {
  const profile = getActiveProfile();
  assert.strictEqual(profile.id, "henry");
  assert.strictEqual(profile.name, "Henry");
});

test("profile: kelly can be activated", () => {
  // Save original profile
  const original = getActiveProfile();
  try {
    setActiveProfile("kelly");
    const profile = getActiveProfile();
    assert.strictEqual(profile.id, "kelly");
    assert.strictEqual(profile.name, "Kelly");
  } finally {
    // Restore original
    setActiveProfile(original.id);
  }
});

test("profile: kelly excludes forbidden services", () => {
  const original = getActiveProfile();
  try {
    setActiveProfile("kelly");
    const excludedServices = [
      "gmail",
      "jobs",
      "cover",
      "tailor",
      "resumeEditor",
      "draftReplies",
      "meetings",
      "screenshots",
      "social",
      "linkedin",
      "xBrowser",
      "mailwatch",
      "launch",
      "standup",
      "standupPoller",
    ];
    for (const service of excludedServices) {
      assert.strictEqual(
        isServiceExcluded(service),
        true,
        `Service ${service} should be excluded for kelly`,
      );
    }
  } finally {
    setActiveProfile(original.id);
  }
});

test("profile: henry excludes no services", () => {
  const original = getActiveProfile();
  try {
    setActiveProfile("henry");
    const services = [
      "gmail",
      "jobs",
      "cover",
      "tailor",
      "resumeEditor",
      "draftReplies",
      "meetings",
      "screenshots",
      "social",
      "linkedin",
      "xBrowser",
      "mailwatch",
      "launch",
      "standup",
      "standupPoller",
    ];
    for (const service of services) {
      assert.strictEqual(
        isServiceExcluded(service),
        false,
        `Service ${service} should not be excluded for henry`,
      );
    }
  } finally {
    setActiveProfile(original.id);
  }
});

test("config: henry uses HENRY_ prefix", () => {
  const original = getActiveProfile();
  try {
    setActiveProfile("henry");
    process.env.HENRY_DATA_DIR = "/test/henry/data";
    process.env.KELLY_DATA_DIR = "/test/kelly/data";

    const config = loadConfig();
    assert.match(config.dataDir, /henry/, "Henry should use HENRY_ prefixed vars");
  } finally {
    setActiveProfile(original.id);
    delete process.env.HENRY_DATA_DIR;
    delete process.env.KELLY_DATA_DIR;
  }
});

test("config: kelly uses KELLY_ prefix", () => {
  const original = getActiveProfile();
  try {
    setActiveProfile("kelly");
    process.env.KELLY_DATA_DIR = "/test/kelly/data";
    process.env.HENRY_DATA_DIR = "/test/henry/data";

    const config = loadConfig();
    assert.match(config.dataDir, /kelly/, "Kelly should use KELLY_ prefixed vars");
  } finally {
    setActiveProfile(original.id);
    delete process.env.KELLY_DATA_DIR;
    delete process.env.HENRY_DATA_DIR;
  }
});

test("config: kelly and henry have separate root paths", () => {
  const original = getActiveProfile();
  try {
    setActiveProfile("henry");
    process.env.HENRY_DATA_DIR = "/tmp/henry-data";
    process.env.HENRY_MEMORY_DIR = "/tmp/henry-memory";
    const henryConfig = loadConfig();

    setActiveProfile("kelly");
    process.env.KELLY_DATA_DIR = "/tmp/kelly-data";
    process.env.KELLY_MEMORY_DIR = "/tmp/kelly-memory";
    const kellyConfig = loadConfig();

    assert.notStrictEqual(
      henryConfig.dataDir,
      kellyConfig.dataDir,
      "Henry and Kelly should have separate data directories",
    );
    assert.notStrictEqual(
      henryConfig.memoryDir,
      kellyConfig.memoryDir,
      "Henry and Kelly should have separate memory directories",
    );
  } finally {
    setActiveProfile(original.id);
    delete process.env.HENRY_DATA_DIR;
    delete process.env.HENRY_MEMORY_DIR;
    delete process.env.KELLY_DATA_DIR;
    delete process.env.KELLY_MEMORY_DIR;
  }
});

test("config: henry env prefix is HENRY_", () => {
  const original = getActiveProfile();
  try {
    setActiveProfile("henry");
    const profile = getActiveProfile();
    assert.strictEqual(profile.envPrefix, "HENRY_");
  } finally {
    setActiveProfile(original.id);
  }
});

test("config: kelly env prefix is KELLY_", () => {
  const original = getActiveProfile();
  try {
    setActiveProfile("kelly");
    const profile = getActiveProfile();
    assert.strictEqual(profile.envPrefix, "KELLY_");
  } finally {
    setActiveProfile(original.id);
  }
});

test("config: profileId is set correctly", () => {
  const original = getActiveProfile();
  try {
    setActiveProfile("henry");
    const henryConfig = loadConfig();
    assert.strictEqual(henryConfig.profileId, "henry");

    setActiveProfile("kelly");
    const kellyConfig = loadConfig();
    assert.strictEqual(kellyConfig.profileId, "kelly");
  } finally {
    setActiveProfile(original.id);
  }
});
