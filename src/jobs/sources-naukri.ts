import {
  attrOf, canonicalLink, clamp, elementText, elementsByClass, findElement, findElements,
  hasClass, humanDelay, textByClass, type ScoutListing,
} from "./sources-common.ts";

/**
 * NAUKRI source for the morning scout — the lane that replaced LinkedIn (killed
 * 2026-08-14 after one authwall/browser-lock fight too many).
 *
 * It rides Luvish's ALREADY-LOGGED-IN Naukri session inside the persistent Chrome
 * profile (same userDataDir + stale-lock clearing the LinkedIn pass used), so results
 * are his real, personalised search results.
 *
 * READ-ONLY, non-negotiable: the scout opens search pages and reads cards. It never
 * applies, never messages a recruiter, never edits the profile, never clicks "I am
 * interested". Volume rails: ≤1 search page per title, human-ish delays between page
 * loads, one pass per day.
 *
 * The parsing happens on an HTML STRING, not in `page.evaluate` — that is what lets
 * `parseNaukriCards` be tested against fixtures with no live network.
 */

/** Volume rail: at most this many cards per title reach the scoring prompt. */
export const MAX_NAUKRI_CARDS_PER_TITLE = 15;
const PAGE_TIMEOUT_MS = 45_000;

/** The minimum of Playwright's Page the source actually uses — keeps this module fake-able in tests. */
export interface ScoutPage {
  goto(url: string, options?: { waitUntil?: "domcontentloaded"; timeout?: number }): Promise<unknown>;
  url(): string;
  content(): Promise<string>;
  mouse: { wheel(deltaX: number, deltaY: number): Promise<void> };
}

/**
 * Naukri's SRP is reachable by slug (`/product-manager-jobs-in-bengaluru`); the `k`/`l`
 * query pair is kept alongside it because the slug alone silently 404s for unusual
 * titles and Naukri then falls back to the query params.
 */
export function naukriSearchUrl(title: string, location: string): string {
  const slug = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const titleSlug = slug(title) || "jobs";
  const locationSlug = slug(location);
  const path = locationSlug ? `${titleSlug}-jobs-in-${locationSlug}` : `${titleSlug}-jobs`;
  const query = `k=${encodeURIComponent(title)}${location ? `&l=${encodeURIComponent(location)}` : ""}`;
  return `https://www.naukri.com/${path}?${query}`;
}

/**
 * Logged-out detection, deliberately conservative: a false positive would nag Luvish
 * every morning about a session that is fine, so a page showing ANY logged-in marker
 * (his profile drawer, a logout control, a recommended-jobs link) counts as logged in
 * even if a "Login" string also appears somewhere in the markup.
 */
export function detectNaukriLoggedOut(url: string, html: string): boolean {
  if (/\/nlogin\/login|\/mnjuser\/login|\/registration\/createaccount|\/wapp\/login/i.test(url)) return true;
  const loggedIn = /mnjuser\/profile|mnjuser\/homepage|mnjuser\/recommendedjobs|nI-gNb-drawer|nI-gNb-menuItems|id="logout"|>\s*Logout\s*<|>\s*Log\s*out\s*</i.test(html);
  if (loggedIn) return false;
  const loginWall = /id="login_Layer"|nI-gNb-lg-rg__login|class="[^"]*login-layer|name="usernameField"|>\s*Login\s*<|Login to your account/i.test(html);
  return loginWall;
}

/** Card containers, most-specific first — the first class that matches ANY element wins, so nested wrappers never double-count. */
const CARD_CLASSES = ["srp-jobtuple-wrapper", "cust-job-tuple", "jobTuple", "jobTupleHeader", "job-tuple"];

/** A Naukri posting link: `/job-listings-<slug>-<id>` today, `/job/<id>` on some surfaces. */
function isJobLink(link: string): boolean {
  try {
    const url = new URL(link);
    if (!/(^|\.)naukri\.com$/i.test(url.hostname)) return false;
    return /\/job-listings-|\/job\//i.test(url.pathname);
  } catch { return false; }
}

