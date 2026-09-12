import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig, type HenryConfig } from "../src/config.ts";
import { ActivityLog } from "../src/activity.ts";
import { updateSettings } from "../src/util/settings.ts";
import {
  TweetService, TweetStore, TWEET_MAX_CHARS, TOPIC_REUSE_WINDOW_DAYS,
  percentEncode, oauthSignatureBaseString, oauthSignature, oauthAuthorizationHeader,
  validateTweet, sanitizeDraft, isTechTitle, findBannedTerm, topicKeywords, topicKeys,
  tweetsEnabled, readXCredentials, fetchHackerNewsTopics, XApiPoster, X_TWEETS_ENDPOINT,
  stagedTweetDir, localDateKey,
  type TweetTopic, type TweetPoster, type XCredentials,
} from "../src/social/tweets.ts";
import type { ProviderRunner } from "../src/providers/runner.ts";
import type { HenryMemory } from "../src/memory/engram.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TOPIC: TweetTopic = {
  id: "hn:41000001",
  title: "Rust 1.90 ships a compiler that is 30% faster",
  url: "https://blog.rust-lang.org/1.90",
  score: 420,
};

/** Valid on every rail: under 280, one keyword from the headline, no mentions, no hashtags. */
const GOOD_DRAFT = "The Rust compiler got 30% faster, which means I now have 30% less time to make tea while it builds. Progress has a cost.";

function tempConfig(): HenryConfig {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "henry-tweets-"));
  const config = loadConfig(root);
  fs.writeFileSync(path.join(root, "personality.md"), "# Voice\n\nDry, builder-minded, allergic to hype.\n");
  return config;
}

async function activityFor(config: HenryConfig): Promise<ActivityLog> {
  const activity = new ActivityLog(config.activityPath);
  await activity.init();
  return activity;
}

function enable(config: HenryConfig, enabled: boolean): void {
  updateSettings(config.settingsPath, { social: { tweets: { enabled } } });
}

function fakeRunner(responses: string | string[], prompts: string[] = []): ProviderRunner & { calls: () => number } {
  const queue = Array.isArray(responses) ? [...responses] : [responses];
  let calls = 0;
  return {
    calls: () => calls,
    run: async (prompt: string) => {
      calls += 1;
      prompts.push(prompt);
      const response = queue.length > 1 ? queue.shift()! : queue[0];
      return { runId: "run-test", provider: "codex" as const, exitCode: 0, durationMs: 1, response, events: [] };
    },
  } as unknown as ProviderRunner & { calls: () => number };
}

class FakePoster implements TweetPoster {
  readonly sent: string[] = [];
  constructor(private readonly behavior: (text: string) => { id: string } = () => ({ id: "1799" })) {}
  async post(text: string): Promise<{ id: string }> {
    this.sent.push(text);
    return this.behavior(text);
  }
}

function fakeMemory(sink: string[] = []): HenryMemory {
  return { remember: async (text: string) => { sink.push(text); return "mem-id"; } } as unknown as HenryMemory;
}

// ---------------------------------------------------------------------------
// OAuth 1.0a signing — known vectors (RFC 5849 + X's published example)
// ---------------------------------------------------------------------------

test("percentEncode follows RFC 5849 §3.6 (encodes !*'() that encodeURIComponent leaves alone)", () => {
  assert.equal(percentEncode("!*'()"), "%21%2A%27%28%29");
  assert.equal(percentEncode("Ladies + Gentlemen"), "Ladies%20%2B%20Gentlemen");
  assert.equal(percentEncode("aA0-._~"), "aA0-._~", "unreserved characters must survive untouched");
});

