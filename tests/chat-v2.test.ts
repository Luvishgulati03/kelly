import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { HenryRuntime } from "../src/runtime.ts";
import { startDashboard } from "../src/dashboard/server.ts";
import { ConversationStore, LEGACY_CONVERSATION_ID, titleFromMessages } from "../src/dashboard/conversations.ts";
import { CHAT_COMMANDS, helpMessage, parseCommand, unescapeMessage, unknownCommandMessage } from "../src/dashboard/chat-commands.ts";
import { describeSkill, listSkills, loadSkill, parseFrontmatter, skillGuidanceBlock } from "../src/dashboard/skills.ts";
import {
  ATTACHMENT_MAX_AGE_MS, MAX_ATTACHMENT_BYTES, attachmentPath, attachmentsDir,
  purgeAttachments, sanitizeFileName, saveAttachment, validateAttachment,
} from "../src/dashboard/attachments.ts";

/** 1x1 PNG — the smallest thing that survives magic-byte sniffing. */
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function tempRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.cpSync(path.join(process.cwd(), "workflows"), path.join(root, "workflows"), { recursive: true });
  return root;
}

interface Harness {
  base: string;
  runtime: HenryRuntime;
  server: http.Server;
  root: string;
  prompts: string[];
  providers: Array<string | undefined>;
  surfaces: Array<string | undefined>;
  executed: string[];
  close(): Promise<void>;
}

/** A dashboard on a random port with agent.run stubbed, recording what a turn actually sent. */
async function harness(prefix: string): Promise<Harness> {
  const root = tempRoot(prefix);
  const runtime = await HenryRuntime.create(root);
  runtime.config.port = 0;
  runtime.config.host = "127.0.0.1";
  const prompts: string[] = [];
  const providers: Array<string | undefined> = [];
  const surfaces: Array<string | undefined> = [];
  const executed: string[] = [];
  (runtime.agent as unknown as { run: unknown }).run = async (prompt: string, options?: { provider?: string; surface?: string; onEvent?: (event: { timestamp: string; stream: string; text: string; parsed?: Record<string, unknown> }) => void }) => {
    prompts.push(prompt);
    providers.push(options?.provider);
    surfaces.push(options?.surface);
    options?.onEvent?.({ timestamp: "", stream: "stdout", text: "", parsed: { text: "ok" } });
    return { runId: "run-1", provider: options?.provider ?? "claude", response: "ok", exitCode: 0, durationMs: 5, events: [] };
  };
  // Any outbound execution would go through here; the chat must never reach it on its own.
  (runtime as unknown as { executeApproval: unknown }).executeApproval = async (id: string) => {
    executed.push(id);
    return "executed";
  };
  const server = startDashboard(runtime);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    base: `http://127.0.0.1:${address.port}`,
    runtime, server, root, prompts, providers, surfaces, executed,
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      runtime.close();
    },
  };
}

// ---------------------------------------------------------------------------
// conversations: CRUD + migration
// ---------------------------------------------------------------------------

test("conversation store migrates the existing single transcript instead of orphaning it", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "henry-conv-migrate-"));
  const chats = path.join(dataDir, "chats");
  fs.mkdirSync(chats, { recursive: true });
  const legacy = [
    { role: "user", text: "what is pending my approval?", at: "2026-08-01T10:00:00.000Z" },
    { role: "henry", text: "One tweet is staged.", at: "2026-08-01T10:00:03.000Z" },
  ];
  fs.writeFileSync(path.join(chats, "web-chat.json"), JSON.stringify({ messages: legacy }));

  const store = new ConversationStore(dataDir);
  const listed = await store.list();
  assert.equal(listed.length, 1, "the legacy transcript becomes exactly one conversation");
  assert.equal(listed[0].id, LEGACY_CONVERSATION_ID);
  assert.equal(listed[0].surface, LEGACY_CONVERSATION_ID, "its provider surface is unchanged");
  assert.equal(listed[0].title, "what is pending my approval?");
  const messages = await store.messages(LEGACY_CONVERSATION_ID);
  assert.equal(messages.length, 2, "no message is lost in migration");
  assert.equal(messages[1].text, "One tweet is staged.");
  // The original file is adopted in place, never moved or rewritten under a new name.
  assert.ok(fs.existsSync(path.join(chats, "web-chat.json")));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(chats, "web-chat.json"), "utf8")).messages, legacy);
});