/** Splits the SRP into per-card chunks; falls back to slicing around posting anchors when class names drift. */
function cardChunks(html: string): string[] {
  for (const className of CARD_CLASSES) {
    const elements = elementsByClass(html, className);
    if (elements.length === 0) continue;
    return elements.map((element, index) => html.slice(element.start, elements[index + 1]?.start ?? html.length));
  }
  const anchors = findElements(html, (name, attrs) => name === "a" && /job-listings-/i.test(attrOf(attrs, "href") || ""));
  return anchors.map((anchor, index) => html.slice(anchor.start, anchors[index + 1]?.start ?? html.length));
}

/**
 * Parses a Naukri search-results page into listings. Everything here is UNTRUSTED
 * scraped text: fields are clamped, links are canonicalised (Naukri appends
 * `?src=jobsearchDesk&sid=…` per visit, which would defeat the dedupe table), and a
 * card without a resolvable posting link or title is dropped rather than guessed at.
 */
export function parseNaukriCards(
  html: string,
  searchTitle: string,
  baseUrl = "https://www.naukri.com/",
  limit = MAX_NAUKRI_CARDS_PER_TITLE,
): ScoutListing[] {
  const listings: ScoutListing[] = [];
  const seenHere = new Set<string>();
  for (const chunk of cardChunks(html)) {
    const anchor = findElement(chunk, (name, attrs) =>
      name === "a" && !!attrOf(attrs, "href") && (hasClass(attrs, "title") || /job-listings-|\/job\//i.test(attrOf(attrs, "href") || "")));
    if (!anchor) continue;
    const link = canonicalLink(attrOf(anchor.attrs, "href") || "", baseUrl);
    if (!link || !isJobLink(link) || seenHere.has(link)) continue;
    const title = elementText(chunk, anchor);
    if (!title) continue;
    seenHere.add(link);
    listings.push({
      link,
      title: clamp(title, 200),
      company: clamp(textByClass(chunk, ["comp-name", "companyInfo", "subTitle", "company-name"]) || "Unknown company", 200),
      location: clamp(textByClass(chunk, ["locWdth", "loc-wrap", "location", "loc"]), 200),
      postedAge: clamp(textByClass(chunk, ["job-post-day", "jobPostDay", "post-day"]), 60),
      experience: clamp(textByClass(chunk, ["expwdth", "exp-wrap", "experience", "exp"]), 60) || undefined,
      searchTitle,
      source: "naukri",
    });
    if (listings.length >= limit) break;
  }
  return listings;
}

export interface NaukriPassResult {
  needsLogin: boolean;
  listings: ScoutListing[];
}

/**
 * One daily Naukri pass: ≤1 search page per title, a couple of humanly-paced scrolls to
 * pull lazy cards into the DOM, then a pure parse of the rendered HTML. A logged-out
 * page stops the lane immediately (no point loading more pages against an authwall) and
 * reports `needsLogin` — the caller keeps whatever the other sources found and nudges
 * Luvish to log in once; it is NOT a failed pass.
 */
export async function collectNaukri(
  page: ScoutPage,
  titles: string[],
  location: string,
  options: { delay?: () => Promise<void>; limit?: number } = {},
): Promise<NaukriPassResult> {
  const delay = options.delay ?? humanDelay;
  const listings: ScoutListing[] = [];
  for (const title of titles) {
    await delay();
    await page.goto(naukriSearchUrl(title, location), { waitUntil: "domcontentloaded", timeout: PAGE_TIMEOUT_MS });
    await delay();
    for (let scroll = 0; scroll < 2; scroll += 1) {
      await page.mouse.wheel(0, 1200).catch(() => undefined);
      await delay();
    }
    const html = await page.content();
    if (detectNaukriLoggedOut(page.url(), html)) return { needsLogin: true, listings };
    listings.push(...parseNaukriCards(html, title, page.url(), options.limit ?? MAX_NAUKRI_CARDS_PER_TITLE));
  }
  return { needsLogin: false, listings };
}
