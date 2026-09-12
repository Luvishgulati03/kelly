import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, type HenryConfig } from "../src/config.ts";
import { ActivityLog } from "../src/activity.ts";
import {
  JobScoutService, ScoutStore, parseScoutVerdicts, canonicalLink, resolveScoutSources,
  DEFAULT_SCOUT_SOURCES, NAUKRI_LOGIN_NUDGE,
  type ScoutBrowser, type ScoutCollection, type ScoutListing, type ScoutSourceName,
} from "../src/jobs/scout.ts";
import {
  collectNaukri, detectNaukriLoggedOut, naukriSearchUrl, parseNaukriCards, type ScoutPage,
} from "../src/jobs/sources-naukri.ts";
import {
  duckDuckGoQuery, duckDuckGoUrl, parseDuckDuckGoResults, unwrapDuckDuckGoHref,
} from "../src/jobs/sources-web.ts";
import { syncAlertsFromMail, MAX_SCOUT_TITLES } from "../src/jobs/alerts.ts";
import type { ProviderRunner } from "../src/providers/runner.ts";
import type { HenryMemory } from "../src/memory/engram.ts";

function tempConfig(): HenryConfig {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "henry-scout-"));
  const config = loadConfig(root);
  // Test doubles only — pin every env-driven knob so no test reads Luvish's real files or titles.
  config.jobScoutTitles = ["AI Product Manager"];
  config.jobScoutLocation = "Bengaluru";
  config.resumeSourcePath = path.join(root, "resume.md");
  config.jobProfilePath = path.join(root, "application-profile.md");
  fs.writeFileSync(config.resumeSourcePath, "# Luvish resume\nBuilt Henry, a personal agent platform.");
  fs.writeFileSync(config.jobProfilePath, "Target: AI product roles in Bengaluru.");
  return config;
}

/**
 * The FRAMEWORK ships neutral: no owner's job titles and no owner's city baked into the
 * defaults. Titles come from HENRY_JOB_SCOUT_TITLES or `jobs alerts-sync`; an unconfigured
 * scout skips with a reason (below) instead of searching somebody else's targets.
 */
test("shipped defaults carry no owner-specific scout targets", () => {
  const keys = ["HENRY_JOB_SCOUT_TITLES", "LAVU_JOB_SCOUT_TITLES", "HENRY_JOB_SCOUT_LOCATION", "LAVU_JOB_SCOUT_LOCATION"];
  const saved = keys.map((key) => [key, process.env[key]] as const);
  for (const key of keys) delete process.env[key];
  try {
    const config = loadConfig(fs.mkdtempSync(path.join(os.tmpdir(), "henry-scout-defaults-")));
    assert.deepEqual(config.jobScoutTitles, [], "no titles are baked in");
    assert.equal(config.jobScoutLocation, "Remote", "a neutral location, not the author's city");
  } finally {
    for (const [key, value] of saved) if (value !== undefined) process.env[key] = value;
  }
});

async function activityFor(config: HenryConfig): Promise<ActivityLog> {
  const activity = new ActivityLog(config.activityPath);
  await activity.init();
  return activity;
}

function fakeRunner(response: string | (() => string), prompts: string[] = []): ProviderRunner & { calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    run: async (prompt: string) => {
      calls += 1;
      prompts.push(prompt);
      return { runId: "run-test", provider: "codex" as const, exitCode: 0, durationMs: 1, response: typeof response === "function" ? response() : response };
    },
  } as unknown as ProviderRunner & { calls: () => number };
}

function fakeMemory(sink: Array<{ text: string; options: Record<string, unknown> }>): HenryMemory {
  return {
    remember: async (text: string, options: Record<string, unknown>) => { sink.push({ text, options }); return "mem-id"; },
  } as unknown as HenryMemory;
}

class FakeBrowser implements ScoutBrowser {
  collects = 0;
  logins = 0;
  lastSources?: ScoutSourceName[];
  constructor(public supply: () => ScoutCollection) {}
  async login(): Promise<void> { this.logins += 1; }
  async collect(_titles: string[], _location: string, sources?: ScoutSourceName[]): Promise<ScoutCollection> {
    this.collects += 1;
    this.lastSources = sources;
    return this.supply();
  }
}

const NAUKRI = "https://www.naukri.com/job-listings-ai-product-manager-acme";

function listing(n: number, overrides: Partial<ScoutListing> = {}): ScoutListing {
  return {
    link: `${NAUKRI}-${n}`,
    title: `AI Product Manager ${n}`,
    company: `Acme ${n}`,
    location: "Bengaluru",
    postedAge: `${n}d ago`,
    searchTitle: "AI Product Manager",
    source: "naukri",
    ...overrides,
  };
}

function collection(listings: ScoutListing[], leads: ScoutCollection["leads"] = [], needsLogin = false): ScoutCollection {
  return { needsLogin, listings, leads };
}