test("conversation store: create, append, rename, clear, delete", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "henry-conv-crud-"));
  const store = new ConversationStore(dataDir);
  assert.deepEqual(await store.list(), []);

  const first = await store.create();
  assert.equal(first.title, "New chat");
  assert.equal(first.surface, `web-chat:${first.id}`, "each conversation gets its own provider surface");
  await store.append(first.id, [{ role: "user", text: "draft my standup note", at: new Date().toISOString() }]);
  assert.equal((await store.get(first.id))?.title, "draft my standup note", "an untitled thread names itself");

  const second = await store.create("Job hunt");
  assert.equal((await store.list())[0].id, second.id, "newest-updated first");

  await store.rename(first.id, "   Standup   ");
  assert.equal((await store.get(first.id))?.title, "Standup");

  await store.append(first.id, [{ role: "henry", text: "here it is", at: new Date().toISOString() }]);
  assert.equal((await store.messages(first.id)).length, 2);
  await store.clear(first.id);
  assert.deepEqual(await store.messages(first.id), [], "clear empties the transcript");
  assert.ok(await store.get(first.id), "clear keeps the conversation itself");

  assert.equal(await store.remove(second.id), true);
  assert.equal(await store.remove(second.id), false, "deleting twice is not an error, just false");
  assert.deepEqual((await store.list()).map((item) => item.id), [first.id]);
  assert.equal(fs.existsSync(path.join(dataDir, "chats", `${second.id}.json`)), false, "the transcript file goes with it");
});

test("a reply that lands after its conversation was cleared or deleted is dropped", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "henry-conv-generation-"));
  const store = new ConversationStore(dataDir);
  const conversation = await store.create();
  const generation = store.generation(conversation.id);
  await store.clear(conversation.id);
  await store.append(conversation.id, [{ role: "henry", text: "stale", at: new Date().toISOString() }], { ifGeneration: generation });
  assert.deepEqual(await store.messages(conversation.id), [], "a stale reply never resurrects into a cleared thread");

  const other = await store.create();
  const otherGeneration = store.generation(other.id);
  await store.remove(other.id);
  await store.append(other.id, [{ role: "henry", text: "stale", at: new Date().toISOString() }], { ifGeneration: otherGeneration });
  assert.equal((await store.list()).find((item) => item.id === other.id), undefined, "a deleted thread is not recreated by an in-flight send");
});

test("titles derive from the first user message and stay bounded", () => {
  assert.equal(titleFromMessages([]), "New chat");
  const long = "x".repeat(200);
  const title = titleFromMessages([{ role: "user", text: long, at: "" }]);
  assert.ok(title.length <= 80 && title.endsWith("…"));
});

test("conversation HTTP API lists, creates, renames, switches and deletes", async () => {
  const server = await harness("henry-conv-api-");
  try {
    const created = await (await fetch(`${server.base}/api/conversations`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    })).json() as { conversation: { id: string; title: string } };
    assert.ok(created.conversation.id);

    const second = await (await fetch(`${server.base}/api/conversations`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Second" }),
    })).json() as { conversation: { id: string } };

    const listed = await (await fetch(`${server.base}/api/conversations`)).json() as { conversations: Array<{ id: string }> };
    assert.equal(listed.conversations.length, 2);

    // Each conversation keeps its own transcript.
    await fetch(`${server.base}/api/chat/send`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "first thread", conversationId: created.conversation.id }),
    }).then((response) => response.text());
    const firstHistory = await (await fetch(`${server.base}/api/chat/history?conversationId=${created.conversation.id}`)).json() as { messages: unknown[] };
    const secondHistory = await (await fetch(`${server.base}/api/chat/history?conversationId=${second.conversation.id}`)).json() as { messages: unknown[] };
    assert.equal(firstHistory.messages.length, 2);
    assert.equal(secondHistory.messages.length, 0, "threads do not bleed into one another");
    assert.equal(server.surfaces[0], `web-chat:${created.conversation.id}`, "the provider session is per conversation");

    const renamed = await (await fetch(`${server.base}/api/conversations/${created.conversation.id}`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Renamed" }),
    })).json() as { conversation: { title: string } };
    assert.equal(renamed.conversation.title, "Renamed");

    const deleted = await fetch(`${server.base}/api/conversations/${second.conversation.id}`, { method: "DELETE" });
    assert.equal(deleted.status, 200);
    assert.equal(await fetch(`${server.base}/api/conversations/${second.conversation.id}`, { method: "DELETE" }).then((r) => r.status), 404);

    const missing = await fetch(`${server.base}/api/chat/history?conversationId=conv_nope`);
    assert.equal(missing.status, 404);
  } finally { await server.close(); }
});

// ---------------------------------------------------------------------------
// slash commands
// ---------------------------------------------------------------------------