test("signature base string matches the RFC 5849 §3.4.1.1 worked example byte-for-byte", () => {
  // The spec's example exercises repeated parameter names (a3 twice, sorted by value),
  // pre-encoded values (b5), and an @ in a name — the three things naive signers break on.
  const base = oauthSignatureBaseString("POST", "http://example.com/request", [
    ["b5", "=%3D"], ["a3", "a"], ["c@", ""], ["a2", "r b"], ["c2", ""], ["a3", "2 q"],
    ["oauth_consumer_key", "9djdj82h48djs9d2"], ["oauth_token", "kkk9d7dh3k39sjv7"],
    ["oauth_signature_method", "HMAC-SHA1"], ["oauth_timestamp", "137131201"], ["oauth_nonce", "7d8f3e4a"],
  ]);
  assert.equal(
    base,
    "POST&http%3A%2F%2Fexample.com%2Frequest&a2%3Dr%2520b%26a3%3D2%2520q%26a3%3Da%26b5%3D%253D%25253D%26c%2540%3D%26c2%3D"
    + "%26oauth_consumer_key%3D9djdj82h48djs9d2%26oauth_nonce%3D7d8f3e4a%26oauth_signature_method%3DHMAC-SHA1"
    + "%26oauth_timestamp%3D137131201%26oauth_token%3Dkkk9d7dh3k39sjv7",
  );
});

test("HMAC-SHA1 signature matches X's published OAuth example exactly", () => {
  const params: Array<[string, string]> = [
    ["status", "Hello Ladies + Gentlemen, a signed OAuth request!"],
    ["include_entities", "true"],
    ["oauth_consumer_key", "xvz1evFS4wEEPTGEFPHBog"],
    ["oauth_nonce", "kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg"],
    ["oauth_signature_method", "HMAC-SHA1"],
    ["oauth_timestamp", "1318622958"],
    ["oauth_token", "370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb"],
    ["oauth_version", "1.0"],
  ];
  const base = oauthSignatureBaseString("post", "https://api.twitter.com/1.1/statuses/update.json", params);
  assert.equal(
    base,
    "POST&https%3A%2F%2Fapi.twitter.com%2F1.1%2Fstatuses%2Fupdate.json&include_entities%3Dtrue"
    + "%26oauth_consumer_key%3Dxvz1evFS4wEEPTGEFPHBog%26oauth_nonce%3DkYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg"
    + "%26oauth_signature_method%3DHMAC-SHA1%26oauth_timestamp%3D1318622958"
    + "%26oauth_token%3D370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb%26oauth_version%3D1.0"
    + "%26status%3DHello%2520Ladies%2520%252B%2520Gentlemen%252C%2520a%2520signed%2520OAuth%2520request%2521",
  );
  const signature = oauthSignature(base, "kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw", "LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE");
  assert.equal(signature, "hCtSmYh+iHYCEqBWrE7C7hYmtUk=");
});

test("Authorization header is a sorted, percent-encoded OAuth header with a deterministic signature", () => {
  const credentials: XCredentials = { apiKey: "ck", apiSecret: "cs", accessToken: "at", accessSecret: "as" };
  const header = oauthAuthorizationHeader({
    method: "POST", url: X_TWEETS_ENDPOINT, credentials, nonce: "abc123", timestamp: "1700000000",
  });
  assert.match(header, /^OAuth oauth_consumer_key="ck", oauth_nonce="abc123", oauth_signature="/);
  assert.match(header, /oauth_signature_method="HMAC-SHA1"/);
  assert.match(header, /oauth_token="at", oauth_version="1\.0"$/);
  // Signature is reproducible from the exported primitives — no hidden state, no clock.
  const expected = oauthSignature(
    oauthSignatureBaseString("POST", X_TWEETS_ENDPOINT, [
      ["oauth_consumer_key", "ck"], ["oauth_nonce", "abc123"], ["oauth_signature_method", "HMAC-SHA1"],
      ["oauth_timestamp", "1700000000"], ["oauth_token", "at"], ["oauth_version", "1.0"],
    ]),
    "cs", "as",
  );
  assert.ok(header.includes(`oauth_signature="${percentEncode(expected)}"`));
});

test("XApiPoster posts a JSON body to /2/tweets and nothing else", async () => {
  const seen: Array<{ url: string; init: RequestInit }> = [];
  const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify({ data: { id: "1234567890", text: "hi" } }), { status: 201 });
  }) as unknown as typeof fetch;
  const poster = new XApiPoster({ apiKey: "ck", apiSecret: "cs", accessToken: "at", accessSecret: "as" }, fakeFetch);

  assert.deepEqual(await poster.post("hello world"), { id: "1234567890" });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, "https://api.x.com/2/tweets");
  assert.equal(seen[0].init.method, "POST");
  assert.equal(seen[0].init.body, JSON.stringify({ text: "hello world" }));
});