function verdictJson(entries: Array<{ n: number; fit: number; why?: string }>): string {
  return JSON.stringify({
    verdicts: entries.map((entry) => ({ link: `${NAUKRI}-${entry.n}`, fit: entry.fit, why: entry.why ?? `strong overlap ${entry.n}` })),
  });
}

const DAY1 = new Date("2026-08-09T09:00:00");
const DAY2 = new Date("2026-08-10T09:00:00");
const DAY3 = new Date("2026-08-11T09:00:00");

/* ------------------------------------------------------------------ *
 * Fixture markup — captured shapes, never fetched. No test touches the
 * network: the sources parse an HTML STRING precisely so this is possible.
 * ------------------------------------------------------------------ */

/** Naukri SRP: logged-in header, two real cards (one with a title-attr-only location), a dupe, and a company link that is NOT a posting. */
const NAUKRI_SRP = `<!doctype html><html><body>
<div class="nI-gNb-header">
  <div class="nI-gNb-drawer"><a href="https://www.naukri.com/mnjuser/profile">View &amp; Update Profile</a></div>
</div>
<div class="styles_job-listing-container__OCfZC">
  <div class="srp-jobtuple-wrapper" data-job-id="010825006543">
    <div class="cust-job-tuple layout-wrapper lay-2 sjw__tuple">
      <div class="row1"><h2><a class="title" href="https://www.naukri.com/job-listings-associate-product-manager-acme-technologies-bengaluru-2-to-5-years-140825900123?src=jobsearchDesk&amp;sid=17435&amp;xp=1" target="_blank" title="Associate Product Manager">Associate Product&nbsp;Manager</a></h2></div>
      <div class="row2"><span class="comp-dtls-wrap"><a class="comp-name comp-name-wrap" href="https://www.naukri.com/acme-jobs-careers-12345">Acme Technologies Pvt Ltd</a><span class="rating"><span class="ratingWrapper">4.1</span></span></span></div>
      <div class="row3"><span class="expwdth" title="2-5 Yrs">2-5 Yrs</span><span class="sal">Not disclosed</span><span class="locWdth" title="Bengaluru, Hybrid">Bengaluru, Hybrid</span></div>
      <div class="row4"><span class="job-desc">Own the roadmap for our AI copilot.</span></div>
      <div class="row6"><span class="job-post-day">3 Days Ago</span></div>
    </div>
  </div>
  <div class="srp-jobtuple-wrapper" data-job-id="010825006544">
    <div class="cust-job-tuple layout-wrapper lay-2 sjw__tuple">
      <div class="row1"><h2><a class="title" href="/job-listings-ai-product-manager-zeta-labs-140825900456" title="AI Product Manager">AI Product Manager</a></h2></div>
      <div class="row2"><span class="comp-dtls-wrap"><a class="comp-name">Zeta Labs</a></span></div>
      <div class="row3"><span class="expwdth">3-6 Yrs</span><span class="locWdth" title="Gurugram"></span></div>
      <div class="row6"><span class="job-post-day">1 Day Ago</span></div>
    </div>
  </div>
  <div class="srp-jobtuple-wrapper" data-job-id="010825006543">
    <div class="cust-job-tuple">
      <div class="row1"><h2><a class="title" href="https://www.naukri.com/job-listings-associate-product-manager-acme-technologies-bengaluru-2-to-5-years-140825900123?src=drift&amp;sid=999">Associate Product Manager</a></h2></div>
      <div class="row2"><a class="comp-name">Acme Technologies Pvt Ltd</a></div>
    </div>
  </div>
  <div class="srp-jobtuple-wrapper">
    <div class="cust-job-tuple">
      <div class="row2"><a class="comp-name" href="https://www.naukri.com/acme-jobs-careers-12345">Acme Technologies Pvt Ltd</a></div>
    </div>
  </div>
</div>
</body></html>`;

/** The same search URL served to a signed-out browser: login layer, zero member markers. */
const NAUKRI_LOGGED_OUT = `<!doctype html><html><body>
<div class="nI-gNb-header"><div id="login_Layer" class="nI-gNb-lg-rg__login"><a href="https://www.naukri.com/nlogin/login">Login</a></div></div>
<div class="styles_job-listing-container__OCfZC"><div class="srp-jobtuple-wrapper"><div class="cust-job-tuple">
  <div class="row1"><h2><a class="title" href="https://www.naukri.com/job-listings-guest-visible-job-140825900999">Guest visible job</a></h2></div>
</div></div></div>
</body></html>`;