test("slash-command parsing: known, unknown, arguments, and non-commands", () => {
  assert.deepEqual(parseCommand("/new"), { kind: "command", name: "new", arg: "" });
  assert.deepEqual(parseCommand("  /rename  Job hunt "), { kind: "command", name: "rename", arg: "Job hunt" });
  assert.deepEqual(parseCommand("/SKILL job-application"), { kind: "command", name: "skill", arg: "job-application" });
  assert.deepEqual(parseCommand("/frobnicate now"), { kind: "unknown", name: "frobnicate" });
  assert.deepEqual(parseCommand("what about /new?"), { kind: "none" }, "a slash mid-message is not a command");
  assert.deepEqual(parseCommand("//new"), { kind: "none" }, "// escapes a literal leading slash");
  assert.deepEqual(parseCommand("/"), { kind: "none" }, "a bare slash is the menu opening, not a command");
  assert.equal(unescapeMessage("//new"), "/new");
  assert.match(unknownCommandMessage("frobnicate"), /Unknown command: \/frobnicate/);
  for (const name of ["new", "clear", "rename", "skill", "provider", "help"]) {
    assert.ok(CHAT_COMMANDS.some((command) => command.name === name), `${name} is in the command set`);
    assert.match(helpMessage(), new RegExp(`/${name}`));
  }
});

test("an unknown slash command reaching the server is answered, never silently sent to the model", async () => {
  const server = await harness("henry-cmd-api-");
  try {
    const commands = await (await fetch(`${server.base}/api/chat/commands`)).json() as { commands: Array<{ name: string }> };
    assert.ok(commands.commands.length >= 6, "the page builds its menu from this list");

    const unknown = await fetch(`${server.base}/api/chat/send`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: "/frobnicate" }),
    });
    assert.equal(unknown.status, 400);
    assert.match(((await unknown.json()) as { error: string }).error, /Unknown command: \/frobnicate/);

    const known = await fetch(`${server.base}/api/chat/send`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: "/new" }),
    });
    assert.equal(known.status, 400, "a surface command is never forwarded to the model either");
    assert.equal(server.prompts.length, 0, "no command reached agent.run");

    // The escape hatch still sends.
    await fetch(`${server.base}/api/chat/send`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: "//not-a-command" }),
    }).then((response) => response.text());
    assert.equal(server.prompts.length, 1);
    assert.match(server.prompts[0], /^\/not-a-command$/m);
  } finally { await server.close(); }
});

// ---------------------------------------------------------------------------
// skills
// ---------------------------------------------------------------------------

test("skills are enumerated from both layouts with a parsed description", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "henry-skills-"));
  fs.mkdirSync(path.join(root, "skills", "job-application"), { recursive: true });
  fs.writeFileSync(path.join(root, "skills", "job-application", "SKILL.md"), "---\nname: job-application\ndescription: Frame paste-ready answers.\n---\n\n# Body\n\nDo the thing.\n");
  fs.writeFileSync(path.join(root, "skills", "pr-review.md"), "# Henry PR review skill\n\nRun six passes over the diff.\n");
  fs.writeFileSync(path.join(root, "skills", "notes.txt"), "not a skill");

  const skills = await listSkills(root);
  assert.deepEqual(skills.map((skill) => skill.name), ["job-application", "pr-review"], "both layouts, no stray files");
  assert.equal(skills[0].description, "Frame paste-ready answers.", "frontmatter description wins");
  assert.equal(skills[1].description, "Run six passes over the diff.", "otherwise the first real paragraph");
  assert.equal(skills[0].path, path.join("skills", "job-application", "SKILL.md"));

  const loaded = await loadSkill(root, "pr-review");
  assert.match(loaded?.content || "", /six passes/);
  assert.equal(await loadSkill(root, "../../etc/passwd"), undefined, "a traversal is not a skill name");
  assert.equal(await loadSkill(root, "nope"), undefined);

  const { fields, body } = parseFrontmatter("---\nname: x\ndescription: y\n---\nbody here\n");
  assert.deepEqual(fields, { name: "x", description: "y" });
  assert.equal(body.trim(), "body here");
  assert.equal(describeSkill("# Only a heading\n"), "");
});

test("the repo's own skills/ directory enumerates", async () => {
  const skills = await listSkills(process.cwd());
  const names = skills.map((skill) => skill.name);
  assert.ok(names.includes("job-application"), "the real skills/ directory is readable as-is");
  assert.ok(names.includes("pr-review"));
  for (const skill of skills) assert.ok(skill.path.startsWith("skills"), "a skill never resolves outside skills/");
});