test("XApiPoster surfaces API failures without leaking credentials", async () => {
  const fakeFetch = (async () => new Response('{"title":"Unauthorized"}', { status: 401 })) as unknown as typeof fetch;
  const poster = new XApiPoster({ apiKey: "ck", apiSecret: "SECRET-CS", accessToken: "at", accessSecret: "SECRET-AS" }, fakeFetch);
  await assert.rejects(poster.post("hello"), (error: Error) => {
    assert.match(error.message, /X API 401/);
    assert.ok(!error.message.includes("SECRET-CS") && !error.message.includes("SECRET-AS"), "error text must never carry a key");
    return true;
  });
});

// ---------------------------------------------------------------------------
// Policy validators
// ---------------------------------------------------------------------------

test("validateTweet accepts a clean, on-topic, humorous draft", () => {
  assert.deepEqual(validateTweet(GOOD_DRAFT, TOPIC), { ok: true });
});

test("validateTweet rejects anything over 280 characters (counted in code points)", () => {
  const long = `Rust ${"a".repeat(TWEET_MAX_CHARS)}`;
  assert.equal(validateTweet(long, TOPIC).ok, false);
  assert.match(validateTweet(long, TOPIC).reason!, /over the 280 limit/);
  // An emoji is ONE visible character, not two UTF-16 units.
  assert.equal(validateTweet(`Rust compiler news 🎉${"a".repeat(260)}`, TOPIC).ok, true);
});

test("validateTweet rejects @mentions outright — posting is authorized, engaging with people is not", () => {
  const verdict = validateTweet("The Rust compiler is faster now, ask @someone about it", TOPIC);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason!, /@mention/);
  // An email-ish or mid-word @ is not a mention.
  assert.equal(validateTweet("Rust compiler speedups land in stable", TOPIC).ok, true);
});

test("validateTweet allows one hashtag and rejects hashtag spam", () => {
  assert.equal(validateTweet(`${GOOD_DRAFT} #rustlang`, TOPIC).ok, true);
  const spam = validateTweet("Rust compiler go brrr #rust #dev #buildinpublic", TOPIC);
  assert.equal(spam.ok, false);
  assert.match(spam.reason!, /hashtags/);
});

test("validateTweet rejects politics, named individuals, and punching down", () => {
  for (const bad of [
    "Rust compiler faster than the election results",
    "Rust compiler ships while Trump tweets",
    "Rust compiler faster; every JS dev is an idiot",
  ]) {
    const verdict = validateTweet(bad, TOPIC);
    assert.equal(verdict.ok, false, `should reject: ${bad}`);
    assert.match(verdict.reason!, /off-policy term/);
  }
});

test("validateTweet requires the tweet to actually reference the development", () => {
  const verdict = validateTweet("Tuesday feels like a good day to ship something, honestly.", TOPIC);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason!, /does not reference/);
  assert.equal(validateTweet("Tuesday feels like a good day to ship something.").ok, true, "no topic supplied = no grounding check");
});

test("sanitizeDraft strips fences, labels, and wrapping quotes a model adds", () => {
  assert.equal(sanitizeDraft('```\n"Tweet: hello"\n```'), "hello");
  assert.equal(sanitizeDraft('Tweet: "hello there"'), "hello there");
  assert.equal(sanitizeDraft("  plain text  "), "plain text");
});

test("topic filters keep tech stories and drop charged ones", () => {
  assert.equal(isTechTitle("Show HN: I built a database in Zig"), true);
  assert.equal(isTechTitle("A new paper on protein folding", "https://arxiv.org/abs/1"), true);
  assert.equal(isTechTitle("My sourdough starter turns three today"), false);
  assert.equal(findBannedTerm("Senate hearing on the new chip export rules"), "senate");
  assert.equal(findBannedTerm("Selection sort is still slow"), undefined, "substring matches must not fire");
});