/** DuckDuckGo HTML endpoint: redirector-wrapped hit, an ad, a direct hit, a board homepage, and a duplicate. */
const DDG_RESULTS = `<!doctype html><html><body>
<div class="results">
  <div class="result results_links results_links_deep web-result">
    <div class="links_main links_deep result__body">
      <h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.instahyre.com%2Fjob%2F123456%2Fai-product-manager-acme%3Futm_source%3Dddg&amp;rut=deadbeef">AI Product Manager at Acme &mdash; Instahyre</a></h2>
      <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.instahyre.com%2Fjob%2F123456">Acme is hiring an AI PM in Bengaluru.</a>
    </div>
  </div>
  <div class="result results_links_deep result--ad">
    <div class="links_main"><a class="result__a" href="//duckduckgo.com/y.js?ad_provider=bingv7aa&amp;u3=sponsored">Sponsored: hire faster</a></div>
  </div>
  <div class="result results_links results_links_deep web-result">
    <div class="links_main"><a class="result__a" href="https://wellfound.com/jobs/98765-product-manager-ai">Product Manager, AI - Wellfound</a></div>
  </div>
  <div class="result results_links results_links_deep web-result">
    <div class="links_main"><a class="result__a" href="https://www.instahyre.com/">Instahyre: Jobs at top startups</a></div>
  </div>
  <div class="result results_links results_links_deep web-result">
    <div class="links_main"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.instahyre.com%2Fjob%2F123456%2Fai-product-manager-acme&amp;rut=cafe">AI Product Manager at Acme (again)</a></div>
  </div>
</div>
</body></html>`;

/** Minimal Page double for the source drivers — no Playwright, no network. */
class FakePage implements ScoutPage {
  visited: string[] = [];
  wheels = 0;
  private current = "https://www.naukri.com/";
  constructor(private readonly serve: (url: string) => string) {}
  async goto(url: string): Promise<unknown> { this.visited.push(url); this.current = url; return null; }
  url(): string { return this.current; }
  async content(): Promise<string> { return this.serve(this.current); }
  mouse = { wheel: async (): Promise<void> => { this.wheels += 1; } };
}

const noDelay = async (): Promise<void> => {};

/* ------------------------------------------------------------------ *
 * Naukri source
 * ------------------------------------------------------------------ */

test("naukri parser: reads cards off fixture HTML, strips tracking queries, drops non-postings and dupes", () => {
  const listings = parseNaukriCards(NAUKRI_SRP, "AI Product Manager");
  assert.equal(listings.length, 2, "two distinct postings — the dupe and the company-page card drop");

  assert.deepEqual(listings[0], {
    link: "https://www.naukri.com/job-listings-associate-product-manager-acme-technologies-bengaluru-2-to-5-years-140825900123",
    title: "Associate Product Manager",
    company: "Acme Technologies Pvt Ltd",
    location: "Bengaluru, Hybrid",
    postedAge: "3 Days Ago",
    experience: "2-5 Yrs",
    searchTitle: "AI Product Manager",
    source: "naukri",
  });

  // Relative href resolves against the search page; an empty span falls back to its title attribute.
  assert.equal(listings[1].link, "https://www.naukri.com/job-listings-ai-product-manager-zeta-labs-140825900456");
  assert.equal(listings[1].company, "Zeta Labs");
  assert.equal(listings[1].location, "Gurugram", "the DOM text is empty — the title attribute carries the real value");
  assert.equal(listings[1].postedAge, "1 Day Ago");
  assert.equal(listings[1].source, "naukri");

  assert.equal(parseNaukriCards(NAUKRI_SRP, "AI Product Manager", "https://www.naukri.com/", 1).length, 1, "the per-title cap is honoured");
  assert.deepEqual(parseNaukriCards("<html><body>nothing here</body></html>", "AI Product Manager"), [], "unrecognisable markup yields nothing, never a throw");
});

test("naukri logged-out detection: conservative — a logged-in page with a 'Login' string is still logged in", () => {
  const searchUrl = "https://www.naukri.com/ai-product-manager-jobs-in-bengaluru?k=ai%20product%20manager";
  assert.equal(detectNaukriLoggedOut(searchUrl, NAUKRI_SRP), false, "his real session must never be reported as expired");
  assert.equal(detectNaukriLoggedOut(searchUrl, NAUKRI_LOGGED_OUT), true, "a login layer with no member markers is a lapsed session");
  assert.equal(detectNaukriLoggedOut("https://www.naukri.com/nlogin/login?src=srp", "<html></html>"), true, "a redirect to the login page is decisive");
  assert.equal(
    detectNaukriLoggedOut(searchUrl, `<html><body><a href="/mnjuser/profile">Profile</a><div id="login_Layer">Login</div></body></html>`),
    false,
    "member markers win over a stray login layer — a false nudge every morning is worse than a missed one",
  );
});

test("naukri search URL: title slug plus the k/l query pair, one page per title", () => {
  assert.equal(
    naukriSearchUrl("AI Product Manager", "Bengaluru"),
    "https://www.naukri.com/ai-product-manager-jobs-in-bengaluru?k=AI%20Product%20Manager&l=Bengaluru",
  );
  assert.equal(naukriSearchUrl("Product Engineer", ""), "https://www.naukri.com/product-engineer-jobs?k=Product%20Engineer");
});

