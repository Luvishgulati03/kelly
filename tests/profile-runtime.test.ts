import { test } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setActiveProfile, getActiveProfile } from "../src/profile.ts";
import { HenryRuntime } from "../src/runtime.ts";

/** Create a temporary isolated test root that won't touch ~/.henry or ~/.kelly. */
function createTempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "henry-runtime-test-"));
}

test("runtime: henry initializes all services", async () => {
  const original = getActiveProfile();
  const tempRoot = createTempRoot();
  try {
    setActiveProfile("henry");
    // Pass explicit temp root to ensure tests don't use home directories
    const runtime = await HenryRuntime.create(tempRoot);

    assert.ok(runtime.gmail, "Henry should have gmail service");
    assert.ok(runtime.jobs, "Henry should have jobs service");
    assert.ok(runtime.cover, "Henry should have cover service");
    assert.ok(runtime.tailor, "Henry should have tailor service");
    assert.ok(runtime.resumeEditor, "Henry should have resumeEditor service");
    assert.ok(runtime.draftReplies, "Henry should have draftReplies service");
    assert.ok(runtime.meetings, "Henry should have meetings service");
    assert.ok(runtime.screenshots, "Henry should have screenshots service");
    assert.ok(runtime.linkedin, "Henry should have linkedin service");
    assert.ok(runtime.launch, "Henry should have launch service");
    assert.ok(runtime.xBrowser, "Henry should have xBrowser service");
    assert.ok(runtime.mailwatch, "Henry should have mailwatch service");

    runtime.close();
  } finally {
    setActiveProfile(original.id);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("runtime: kelly excludes forbidden services", async () => {
  const original = getActiveProfile();
  const tempRoot = createTempRoot();
  try {
    setActiveProfile("kelly");
    // Pass explicit temp root to ensure tests don't use ~/.kelly
    const runtime = await HenryRuntime.create(tempRoot);

    assert.ok(!runtime.gmail, "Kelly should not have gmail service");
    assert.ok(!runtime.jobs, "Kelly should not have jobs service");
    assert.ok(!runtime.cover, "Kelly should not have cover service");
    assert.ok(!runtime.tailor, "Kelly should not have tailor service");
    assert.ok(!runtime.resumeEditor, "Kelly should not have resumeEditor service");
    assert.ok(!runtime.draftReplies, "Kelly should not have draftReplies service");
    assert.ok(!runtime.meetings, "Kelly should not have meetings service");
    assert.ok(!runtime.screenshots, "Kelly should not have screenshots service");
    assert.ok(!runtime.linkedin, "Kelly should not have linkedin service");
    assert.ok(!runtime.launch, "Kelly should not have launch service");
    assert.ok(!runtime.xBrowser, "Kelly should not have xBrowser service");
    assert.ok(!runtime.mailwatch, "Kelly should not have mailwatch service");

    // But Kelly should have the required services
    assert.ok(runtime.activity, "Kelly should have activity service");
    assert.ok(runtime.approvals, "Kelly should have approvals service");
    assert.ok(runtime.memory, "Kelly should have memory service");
    assert.ok(runtime.agent, "Kelly should have agent service");
    assert.ok(runtime.luna, "Kelly should have luna orchestrator");
    assert.ok(runtime.reminders, "Kelly should have reminders service");
    assert.ok(runtime.scheduler, "Kelly should have scheduler service");

    runtime.close();
  } finally {
    setActiveProfile(original.id);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("runtime: kelly throws error when accessing standup", async () => {
  const original = getActiveProfile();
  const tempRoot = createTempRoot();
  try {
    setActiveProfile("kelly");
    const runtime = await HenryRuntime.create(tempRoot);

    assert.throws(
      () => {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const _ = runtime.standup;
      },
      { message: /not available in this profile/ },
      "Kelly should throw when accessing standup service",
    );

    assert.throws(
      () => {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const _ = runtime.standupPoller;
      },
      { message: /not available in this profile/ },
      "Kelly should throw when accessing standupPoller service",
    );

    runtime.close();
  } finally {
    setActiveProfile(original.id);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("runtime: kelly config has profileId", async () => {
  const original = getActiveProfile();
  const tempRoot = createTempRoot();
  try {
    setActiveProfile("kelly");
    const runtime = await HenryRuntime.create(tempRoot);

    assert.strictEqual(
      runtime.config.profileId,
      "kelly",
      "Kelly runtime should have profileId set to kelly",
    );

    runtime.close();
  } finally {
    setActiveProfile(original.id);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("runtime: henry config has profileId", async () => {
  const original = getActiveProfile();
  const tempRoot = createTempRoot();
  try {
    setActiveProfile("henry");
    const runtime = await HenryRuntime.create(tempRoot);

    assert.strictEqual(
      runtime.config.profileId,
      "henry",
      "Henry runtime should have profileId set to henry",
    );

    runtime.close();
  } finally {
    setActiveProfile(original.id);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("kelly profile: the Telegram pump and dashboard command survive the excluded standup poller", async () => {
  setActiveProfile("kelly");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kelly-pump-"));
  const runtime = await HenryRuntime.create(root);
  try {
    // Reaching the pump used to throw "standupPoller service is not available in this
    // profile", which crashed `kelly dashboard` before it listened on anything.
    const state = runtime.startTelegramPump();
    assert.equal(state.armed, false, "unconfigured Telegram arms nothing");
    assert.equal(state.standup, false);
  } finally {
    runtime.close();
    setActiveProfile("henry");
  }
});