test("topicKeywords and topicKeys give a stable headline identity for dedupe", () => {
  assert.ok(topicKeywords(TOPIC.title).includes("compiler"));
  assert.ok(!topicKeywords(TOPIC.title).includes("that"), "stopwords are not identity");
  const keys = topicKeys(TOPIC);
  assert.equal(keys[0], "hn:41000001");
  assert.match(keys[1], /^title:/);
  // The same story reposted under a new HN id still collides on the headline key.
  assert.equal(topicKeys({ ...TOPIC, id: "hn:9999" })[1], keys[1]);
});

test("readXCredentials is all-four-or-nothing", () => {
  assert.equal(readXCredentials({ X_API_KEY: "a", X_API_SECRET: "b", X_ACCESS_TOKEN: "c" } as NodeJS.ProcessEnv), undefined);
  assert.equal(readXCredentials({ X_API_KEY: "a", X_API_SECRET: "b", X_ACCESS_TOKEN: "c", X_ACCESS_SECRET: "  " } as NodeJS.ProcessEnv), undefined);
  assert.deepEqual(readXCredentials({ X_API_KEY: "a", X_API_SECRET: "b", X_ACCESS_TOKEN: "c", X_ACCESS_SECRET: "d" } as NodeJS.ProcessEnv), {
    apiKey: "a", apiSecret: "b", accessToken: "c", accessSecret: "d",
  });
});

test("tweetsEnabled demands a literal true — anything else is OFF", () => {
  const config = tempConfig();
  assert.equal(tweetsEnabled(config.settingsPath), false, "absent settings file = OFF");
  updateSettings(config.settingsPath, { social: { tweets: { enabled: "true" } } });
  assert.equal(tweetsEnabled(config.settingsPath), false, "a truthy string is not consent");
  enable(config, true);
  assert.equal(tweetsEnabled(config.settingsPath), true);
  enable(config, false);
  assert.equal(tweetsEnabled(config.settingsPath), false);
});

// ---------------------------------------------------------------------------
// Store: the once-per-day rail and the 30-day topic window
// ---------------------------------------------------------------------------

test("the posted ledger records one tweet per day and refuses a second row", () => {
  const config = tempConfig();
  const store = new TweetStore(config);
  try {
    assert.equal(store.postedOn("2026-08-15"), undefined);
    store.recordPost("2026-08-15", "111", GOOD_DRAFT, new Date("2026-08-15T14:00:00Z"));
    assert.equal(store.postedOn("2026-08-15")?.tweetId, "111");
    assert.throws(() => store.recordPost("2026-08-15", "222", "second", new Date()), /UNIQUE|constraint/i);
    assert.equal(store.postedOn("2026-08-16"), undefined, "a new day is a new allowance");
  } finally { store.close(); }
});

test("the day claim is atomic and stale claims are taken over", () => {
  const config = tempConfig();
  const store = new TweetStore(config);
  try {
    const now = new Date("2026-08-15T14:00:00Z");
    assert.equal(store.claimDay("2026-08-15", now), true);
    assert.equal(store.claimDay("2026-08-15", new Date(now.getTime() + 60_000)), false, "a live claim blocks a second pass");
    assert.equal(store.claimDay("2026-08-15", new Date(now.getTime() + 20 * 60_000)), true, "a dead pass must not lock the day");
    store.releaseDay("2026-08-15");
    assert.equal(store.claimDay("2026-08-15", now), true);
  } finally { store.close(); }
});