test("naukri pass: ≤1 search page per title, and a logged-out page stops the lane instead of failing it", async () => {
  const page = new FakePage(() => NAUKRI_SRP);
  const pass = await collectNaukri(page, ["AI Product Manager", "Product Engineer"], "Bengaluru", { delay: noDelay });
  assert.equal(pass.needsLogin, false);
  assert.equal(page.visited.length, 2, "exactly one search page per title — the volume rail");
  assert.equal(pass.listings.length, 4, "both titles' cards come back");
  assert.deepEqual([...new Set(pass.listings.map((item) => item.searchTitle))], ["AI Product Manager", "Product Engineer"]);
  assert.ok(page.wheels > 0, "lazy cards are coaxed in with scrolls, humanly paced");

  const loggedOut = new FakePage(() => NAUKRI_LOGGED_OUT);
  const lapsed = await collectNaukri(loggedOut, ["AI Product Manager", "Product Engineer"], "Bengaluru", { delay: noDelay });
  assert.equal(lapsed.needsLogin, true);
  assert.deepEqual(lapsed.listings, [], "guest-visible cards are not passed off as his personalised results");
  assert.equal(loggedOut.visited.length, 1, "no point loading more pages against an authwall");
});

/* ------------------------------------------------------------------ *
 * Web (DuckDuckGo HTML endpoint) source
 * ------------------------------------------------------------------ */

test("ddg parser: unwraps the redirector, drops ads/homepages/dupes, tags every row 'web'", () => {
  const listings = parseDuckDuckGoResults(DDG_RESULTS, "AI Product Manager");
  assert.equal(listings.length, 2, "the ad, the board homepage and the duplicate all drop");

  assert.deepEqual(listings[0], {
    link: "https://www.instahyre.com/job/123456/ai-product-manager-acme",
    title: "AI Product Manager at Acme — Instahyre",
    company: "instahyre.com",
    location: "",
    postedAge: "",
    searchTitle: "AI Product Manager",
    source: "web",
  });
  assert.equal(listings[1].link, "https://wellfound.com/jobs/98765-product-manager-ai", "direct (unwrapped) hrefs work too");
  assert.equal(listings[1].company, "wellfound.com");

  assert.equal(parseDuckDuckGoResults(DDG_RESULTS, "AI Product Manager", 1).length, 1, "the per-title cap is honoured");
  assert.deepEqual(parseDuckDuckGoResults("<html>captcha please</html>", "AI Product Manager"), [], "a blocked page yields nothing, never a throw");
});

test("ddg query: key-less HTML endpoint, site-filtered to job boards", () => {
  const query = duckDuckGoQuery("AI Product Manager", "Bengaluru");
  assert.match(query, /"AI Product Manager"/);
  assert.match(query, /site:instahyre\.com OR site:wellfound\.com/);
  const url = duckDuckGoUrl("AI Product Manager", "Bengaluru");
  assert.ok(url.startsWith("https://html.duckduckgo.com/html/?q="), "the no-JS HTML endpoint — no API key, no cost");
  assert.equal(decodeURIComponent(url.split("?q=")[1]), query);

  assert.equal(
    unwrapDuckDuckGoHref("//duckduckgo.com/l/?uddg=https%3A%2F%2Fcutshort.io%2Fjob%2F42&rut=x"),
    "https://cutshort.io/job/42",
  );
  assert.equal(unwrapDuckDuckGoHref("//duckduckgo.com/y.js?ad_provider=bingv7aa"), undefined, "ad slots never become leads");
  assert.equal(unwrapDuckDuckGoHref("https://jobs.lever.co/acme/123"), "https://jobs.lever.co/acme/123");
});

/* ------------------------------------------------------------------ *
 * Source list configuration
 * ------------------------------------------------------------------ */

test("jobs.sources: defaults to naukri+web+x (LinkedIn OFF), settings can re-enable, garbage falls back", () => {
  const config = tempConfig();
  assert.deepEqual(resolveScoutSources(config), ["naukri", "web", "x"], "no settings file: the default trio");
  assert.deepEqual(DEFAULT_SCOUT_SOURCES, ["naukri", "web", "x"]);
  assert.ok(!DEFAULT_SCOUT_SOURCES.includes("linkedin" as ScoutSourceName), "LinkedIn is not part of the daily pass");

  const write = (value: unknown): void => {
    fs.mkdirSync(path.dirname(config.settingsPath), { recursive: true });
    fs.writeFileSync(config.settingsPath, JSON.stringify({ provider: "codex", jobs: { sources: value } }));
  };

  write(["naukri"]);
  assert.deepEqual(resolveScoutSources(config), ["naukri"], "he can narrow the pass to Naukri only");
  write(["naukri", "web", "x", "linkedin"]);
  assert.deepEqual(resolveScoutSources(config), ["naukri", "web", "x", "linkedin"], "LinkedIn stays re-enablable");
  write(["NAUKRI", " web ", "naukri", "monster", 7]);
  assert.deepEqual(resolveScoutSources(config), ["naukri", "web"], "case/space tolerated; unknown and duplicate entries dropped");
  write(["monster"]);
  assert.deepEqual(resolveScoutSources(config), ["naukri", "web", "x"], "an all-typo list must not silently disable the scout");
  write("naukri");
  assert.deepEqual(resolveScoutSources(config), ["naukri", "web", "x"], "a non-array value falls back too");
});