test("/skill injects the skill's content into the turn as labelled guidance", async () => {
  const server = await harness("henry-skill-send-");
  try {
    fs.mkdirSync(path.join(server.root, "skills", "linkedin-application"), { recursive: true });
    fs.writeFileSync(
      path.join(server.root, "skills", "linkedin-application", "SKILL.md"),
      "---\ndescription: Expert screener playbook.\n---\n\nMINE THE JD FIRST, then answer in first person.\n",
    );

    const listed = await (await fetch(`${server.base}/api/skills`)).json() as { skills: Array<{ name: string; description: string }> };
    assert.deepEqual(listed.skills.map((skill) => skill.name), ["linkedin-application"], "read from disk at request time — no build step");

    await fetch(`${server.base}/api/chat/send`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "answer question 3", skill: "linkedin-application" }),
    }).then((response) => response.text());

    assert.match(server.prompts[0], /Active skill: linkedin-application/);
    assert.match(server.prompts[0], /MINE THE JD FIRST/);
    assert.match(server.prompts[0], /answer question 3$/, "the request still ends the prompt");
    assert.match(skillGuidanceBlock({ name: "x", description: "", path: "skills/x.md", content: "c" }), /explicit approval/);

    const history = await (await fetch(`${server.base}/api/chat/history`)).json() as { messages: Array<{ skill?: string }> };
    assert.equal(history.messages[0].skill, "linkedin-application", "the transcript records which skill was active");

    const unknown = await fetch(`${server.base}/api/chat/send`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "hi", skill: "not-a-skill" }),
    });
    assert.equal(unknown.status, 400);
  } finally { await server.close(); }
});

// ---------------------------------------------------------------------------
// attachments
// ---------------------------------------------------------------------------

test("attachment validation accepts real images only and enforces the size cap", () => {
  const valid = validateAttachment(PNG_BYTES, "image/png");
  assert.equal(valid.ok, true);
  assert.equal(valid.ok && valid.ext, "png");

  assert.equal(validateAttachment(Buffer.from("#!/bin/sh\nrm -rf /\n"), "image/png").ok, false, "a script renamed .png is refused");
  assert.equal(validateAttachment(Buffer.from("%PDF-1.7"), "application/pdf").ok, false, "non-images are refused");
  assert.equal(validateAttachment(Buffer.alloc(0)).ok, false);

  const oversized = Buffer.concat([PNG_BYTES, Buffer.alloc(MAX_ATTACHMENT_BYTES + 1)]);
  const rejected = validateAttachment(oversized, "image/png");
  assert.equal(rejected.ok, false);
  assert.match(rejected.ok === false ? rejected.error : "", /too large/);

  assert.equal(sanitizeFileName("../../etc/passwd"), "passwd", "a filename is never a path");
  assert.equal(sanitizeFileName(""), "image");
  assert.equal(attachmentPath("/data", "../../etc/passwd"), undefined, "an id that we did not mint resolves to nothing");
});

test("attachments older than 30 days are purged; newer ones are kept", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "henry-attach-purge-"));
  const saved = await saveAttachment(dataDir, PNG_BYTES, { name: "fresh.png", mime: "image/png" });
  const stale = await saveAttachment(dataDir, PNG_BYTES, { name: "stale.png", mime: "image/png" });
  assert.ok(!("error" in saved) && !("error" in stale));
  const staleId = ("error" in stale) ? "" : stale.id;
  const freshId = ("error" in saved) ? "" : saved.id;

  const old = new Date(Date.now() - ATTACHMENT_MAX_AGE_MS - 60_000);
  await fsp.utimes(path.join(attachmentsDir(dataDir), staleId), old, old);
  // A file this module did not create must survive the sweep untouched.
  fs.writeFileSync(path.join(attachmentsDir(dataDir), "not-ours.txt"), "keep me");
  fs.utimesSync(path.join(attachmentsDir(dataDir), "not-ours.txt"), old, old);

  const result = await purgeAttachments(dataDir);
  assert.equal(result.removed, 1);
  assert.equal(result.kept, 1);
  assert.equal(fs.existsSync(path.join(attachmentsDir(dataDir), staleId)), false, "over 30 days old: gone");
  assert.equal(fs.existsSync(path.join(attachmentsDir(dataDir), freshId)), true, "inside the window: kept");
  assert.equal(fs.existsSync(path.join(attachmentsDir(dataDir), "not-ours.txt")), true, "foreign files are never touched");

  assert.deepEqual(await purgeAttachments(path.join(dataDir, "missing")), { removed: 0, kept: 0 }, "no directory is a no-op");
});