test("topics are blocked for 30 days and free again after", () => {
  const config = tempConfig();
  const store = new TweetStore(config);
  try {
    const used = new Date("2026-07-01T10:00:00Z");
    store.markTopicUsed(TOPIC, used);
    assert.equal(store.usedRecently(TOPIC, new Date("2026-07-20T10:00:00Z")), true);
    assert.equal(store.usedRecently({ ...TOPIC, id: "hn:5" }, new Date("2026-07-20T10:00:00Z")), true, "same headline, new id, still blocked");
    const afterWindow = new Date(used.getTime() + (TOPIC_REUSE_WINDOW_DAYS + 1) * 24 * 60 * 60 * 1000);
    assert.equal(store.usedRecently(TOPIC, afterWindow), false);
    assert.equal(store.usedRecently({ ...TOPIC, id: "hn:2", title: "Postgres 19 adds async replication" }, new Date("2026-07-20T10:00:00Z")), false);
  } finally { store.close(); }
});

// ---------------------------------------------------------------------------
// Service: the soul rails end to end
// ---------------------------------------------------------------------------

test("kill switch OFF: the cron job is a pure no-op — no provider call, no poster", async () => {
  const config = tempConfig();
  enable(config, false);
  const runner = fakeRunner(GOOD_DRAFT);
  const poster = new FakePoster();
  const service = new TweetService(config, await activityFor(config), runner, undefined, undefined, async () => [TOPIC], () => poster);

  const result = await service.run({ trigger: "cron", now: new Date("2026-08-15T23:00:00") });

  assert.equal(result.posted, false);
  assert.equal(result.skipped, true);
  assert.match(result.reason!, /social\.tweets\.enabled is off/);
  assert.equal(runner.calls(), 0, "a disabled feature must not spend Luvish's provider quota");
  assert.equal(poster.sent.length, 0, "the poster must never be reached while the switch is off");
});

test("kill switch OFF: a hand-run `henry tweet` stages the draft and never posts", async () => {
  const config = tempConfig();
  enable(config, false);
  const notes: string[] = [];
  const poster = new FakePoster();
  const service = new TweetService(
    config, await activityFor(config), fakeRunner(GOOD_DRAFT),
    async (message) => { notes.push(message); }, undefined, async () => [TOPIC], () => poster,
  );

  const result = await service.run({ trigger: "cli", now: new Date("2026-08-15T14:00:00") });

  assert.equal(result.posted, false);
  assert.equal(poster.sent.length, 0);
  assert.match(result.reason!, /social\.tweets\.enabled is off/);
  assert.equal(result.stagedPath, path.join(stagedTweetDir(config), "2026-08-15.md"));
  const staged = await fsp.readFile(result.stagedPath!, "utf8");
  assert.match(staged, /Not posted because: social\.tweets\.enabled is off/);
  assert.match(staged, /Rust compiler got 30% faster/);
  assert.equal(notes.length, 1, "Luvish is told on Telegram why it did not go out");
  assert.match(notes[0], /staged, NOT posted/);
});

test("enabled + keys: posts once, logs it, mirrors it to Luvish, and the day is then spent", async () => {
  const config = tempConfig();
  enable(config, true);
  const activity = await activityFor(config);
  const notes: string[] = [];
  const remembered: string[] = [];
  const poster = new FakePoster(() => ({ id: "1799001" }));
  const runner = fakeRunner(GOOD_DRAFT);
  // Two candidates so tomorrow's run has something the 30-day window has not eaten.
  const tomorrowsTopic: TweetTopic = { id: "hn:41000002", title: "Rust compiler adds parallel frontend", url: "https://example.com/2", score: 300 };
  const service = new TweetService(
    config, activity, runner, async (message) => { notes.push(message); },
    fakeMemory(remembered), async () => [TOPIC, tomorrowsTopic], () => poster,
  );
  const now = new Date("2026-08-15T14:30:00");

  const first = await service.run({ trigger: "cli", now });
  assert.equal(first.posted, true);
  assert.equal(first.tweetId, "1799001");
  assert.deepEqual(poster.sent, [GOOD_DRAFT]);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /Posted the daily tech tweet/);
  assert.equal(remembered.length, 1);
  const events = await activity.list(20);
  assert.ok(events.some((event) => event.kind === "social.posted"), "every post is logged");

  // ONCE-PER-DAY RAIL: the second run of the same day does not draft and does not post.
  const second = await service.run({ trigger: "cli", now: new Date("2026-08-15T16:00:00") });
  assert.equal(second.posted, false);
  assert.equal(second.skipped, true);
  assert.match(second.reason!, /already tweeted today/);
  assert.equal(poster.sent.length, 1);
  assert.equal(runner.calls(), 1, "the second run must not spend another provider call");

  // A new local day is a new allowance.
  const nextDay = await service.run({ trigger: "cli", now: new Date("2026-08-16T14:30:00") });
  assert.equal(nextDay.posted, true);
  assert.equal(poster.sent.length, 2);
});

