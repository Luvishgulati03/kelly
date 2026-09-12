import {
  attrOf, canonicalLink, clamp, elementText, findElements, hasClass, humanDelay,
  type ScoutListing,
} from "./sources-common.ts";
import type { ScoutPage } from "./sources-naukri.ts";

/**
 * OPEN-WEB source for the morning scout: $0 and key-less. It queries DuckDuckGo's
 * no-JavaScript HTML endpoint (html.duckduckgo.com/html/?q=…) once per title with a
 * site-filtered job-board query and reads the organic results into leads.
 *
 * Best effort by contract: a blocked endpoint, a captcha, or markup drift returns
 * nothing and NEVER fails the pass — Naukri is the primary lane, this one is upside.
 * Everything it returns is untrusted scraped text (the title is the result's own
 * headline, the "company" is only a hostname guess), so the scoring prompt frames it
 * as data and the shortlist row is tagged `web` for Luvish to eyeball.
 */

/** Volume rail: at most this many web leads per title reach the scoring prompt. */
export const MAX_WEB_RESULTS_PER_TITLE = 5;
const PAGE_TIMEOUT_MS = 45_000;

/** Boards worth a site: filter — Indian-market job boards plus the two ATS hosts most startups post on. */
export const WEB_JOB_SITES = [
  "instahyre.com",
  "wellfound.com",
  "cutshort.io",
  "jobs.lever.co",
  "boards.greenhouse.io",
  "careers.google.com",
];

/** Hosts whose links are never a posting (the search engine's own plumbing/ads). */
const NON_RESULT_HOSTS = /(^|\.)duckduckgo\.com$/i;

export function duckDuckGoQuery(title: string, location: string): string {
  const sites = WEB_JOB_SITES.map((site) => `site:${site}`).join(" OR ");
  return `"${title}" jobs ${location} (${sites})`.replace(/\s+/g, " ").trim();
}

export function duckDuckGoUrl(title: string, location: string): string {
  return `https://html.duckduckgo.com/html/?q=${encodeURIComponent(duckDuckGoQuery(title, location))}`;
}

/**
 * DuckDuckGo wraps organic hrefs in its own redirector (`//duckduckgo.com/l/?uddg=<encoded>`)
 * and sometimes serves the target directly. Both shapes unwrap to the real destination
 * here; protocol-relative hrefs get https.
 */
export function unwrapDuckDuckGoHref(href: string): string | undefined {
  const raw = href.startsWith("//") ? `https:${href}` : href;
  try {
    const url = new URL(raw, "https://html.duckduckgo.com/");
    const wrapped = url.searchParams.get("uddg");
    if (wrapped) return wrapped;
    if (NON_RESULT_HOSTS.test(url.hostname)) return undefined; // /y.js ad slots and internal links
    return url.toString();
  } catch { return undefined; }
}

/** "https://www.instahyre.com/job/123" → "instahyre.com" — the only "company" a web hit can honestly claim. */
function hostLabel(link: string): string {
  try { return new URL(link).hostname.replace(/^www\./i, ""); } catch { return "unknown source"; }
}

/**
 * Parses a DuckDuckGo HTML-endpoint page into listings. Ad rows, the redirector's own
 * links, and bare domain roots (`https://instahyre.com` — a board's front page, not a
 * posting) are dropped: a lead Luvish cannot open on a specific job is noise.
 */
export function parseDuckDuckGoResults(
  html: string,
  searchTitle: string,
  limit = MAX_WEB_RESULTS_PER_TITLE,
): ScoutListing[] {
  const anchors = findElements(html, (name, attrs) => name === "a" && hasClass(attrs, "result__a"));
  const listings: ScoutListing[] = [];
  const seenHere = new Set<string>();
  for (const anchor of anchors) {
    const href = attrOf(anchor.attrs, "href");
    if (!href) continue;
    const target = unwrapDuckDuckGoHref(href);
    if (!target) continue;
    const link = canonicalLink(target);
    // A canonical link with an empty path is a board's homepage, not a posting.
    if (!link || !/^https?:/i.test(link) || new URL(link).pathname.length <= 1 || seenHere.has(link)) continue;
    const title = elementText(html, anchor);
    if (!title) continue;
    seenHere.add(link);
    listings.push({
      link,
      title: clamp(title, 200),
      company: hostLabel(link),
      location: "",
      postedAge: "",
      searchTitle,
      source: "web",
    });
    if (listings.length >= limit) break;
  }
  return listings;
}

/**
 * One key-less web pass: ≤1 DuckDuckGo page per title, human-paced. Per-title failures
 * are swallowed so one blocked query never costs the other titles — and the caller
 * wraps the whole lane again, because "best effort" must survive a dead endpoint.
 */
export async function collectWeb(
  page: ScoutPage,
  titles: string[],
  location: string,
  options: { delay?: () => Promise<void>; limit?: number } = {},
): Promise<ScoutListing[]> {
  const delay = options.delay ?? humanDelay;
  const listings: ScoutListing[] = [];
  for (const title of titles) {
    try {
      await delay();
      await page.goto(duckDuckGoUrl(title, location), { waitUntil: "domcontentloaded", timeout: PAGE_TIMEOUT_MS });
      listings.push(...parseDuckDuckGoResults(await page.content(), title, options.limit ?? MAX_WEB_RESULTS_PER_TITLE));
    } catch { /* blocked, captcha, timeout, drift — this lane is upside, never a failure */ }
  }
  return listings;
}