/* ------------------------------------------------------------------ *
 * Verdict parsing / dedupe keys
 * ------------------------------------------------------------------ */

test("parseScoutVerdicts never trusts the model: garbage, unknown links, bad fits, blank whys all drop", () => {
  const valid = new Set([`${NAUKRI}-1`, `${NAUKRI}-2`, `${NAUKRI}-3`]);
  assert.deepEqual(parseScoutVerdicts("total garbage, no json at all", valid), []);
  assert.deepEqual(parseScoutVerdicts(`{"verdicts":"not an array"}`, valid), []);

  const raw = `Sure! Here are the scores:\n{"verdicts":[
    {"link":"${NAUKRI}-1","fit":9,"why":"agent-building overlap"},
    {"link":"https://evil.example/jobs/view/999","fit":10,"why":"unknown link must drop"},
    {"link":"${NAUKRI}-2","fit":"lots","why":"non-numeric fit must drop"},
    {"link":"${NAUKRI}-3","fit":25,"why":"clamped to ten"},
    {"link":"${NAUKRI}-1","fit":2,"why":"duplicate link must drop"},
    {"fit":5,"why":"no link"},
    {"link":"${NAUKRI}-2","fit":5,"why":"   "}
  ]}\ndone.`;
  const verdicts = parseScoutVerdicts(raw, valid);
  assert.equal(verdicts.length, 2, "only the two well-formed known-link rows survive");
  assert.deepEqual(verdicts[0], { link: `${NAUKRI}-1`, fit: 9, why: "agent-building overlap" });
  assert.equal(verdicts[1].fit, 10, "out-of-range fit clamps to 0-10 instead of being trusted");
});

test("canonicalLink strips tracking queries and fragments so dedupe keys are stable", () => {
  assert.equal(
    canonicalLink("https://www.naukri.com/job-listings-ai-pm-acme-140825900123/?src=jobsearchDesk&sid=17435"),
    "https://www.naukri.com/job-listings-ai-pm-acme-140825900123",
  );
  assert.equal(
    canonicalLink("/job-listings-ai-pm-acme-9?src=x", "https://www.naukri.com/ai-product-manager-jobs-in-bengaluru"),
    "https://www.naukri.com/job-listings-ai-pm-acme-9",
    "relative hrefs resolve against the page",
  );
  assert.equal(canonicalLink("not a url at all"), undefined);
});

/* ------------------------------------------------------------------ *
 * The daily pass
 * ------------------------------------------------------------------ */

test("scout: scores new listings in one batched call, writes the ranked shortlist, notifies one compact line, remembers in Engram", async () => {
  const config = tempConfig();
  const activity = await activityFor(config);
  const prompts: string[] = [];
  const memories: Array<{ text: string; options: Record<string, unknown> }> = [];
  const notifications: Array<{ message: string; title?: string }> = [];
  const order: string[] = [];
  const listings = [4, 5, 6, 7, 8].map((n) => listing(n));
  // The web lane rides the same pipeline and is tagged so the report can say where it came from.
  listings.push(listing(9, { source: "web", company: "instahyre.com", location: "", postedAge: "" }));
  const leads = [{ link: "https://x.com/acme/status/1", text: "We're hiring an AI PM in Bengaluru", searchTitle: "AI Product Manager", source: "x" as const }];
  const browser = new FakeBrowser(() => collection(listings, leads));
  const runner = fakeRunner(() => { order.push("score"); return verdictJson([4, 5, 6, 7, 8, 9].map((n) => ({ n, fit: n }))); }, prompts);
  const service = new JobScoutService(
    config, activity, runner, async (message, title) => { notifications.push({ message, title }); }, fakeMemory(memories),
    browser, undefined, async () => { order.push("idle"); },
  );

  const result = await service.scout({ now: DAY1 });
  assert.equal(result.date, "2026-08-09");
  assert.deepEqual(result.sources, ["naukri", "web", "x"], "the default source list drives the pass");
  assert.deepEqual(browser.lastSources, ["naukri", "web", "x"], "and is handed to the browser");
  assert.equal(result.collected, 6);
  assert.equal(result.fresh, 6);
  assert.equal(result.scored, 6);
  assert.equal(result.leads, 1);
  assert.equal(result.shortlisted.length, 5, "top 5 by fit — the fit-4 listing misses the cut");
  assert.deepEqual(result.shortlisted.map((entry) => entry.fit), [9, 8, 7, 6, 5], "ranked by fit, descending");
  assert.equal(result.shortlisted[0].source, "web", "every shortlist row carries its source");
  assert.equal(result.shortlisted[1].source, "naukri");
  assert.deepEqual(order, ["idle", "score"], "the interactive-idle courtesy hook runs right before the provider call");

  // The one batched prompt grounds in Luvish's real files and frames listings as untrusted data.
  assert.equal(runner.calls(), 1, "exactly ONE batched provider call for the whole pass");
  assert.match(prompts[0], /UNTRUSTED DATA/);
  assert.match(prompts[0], /Built Henry, a personal agent platform/);
  assert.match(prompts[0], /Target: AI product roles/);
  assert.match(prompts[0], /job-listings-ai-product-manager-acme-9/);
  assert.doesNotMatch(prompts[0], /linkedin\.com/, "LinkedIn is out of the daily pass entirely");

  // Ranked artifact Luvish reads.
  assert.ok(result.filePath && fs.existsSync(result.filePath), "shortlist markdown must exist");
  assert.ok(result.filePath!.endsWith(path.join("scout", "2026-08-09.md")));
  const markdown = fs.readFileSync(result.filePath!, "utf8");
  assert.match(markdown, /# Job scout — 2026-08-09/);
  assert.match(markdown, /^Sources: naukri, web, x$/m);
  assert.ok(markdown.indexOf("AI Product Manager 9") < markdown.indexOf("AI Product Manager 5"), "file lists best fit first");
  assert.match(markdown, /1\. \*\*AI Product Manager 9\*\* @ instahyre\.com — fit 9\/10 · via web/);
  assert.match(markdown, /2\. \*\*AI Product Manager 8\*\* @ Acme 8 — fit 8\/10 · via naukri/);
  assert.match(markdown, /job-listings-ai-product-manager-acme-9/);
  assert.match(markdown, /Why: strong overlap 9/);
  assert.match(markdown, /## X leads \(best-effort, unscored\)/);
  assert.match(markdown, /x\.com\/acme\/status\/1/);
  assert.doesNotMatch(markdown, /⚠️/, "a healthy pass carries no login warning");

  // One compact Telegram line.
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].title, "Henry — job scout");
  assert.match(notifications[0].message, /^🔎 Scout 2026-08-09: 5 shortlisted — top: AI Product Manager 9 @ instahyre\.com \(fit 9\/10, via web\)$/);

  // Engram trace with the agreed metadata.
  assert.equal(memories.length, 1);
  assert.match(memories[0].text, /Job scout shortlist 2026-08-09/);
  assert.match(memories[0].text, /via web/);
  assert.equal(memories[0].options.tier, "semantic");
  assert.equal(memories[0].options.importance, 6);
  assert.deepEqual(memories[0].options.metadata, { domain: "jobs", kind: "scout-shortlist", date: "2026-08-09" });
});