test("missing X keys: drafts, stages with the reason, and never claims to have posted", async () => {
  const config = tempConfig();
  enable(config, true);
  const notes: string[] = [];
  const service = new TweetService(
    config, await activityFor(config), fakeRunner(GOOD_DRAFT),
    async (message) => { notes.push(message); }, undefined, async () => [TOPIC],
    () => undefined, // no credentials in .env
  );

  const result = await service.run({ trigger: "cron", now: new Date("2026-08-15T23:00:00") });

  assert.equal(result.posted, false);
  assert.match(result.reason!, /X API keys missing/);
  assert.ok(result.stagedPath);
  assert.match(notes[0], /X API keys missing/);
  const store = new TweetStore(config);
  try { assert.equal(store.postedOn("2026-08-15"), undefined, "staging must never write the posted ledger"); }
  finally { store.close(); }
});

test("`henry tweet draft` never posts, even with the switch on and keys present", async () => {
  const config = tempConfig();
  enable(config, true);
  const poster = new FakePoster();
  const service = new TweetService(config, await activityFor(config), fakeRunner(GOOD_DRAFT), undefined, undefined, async () => [TOPIC], () => poster);

  const result = await service.run({ trigger: "cli", stageOnly: true, now: new Date("2026-08-15T14:00:00") });

  assert.equal(result.posted, false);
  assert.equal(poster.sent.length, 0);
  assert.match(result.reason!, /draft-only run/);
  assert.ok(fs.existsSync(result.stagedPath!));
});

test("an over-length first draft is rejected, retried once, and the fixed draft posts", async () => {
  const config = tempConfig();
  enable(config, true);
  const prompts: string[] = [];
  const poster = new FakePoster();
  const runner = fakeRunner([`Rust compiler ${"a".repeat(300)}`, GOOD_DRAFT], prompts);
  const service = new TweetService(config, await activityFor(config), runner, undefined, undefined, async () => [TOPIC], () => poster);

  const result = await service.run({ trigger: "cli", now: new Date("2026-08-15T14:00:00") });

  assert.equal(result.posted, true);
  assert.equal(runner.calls(), 2, "exactly one retry");
  assert.deepEqual(poster.sent, [GOOD_DRAFT]);
  assert.match(prompts[1], /previous draft was REJECTED/);
  assert.match(prompts[1], /over the 280 limit/);
});

test("two off-policy drafts in a row stage instead of posting — the retry is not a bypass", async () => {
  const config = tempConfig();
  enable(config, true);
  const poster = new FakePoster();
  const runner = fakeRunner("Rust compiler news, and every Java dev is an idiot about it");
  const service = new TweetService(config, await activityFor(config), runner, undefined, undefined, async () => [TOPIC], () => poster);

  const result = await service.run({ trigger: "cli", now: new Date("2026-08-15T14:00:00") });

  assert.equal(result.posted, false);
  assert.equal(poster.sent.length, 0, "an off-policy draft never reaches X");
  assert.equal(runner.calls(), 2);
  assert.match(result.reason!, /draft failed policy check: off-policy term "idiot"/);
  assert.ok(result.stagedPath, "Luvish still sees what it wanted to say");
});