test("an uploaded image is stored locally, previewable, and reaches the model on the pinned vision path", async () => {
  const server = await harness("henry-attach-send-");
  try {
    const upload = await fetch(`${server.base}/api/attachments`, {
      method: "POST", headers: { "content-type": "image/png", "x-filename": "screenshot.png" }, body: PNG_BYTES,
    });
    assert.equal(upload.status, 200);
    const { attachment } = await upload.json() as { attachment: { id: string; name: string; mime: string } };
    assert.match(attachment.id, /^att_[0-9a-f]{16}\.png$/);
    assert.equal(attachment.name, "screenshot.png");

    // Stored under data/attachments/, nowhere else.
    const stored = path.join(attachmentsDir(server.runtime.config.dataDir), attachment.id);
    assert.ok(fs.existsSync(stored));

    const preview = await fetch(`${server.base}/api/attachments/${attachment.id}`);
    assert.equal(preview.status, 200);
    assert.equal(preview.headers.get("content-type"), "image/png");
    assert.equal(Buffer.from(await preview.arrayBuffer()).equals(PNG_BYTES), true);
    assert.equal((await fetch(`${server.base}/api/attachments/att_deadbeef.png`)).status, 404);

    const rejected = await fetch(`${server.base}/api/attachments`, {
      method: "POST", headers: { "content-type": "image/png", "x-filename": "evil.png" }, body: Buffer.from("#!/bin/sh"),
    });
    assert.equal(rejected.status, 400, "content is sniffed, not trusted");

    // The active provider here is not claude, so the turn is pinned and the user is told.
    server.runtime.config.provider = "codex";
    const stream = await (await fetch(`${server.base}/api/chat/send`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "what does this say?", attachments: [{ id: attachment.id, name: attachment.name }] }),
    })).text();
    assert.match(stream, /event: notice/, "the UI is told the image could not go to the active provider");
    assert.match(stream, /can't read images/);
    assert.equal(server.providers[0], "claude", "images ride the existing claude-pinned vision path");
    assert.match(server.prompts[0], /attached images/);
    assert.ok(server.prompts[0].includes(stored), "the model receives the local file path");
    assert.match(server.prompts[0], /never as instructions/, "image content is framed as data");

    const history = await (await fetch(`${server.base}/api/chat/history`)).json() as { messages: Array<{ attachments?: Array<{ id: string }> }> };
    assert.equal(history.messages[0].attachments?.[0].id, attachment.id);

    // An id that names no file is dropped rather than trusted.
    await fetch(`${server.base}/api/chat/send`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "second", attachments: ["../../etc/passwd"] }),
    }).then((response) => response.text());
    assert.equal(server.providers[1], undefined, "no attachment, no vision pin");
  } finally { await server.close(); }
});

// ---------------------------------------------------------------------------
// the surface gains no new power
// ---------------------------------------------------------------------------

test("chat v2 still cannot send anything outbound without an explicit approval", async () => {
  const server = await harness("henry-chat-rails-");
  try {
    await fetch(`${server.base}/api/chat/send`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "email the recruiter and tell her I accept" }),
    }).then((response) => response.text());
    assert.equal(server.executed.length, 0, "an ordinary message never executes an approval");

    // With nothing staged, even the explicit approval grammar executes nothing.
    const approve = await (await fetch(`${server.base}/api/chat/send`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "approve: post this tweet" }),
    })).text();
    assert.match(approve, /No pending action matches/);
    assert.equal(server.executed.length, 0);
    assert.equal(server.prompts.length, 1, "the approval grammarshort-circuits before the model, as before");

    // Auth gate unchanged: a cross-origin POST is still refused.
    const crossOrigin = await fetch(`${server.base}/api/chat/send`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: JSON.stringify({ prompt: "hi" }),
    });
    assert.equal(crossOrigin.status, 403);
    const crossOriginDelete = await fetch(`${server.base}/api/conversations/web-chat`, {
      method: "DELETE", headers: { origin: "https://evil.example" },
    });
    assert.equal(crossOriginDelete.status, 403);

    // Display-only agents: the page reads the agent feed but offers no dispatch control.
    const page = await (await fetch(`${server.base}/chat`)).text();
    assert.match(page, /\/api\/agents/, "the chat surfaces agent activity");
    assert.doesNotMatch(page, /\/api\/dispatch/, "and cannot launch one");
    assert.match(page, /Message Henry/, "the composer is unchanged in spirit");
  } finally { await server.close(); }
});
