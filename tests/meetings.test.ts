import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.ts";
import { ActivityLog } from "../src/activity.ts";
import { MeetingShadowService } from "../src/meetings/service.ts";
import type { HenryMemory } from "../src/memory/engram.ts";
import type { ProviderRunner } from "../src/providers/runner.ts";
import type { RunResult } from "../src/types.ts";

const VALID_NOTES_JSON = JSON.stringify({
  title: "Q3 Planning Sync",
  date: "2026-08-06",
  attendees: ["Luvish", "Priya"],
  decisions: ["Ship the meeting-shadow module by end of phase 6"],
  actionItems: [{ owner: "Luvish", task: "Review the whisper.cpp setup", due: "2026-08-08" }],
  openQuestions: ["Do we need speaker diarization for v1?"],
  personalizedForDad: {
    commitments: ["Luvish will send the roadmap doc to Priya by Friday"],
    affectsProjects: ["Henry meeting-shadow module"],
    suggestedFollowUps: ["Draft a follow-up email summarizing decisions"],
  },
});

function fakeMemory(remembered: Array<{ content: string; importance?: number }>): HenryMemory {
  return {
    context: async () => "Luvish's projects: Henry agent build-out.",
    remember: async (content: string, input?: { importance?: number }) => {
      remembered.push({ content, importance: input?.importance });
      return `mem-${remembered.length}`;
    },
  } as unknown as HenryMemory;
}

function fakeRunner(response = VALID_NOTES_JSON): ProviderRunner {
  return {
    run: async (): Promise<RunResult> => ({
      runId: "run-1", provider: "codex", response, exitCode: 0, durationMs: 1, events: [],
    }),
  } as unknown as ProviderRunner;
}

async function fakeTranscribe(_audioPath: string): Promise<string> {
  return "Luvish: Let's ship the meeting-shadow module by end of phase 6. Priya: sounds good, send me the roadmap by Friday.";
}

async function setup(): Promise<{ config: ReturnType<typeof loadConfig>; activity: ActivityLog }> {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "henry-meetings-"));
  const config = loadConfig(rootDir);
  const activity = new ActivityLog(config.activityPath);
  await activity.init();
  return { config, activity };
}

test("process() transcribes, summarizes, writes files, remembers commitments, and records activity", async () => {
  const { config, activity } = await setup();
  const remembered: Array<{ content: string; importance?: number }> = [];
  const service = new MeetingShadowService(config, activity, fakeMemory(remembered), fakeRunner(), { transcribe: fakeTranscribe });

  const result = await service.process("/fake/audio.wav", "Q3 Planning Sync");

  assert.equal(result.notes.title, "Q3 Planning Sync");
  assert.equal(result.notes.date, "2026-08-06");
  assert.deepEqual(result.notes.attendees, ["Luvish", "Priya"]);
  assert.equal(result.notes.personalizedForDad.commitments.length, 1);

  await fs.access(result.markdownPath);
  await fs.access(result.outputPath);
  const markdown = await fs.readFile(result.markdownPath, "utf8");
  assert.match(markdown, /Q3 Planning Sync/);
  assert.match(markdown, /## For Luvish/);
  assert.match(markdown, /Luvish will send the roadmap doc to Priya by Friday/);

  // Overview memory + one commitment memory.
  assert.equal(remembered.length, 2);
  const commitmentMemory = remembered.find((m) => m.importance === 7);
  assert.ok(commitmentMemory, "expected a commitment memory with importance 7");
  assert.match(commitmentMemory!.content, /roadmap doc to Priya/);
  assert.equal(result.memoryIds.length, 2);

  const events = await activity.list(10);
  const completed = events.find((event) => event.kind === "workflow.completed" && event.metadata?.meeting === true);
  assert.ok(completed, "expected a workflow.completed activity event with metadata.meeting=true");
  assert.equal(completed!.metadata?.title, "Q3 Planning Sync");
});

test("transcribe() throws a clear whisper-install message when no whisper binary is on PATH", async () => {
  const { config, activity } = await setup();
  const service = new MeetingShadowService(config, activity, fakeMemory([]), fakeRunner());

  const originalPath = process.env.PATH;
  process.env.PATH = "";
  try {
    await assert.rejects(
      () => service.transcribe("/fake/audio.wav"),
      /brew install whisper-cpp/,
    );
  } finally {
    process.env.PATH = originalPath;
  }
});

test("summarize() throws when the model does not return JSON", async () => {
  const { config, activity } = await setup();
  const service = new MeetingShadowService(config, activity, fakeMemory([]), fakeRunner("not json at all"), { transcribe: fakeTranscribe });
  await assert.rejects(
    () => service.summarize("some transcript", "Standup"),
    /did not return JSON/,
  );
});