test("topic selection skips charged and non-tech stories and anything used in the window", async () => {
  const config = tempConfig();
  enable(config, true);
  const poster = new FakePoster();
  const candidates: TweetTopic[] = [
    { id: "hn:1", title: "Senate grills chip makers over export rules", url: "https://example.com/1", score: 900 },
    { id: "hn:2", title: "My sourdough starter turns three today", url: "https://example.com/2", score: 800 },
    TOPIC,
  ];
  const service = new TweetService(config, await activityFor(config), fakeRunner(GOOD_DRAFT), undefined, undefined, async () => candidates, () => poster);

  const result = await service.run({ trigger: "cli", now: new Date("2026-08-15T14:00:00") });
  assert.equal(result.topic?.id, TOPIC.id, "the first tech, policy-clean, unused story wins");
  assert.equal(result.posted, true);

  // The same story tomorrow is inside the 30-day window — nothing left to talk about.
  const repeat = await new TweetService(
    config, await activityFor(config), fakeRunner(GOOD_DRAFT), undefined, undefined, async () => candidates, () => poster,
  ).run({ trigger: "cli", now: new Date("2026-08-16T14:00:00") });
  assert.equal(repeat.posted, false);
  assert.match(repeat.reason!, /no fresh tech topic/);
  assert.equal(poster.sent.length, 1);
});