test("scout: dedupes against scout.db across runs — repeats cost zero provider calls, only new links are scored", async () => {
  const config = tempConfig();
  const activity = await activityFor(config);
  const prompts: string[] = [];
  const runner = fakeRunner(() => verdictJson([{ n: 1, fit: 8 }, { n: 2, fit: 6 }, { n: 3, fit: 7 }]), prompts);
  const browser = new FakeBrowser(() => collection([listing(1), listing(2)]));
  const service = new JobScoutService(config, activity, runner, undefined, undefined, browser);

  const first = await service.scout({ now: DAY1 });
  assert.equal(first.fresh, 2);
  assert.equal(runner.calls(), 1);

  // Same listings the next day: everything already seen — no provider spend, no shortlist.
  const second = await service.scout({ now: DAY2 });
  assert.equal(second.collected, 2);
  assert.equal(second.fresh, 0);
  assert.equal(second.shortlisted.length, 0);
  assert.equal(second.filePath, undefined);
  assert.equal(runner.calls(), 1, "nothing new means NO second provider call");

  // Day three surfaces one new card: only IT is sent for scoring.
  browser.supply = () => collection([listing(1), listing(2), listing(3)]);
  const third = await service.scout({ now: DAY3 });
  assert.equal(third.fresh, 1);
  assert.equal(runner.calls(), 2);
  assert.match(prompts[1], /acme-3/);
  assert.doesNotMatch(prompts[1], /acme-1"/, "already-seen links never re-enter the scoring prompt");

  // The seen table is durable — a fresh store instance still knows every link.
  const store = new ScoutStore(config);
  assert.equal(store.hasSeen(`${NAUKRI}-1`), true);
  assert.equal(store.hasSeen(`${NAUKRI}-3`), true);
  assert.equal(store.hasSeen(`${NAUKRI}-99`), false);
  store.close();
});

test("scout: one pass per day — the meta guard makes a re-fired cron a no-op", async () => {
  const config = tempConfig();
  const activity = await activityFor(config);
  const runner = fakeRunner(verdictJson([{ n: 1, fit: 8 }]));
  const browser = new FakeBrowser(() => collection([listing(1)]));
  const service = new JobScoutService(config, activity, runner, undefined, undefined, browser);

  const first = await service.scout({ now: DAY1 });
  assert.equal(first.skipped, undefined);

  const rerun = await service.scout({ now: DAY1 });
  assert.equal(rerun.skipped, true);
  assert.match(rerun.reason!, /already scouted 2026-08-09/);
  assert.equal(browser.collects, 1, "the second firing must not even open the browser");
  assert.equal(runner.calls(), 1);
});

test("scout: a lapsed Naukri session nudges once a day, never closes the day, and recovers after login", async () => {
  const config = tempConfig();
  const activity = await activityFor(config);
  const notifications: string[] = [];
  const runner = fakeRunner(verdictJson([{ n: 1, fit: 9 }]));
  const browser = new FakeBrowser(() => collection([], [], true));
  const service = new JobScoutService(config, activity, runner, async (message) => { notifications.push(message); }, undefined, browser);

  const first = await service.scout({ now: DAY1 });
  assert.equal(first.skipped, true, "nothing from any source — the day stays open");
  assert.equal(first.needsLogin, true);
  assert.match(first.reason!, /naukri session expired/i);
  assert.equal(runner.calls(), 0, "no provider spend with nothing to score");
  assert.deepEqual(notifications, [NAUKRI_LOGIN_NUDGE]);
  assert.match(notifications[0], /log in once in the scout browser/i);
  assert.match(notifications[0], /henry jobs login/, "the fix is inside the message");

  // A retry the same morning stays quiet — the nudge fires once per day, not per attempt.
  const retry = await service.scout({ now: DAY1 });
  assert.equal(retry.needsLogin, true);
  assert.equal(notifications.length, 1, "no second nudge the same day");

  // Luvish logs in; the SAME day's pass now runs in full, because it never set scouted:<date>.
  browser.supply = () => collection([listing(1)]);
  const recovered = await service.scout({ now: DAY1 });
  assert.equal(recovered.skipped, undefined);
  assert.equal(recovered.shortlisted.length, 1);
  assert.equal(runner.calls(), 1);
});

test("scout: a lapsed Naukri session does NOT kill the pass — web listings still get scored and reported, with a banner", async () => {
  const config = tempConfig();
  const activity = await activityFor(config);
  const notifications: string[] = [];
  const runner = fakeRunner(verdictJson([{ n: 2, fit: 7 }]));
  const webOnly = listing(2, { source: "web", company: "wellfound.com", location: "", postedAge: "" });
  const browser = new FakeBrowser(() => collection([webOnly], [], true));
  const service = new JobScoutService(config, activity, runner, async (message) => { notifications.push(message); }, undefined, browser);

  const result = await service.scout({ now: DAY1 });
  assert.equal(result.skipped, undefined, "the pass completes on the sources that DID work");
  assert.equal(result.needsLogin, true, "…while still reporting the lapsed session");
  assert.equal(result.shortlisted.length, 1);
  assert.equal(result.shortlisted[0].source, "web");
  const markdown = fs.readFileSync(result.filePath!, "utf8");
  assert.match(markdown, /⚠️ Naukri session expired/, "the report says the pass was half-blind");
  assert.equal(notifications[0], NAUKRI_LOGIN_NUDGE);
  assert.equal(notifications.length, 2, "the login nudge, then the shortlist headline");
  assert.match(notifications[1], /via web/);

  // The day DID complete this time — a re-fire is a no-op.
  const rerun = await service.scout({ now: DAY1 });
  assert.equal(rerun.skipped, true);
  assert.match(rerun.reason!, /already scouted/);
});

test("scout: a failed scoring pass throws and leaves the day fully retryable — nothing seen, no claim, no scouted meta", async () => {
  const config = tempConfig();
  const activity = await activityFor(config);
  const failingRunner = {
    run: async () => ({ runId: "r-fail", provider: "codex" as const, exitCode: 1, durationMs: 1, response: "", error: "rate limited" }),
  } as unknown as ProviderRunner;
  const browser = new FakeBrowser(() => collection([listing(1)]));
  const failing = new JobScoutService(config, activity, failingRunner, undefined, undefined, browser);

  await assert.rejects(() => failing.scout({ now: DAY1 }), /scout scoring failed/);

  const store = new ScoutStore(config);
  assert.equal(store.hasSeen(`${NAUKRI}-1`), false, "a failed pass must not mark listings seen");
  assert.equal(store.getMeta("scouted:2026-08-09"), undefined, "a failed pass must not close the day");
  assert.equal(store.claimDay("2026-08-09", DAY1), true, "the day claim must have been released");
  store.releaseDay("2026-08-09");
  store.close();

  // Once the provider recovers, the SAME morning runs in full.
  const retry = new JobScoutService(config, activity, fakeRunner(verdictJson([{ n: 1, fit: 8 }])), undefined, undefined, browser);
  const retried = await retry.scout({ now: DAY1 });
  assert.equal(retried.skipped, undefined);
  assert.equal(retried.shortlisted.length, 1);
});

test("scout day-claim: exclusive while live, blocks a concurrent pass, stale claims are taken over", async () => {
  const config = tempConfig();
  const activity = await activityFor(config);
  const now = DAY1;
  const holder = new ScoutStore(config);
  assert.equal(holder.claimDay("2026-08-09", now), true, "first claim wins");
  assert.equal(holder.claimDay("2026-08-09", now), false, "a live claim blocks re-claiming");
  const other = new ScoutStore(config);
  assert.equal(other.claimDay("2026-08-09", now), false, "a second handle (≈ another process) is blocked too");

  // While the claim is held, a whole scout() pass skips without opening the browser.
  const browser = new FakeBrowser(() => collection([listing(1)]));
  const service = new JobScoutService(config, activity, fakeRunner(verdictJson([{ n: 1, fit: 8 }])), undefined, undefined, browser);
  const blocked = await service.scout({ now });
  assert.equal(blocked.skipped, true);
  assert.match(blocked.reason!, /already running/);
  assert.equal(browser.collects, 0, "a blocked pass must not even open the browser");

  // A crashed pass can never release: after the staleness window the claim is taken over.
  const later = new Date(now.getTime() + 31 * 60 * 1000);
  assert.equal(other.claimDay("2026-08-09", later), true, "a stale claim must not wedge the day");
  other.releaseDay("2026-08-09");
  assert.equal(holder.claimDay("2026-08-09", later), true, "a released claim reopens");
  holder.close();
  other.close();
});

test("scout: learned-profile titles drive the search (defensively capped) and the shortlist header names THEM, not the config list", async () => {
  const config = tempConfig();
  const activity = await activityFor(config);
  const manyTitles = Array.from({ length: 12 }, (_, i) => `Learned Title ${i + 1}`);
  fs.mkdirSync(path.dirname(config.scoutProfilePath), { recursive: true });
  fs.writeFileSync(config.scoutProfilePath, JSON.stringify({ learnedAt: "2026-08-01T00:00:00.000Z", alerts: [], titles: manyTitles }));
  let searched: string[] = [];
  const browser: ScoutBrowser = {
    login: async () => {},
    collect: async (titles) => { searched = titles; return collection([listing(1)]); },
  };
  const service = new JobScoutService(config, activity, fakeRunner(verdictJson([{ n: 1, fit: 9 }])), undefined, undefined, browser);
  const result = await service.scout({ now: DAY1 });
  assert.equal(searched.length, MAX_SCOUT_TITLES, "the volume rail caps consumed titles");
  assert.deepEqual(searched, manyTitles.slice(0, MAX_SCOUT_TITLES));
  const markdown = fs.readFileSync(result.filePath!, "utf8");
  const searchedLine = markdown.split("\n").find((line) => line.startsWith("Searched:"));
  assert.ok(searchedLine, "shortlist must carry a Searched: header");
  assert.match(searchedLine!, /Learned Title 1/);
  assert.match(searchedLine!, /Learned Title 8/);
  assert.doesNotMatch(searchedLine!, /Learned Title 9/, "capped titles never reach the header");
  assert.doesNotMatch(searchedLine!, /AI Product Manager/, "the header reflects the searched titles, not config.jobScoutTitles");
});

test("alerts-sync caps persisted titles at the volume rail while keeping every learned alert on record", async () => {
  const config = tempConfig();
  const activity = await activityFor(config);
  const lines = Array.from({ length: 10 }, (_, i) => `ALERT|Sync Title ${i + 1}|Bengaluru|naukri`).join("\n");
  const learned = await syncAlertsFromMail(config, activity, fakeRunner(lines));
  assert.equal(learned.alerts.length, 10, "every distinct alert stays on record");
  assert.equal(learned.titles.length, MAX_SCOUT_TITLES, "persisted search titles are capped");
  const persisted = JSON.parse(fs.readFileSync(config.scoutProfilePath, "utf8")) as { titles: string[] };
  assert.equal(persisted.titles.length, MAX_SCOUT_TITLES);
  assert.equal(persisted.titles[0], "Sync Title 1");
});

test("scout --prepare N: stages the existing approval-gated prepare on the top N, one failure never kills the report", async () => {
  const config = tempConfig();
  const activity = await activityFor(config);
  const prepared: string[] = [];
  const runner = fakeRunner(verdictJson([{ n: 1, fit: 5 }, { n: 2, fit: 9 }, { n: 3, fit: 7 }]));
  const browser = new FakeBrowser(() => collection([listing(1), listing(2), listing(3)]));
  const prepareFn = async (url: string): Promise<{ id: string; approvalId?: string }> => {
    prepared.push(url);
    if (url.endsWith("-3")) throw new Error("form exploded");
    return { id: `app-${url.slice(-1)}`, approvalId: `appr-${url.slice(-1)}` };
  };
  const service = new JobScoutService(config, activity, runner, undefined, undefined, browser, prepareFn);

  const result = await service.scout({ now: DAY1, prepare: 2 });
  assert.deepEqual(
    prepared,
    [`${NAUKRI}-2`, `${NAUKRI}-3`],
    "prepare follows fit ranking (9 then 7), not collection order",
  );
  assert.equal(result.prepared.length, 2);
  assert.deepEqual(result.prepared[0], { url: `${NAUKRI}-2`, applicationId: "app-2", approvalId: "appr-2" });
  assert.equal(result.prepared[1].applicationId, undefined);
  assert.match(result.prepared[1].error!, /form exploded/);
  assert.equal(result.shortlisted.length, 3, "the scout report survives a failed prepare");
});