test("the daily slot is jittered: firings before the chosen minute skip, the first one after runs", async () => {
  const config = tempConfig();
  enable(config, true);
  const poster = new FakePoster();
  const service = new TweetService(config, await activityFor(config), fakeRunner(GOOD_DRAFT), undefined, undefined, async () => [TOPIC], () => poster);
  // rng() = 0.5 → hour 13 + floor(0.5*4) = 15, minute floor(0.5*60) = 30.
  const rng = () => 0.5;

  const early = await service.run({ trigger: "cron", now: new Date("2026-08-15T13:20:00"), rng });
  assert.equal(early.skipped, true);
  assert.match(early.reason!, /today's slot is 15:30/);
  assert.equal(poster.sent.length, 0);

  const onTime = await service.run({ trigger: "cron", now: new Date("2026-08-15T15:40:00"), rng: () => 0.99 });
  assert.equal(onTime.posted, true, "the slot persists for the day — a later rng must not move it");
  assert.deepEqual(poster.sent, [GOOD_DRAFT]);
});

test("a cron stage closes the day to further cron firings; a hand-run draft does not", async () => {
  const config = tempConfig();
  enable(config, true);
  const poster = new FakePoster();
  const runner = fakeRunner(GOOD_DRAFT);
  const noKeys = new TweetService(config, await activityFor(config), runner, undefined, undefined, async () => [TOPIC], () => undefined);
  const rng = () => 0;

  // Hand-run draft in the morning: staged, but the day stays open for the scheduled job.
  await noKeys.run({ trigger: "cli", stageOnly: true, now: new Date("2026-08-15T09:00:00") });
  const cronRun = await new TweetService(
    config, await activityFor(config), runner, undefined, undefined,
    async () => [{ ...TOPIC, id: "hn:2", title: "Rust compiler adds a parallel frontend" }], () => poster,
  ).run({ trigger: "cron", now: new Date("2026-08-15T14:00:00"), rng });
  assert.equal(cronRun.posted, true, "a CLI draft must not suppress the daily job");

  // A cron pass that could only stage does close the day — no second provider spend.
  const other = tempConfig();
  enable(other, true);
  const runner2 = fakeRunner(GOOD_DRAFT);
  const staging = new TweetService(other, await activityFor(other), runner2, undefined, undefined, async () => [TOPIC], () => undefined);
  await staging.run({ trigger: "cron", now: new Date("2026-08-15T14:00:00"), rng });
  const second = await staging.run({ trigger: "cron", now: new Date("2026-08-15T14:20:00"), rng });
  assert.match(second.reason!, /already staged/);
  assert.equal(runner2.calls(), 1);
});

test("flipping the switch OFF mid-draft still stops the post — OFF wins instantly", async () => {
  const config = tempConfig();
  enable(config, true);
  const poster = new FakePoster();
  // The "provider turn" is where Luvish reaches for the kill switch.
  const runner = {
    run: async () => {
      enable(config, false);
      return { runId: "run-test", provider: "codex" as const, exitCode: 0, durationMs: 1, response: GOOD_DRAFT, events: [] };
    },
  } as unknown as ProviderRunner;
  const service = new TweetService(config, await activityFor(config), runner, undefined, undefined, async () => [TOPIC], () => poster);

  const result = await service.run({ trigger: "cli", now: new Date("2026-08-15T14:00:00") });

  assert.equal(result.posted, false);
  assert.equal(poster.sent.length, 0);
  assert.match(result.reason!, /social\.tweets\.enabled is off/);
});

test("a failed post leaves the day retryable and tells Luvish what happened", async () => {
  const config = tempConfig();
  enable(config, true);
  const notes: string[] = [];
  const failing: TweetPoster = { post: async () => { throw new Error("X API 503: over capacity"); } };
  const service = new TweetService(
    config, await activityFor(config), fakeRunner(GOOD_DRAFT),
    async (message) => { notes.push(message); }, undefined, async () => [TOPIC], () => failing,
  );

  const result = await service.run({ trigger: "cli", now: new Date("2026-08-15T14:00:00") });

  assert.equal(result.posted, false);
  assert.match(result.reason!, /post failed: X API 503/);
  assert.match(notes[0], /post failed/);
  const store = new TweetStore(config);
  try { assert.equal(store.postedOn("2026-08-15"), undefined, "a failure must never look like a post"); }
  finally { store.close(); }
});

test("a claimed day blocks a concurrent pass, and the claim is released afterwards", async () => {
  const config = tempConfig();
  enable(config, true);
  const now = new Date("2026-08-15T14:00:00");
  const store = new TweetStore(config);
  const poster = new FakePoster();
  const runner = fakeRunner(GOOD_DRAFT);
  try {
    store.claimDay(localDateKey(now), now);
    const service = new TweetService(config, await activityFor(config), runner, undefined, undefined, async () => [TOPIC], () => poster);
    const blocked = await service.run({ trigger: "cli", now });
    assert.equal(blocked.skipped, true);
    assert.match(blocked.reason!, /already running/);
    assert.equal(runner.calls(), 0);

    store.releaseDay(localDateKey(now));
    assert.equal((await service.run({ trigger: "cli", now })).posted, true);
    assert.equal(store.claimDay(localDateKey(now), now), true, "a finished pass leaves no claim behind");
  } finally { store.close(); }
});

// ---------------------------------------------------------------------------
// Research: Hacker News (faked — no test ever touches the network)
// ---------------------------------------------------------------------------

test("fetchHackerNewsTopics keeps live stories and drops dead, deleted, and non-story items", async () => {
  const items: Record<string, unknown> = {
    "1": { id: 1, type: "story", title: "Zig 0.14 released", url: "https://ziglang.org", score: 300 },
    "2": { id: 2, type: "story", title: "Dead story", dead: true },
    "3": { id: 3, type: "job", title: "We are hiring" },
    "4": { id: 4, type: "story", title: "Ask HN: what editor?", score: 12 },
  };
  const fakeFetch = (async (url: string | URL | Request) => {
    const target = String(url);
    if (target.endsWith("topstories.json")) return new Response(JSON.stringify([1, 2, 3, 4]));
    const id = /item\/(\d+)\.json$/.exec(target)?.[1] ?? "";
    return new Response(JSON.stringify(items[id] ?? null));
  }) as unknown as typeof fetch;

  const topics = await fetchHackerNewsTopics({ fetchImpl: fakeFetch });

  assert.deepEqual(topics.map((topic) => topic.id), ["hn:1", "hn:4"]);
  assert.equal(topics[0].url, "https://ziglang.org");
  assert.equal(topics[1].url, "https://news.ycombinator.com/item?id=4", "a text post falls back to its HN permalink");
});

test("fetchHackerNewsTopics fails soft when HN is unreachable", async () => {
  const fakeFetch = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
  assert.deepEqual(await fetchHackerNewsTopics({ fetchImpl: fakeFetch }), []);
});
