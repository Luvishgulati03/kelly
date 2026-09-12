import type { HenryConfig } from "../config.ts";
import { readSettings } from "../util/settings.ts";

/**
 * Shared vocabulary for the morning job scout's SOURCES (naukri / web / x / linkedin):
 * the listing + lead shapes every source produces, the dedupe-key canonicaliser, the
 * human-delay rail, and the tiny dependency-free HTML readers the fixture-tested
 * parsers are built from.
 *
 * Why hand-rolled HTML reading instead of a DOM library: ZERO new npm deps is a hard
 * rule here, and doing the parsing on an HTML STRING (rather than inside
 * `page.evaluate`) is what makes the Naukri/DDG parsers testable against fixtures with
 * no live network — the browser's only job becomes "fetch me the markup".
 */

/** Every source the scout knows how to run. `linkedin` exists but is OFF by default (see DEFAULT_SCOUT_SOURCES). */
export const ALL_SCOUT_SOURCES = ["naukri", "web", "x", "linkedin"] as const;
export type ScoutSourceName = (typeof ALL_SCOUT_SOURCES)[number];

/**
 * LinkedIn is deliberately absent: repeated browser trouble (authwall loops, the
 * Singleton-lock death spiral) killed that lane on 2026-08-14. Naukri rides Luvish's
 * already-logged-in session, the web lane is key-less DuckDuckGo, X stays best-effort.
 * `data/settings.json` → `{"jobs":{"sources":[…]}}` can re-enable a piece later.
 */
export const DEFAULT_SCOUT_SOURCES: ScoutSourceName[] = ["naukri", "web", "x"];

export interface ScoutListing {
  /** Canonical job link (origin + pathname, query/fragment stripped) — the dedupe key. */
  link: string;
  title: string;
  company: string;
  location: string;
  postedAge: string;
  /** Which configured search title surfaced this card. */
  searchTitle: string;
  /** Which source produced it — carried through scoring into the shortlist row. */
  source: ScoutSourceName;
  /** Naukri prints an experience band ("2-5 Yrs"); other sources leave it blank. */
  experience?: string;
}

export interface ScoutLead {
  link: string;
  text: string;
  searchTitle: string;
  source: ScoutSourceName;
}

export interface ScoutCollection {
  /**
   * The Naukri session is expired/logged out. NOT fatal any more: the pass keeps whatever
   * the web/X lanes returned and the service nudges Luvish once a day to log in.
   */
  needsLogin: boolean;
  listings: ScoutListing[];
  leads: ScoutLead[];
  /** Sources that actually ran this pass — printed in the shortlist header. */
  sources?: ScoutSourceName[];
}

/**
 * Reads the optional `jobs.sources` operator flag out of data/settings.json.
 * Anything unrecognised is dropped rather than trusted (the file is hand-editable),
 * and an empty/garbage list falls back to the default trio — a typo must never
 * silently turn the morning scout into a no-op.
 */
export function resolveScoutSources(config: HenryConfig): ScoutSourceName[] {
  const jobs = readSettings(config.settingsPath).jobs;
  const raw = jobs && typeof jobs === "object" && !Array.isArray(jobs)
    ? (jobs as Record<string, unknown>).sources
    : undefined;
  if (!Array.isArray(raw)) return [...DEFAULT_SCOUT_SOURCES];
  const known = new Set<string>(ALL_SCOUT_SOURCES);
  const picked: ScoutSourceName[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const name = entry.trim().toLowerCase();
    if (!known.has(name) || picked.includes(name as ScoutSourceName)) continue;
    picked.push(name as ScoutSourceName);
  }
  return picked.length ? picked : [...DEFAULT_SCOUT_SOURCES];
}

/** Human-ish pause between scripted browser actions (1.5–4s, randomized) — never machine-gun a site. */
export function humanDelay(rng: () => number = Math.random): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 1_500 + Math.floor(rng() * 2_500)));
}

/**
 * Canonicalizes a link for stable dedupe keys: origin + pathname only — every job board
 * loves per-visit tracking queries (`?refId=…`, `?src=jobsearchDesk&sid=…`) that would
 * defeat the seen table.
 */
export function canonicalLink(raw: string, base?: string): string | undefined {
  try {
    const url = new URL(raw, base);
    return `${url.origin}${url.pathname.replace(/\/$/, "")}`;
  } catch {
    return undefined;
  }
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”",
};

/** Decodes the handful of entities job boards actually emit, plus numeric refs. */
export function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith("#")) {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** Markup → readable single-line text (scripts/styles dropped, entities decoded, whitespace collapsed). */
export function stripTags(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<[^>]*>/g, " "),
  ).replace(/\s+/g, " ").trim();
}

export interface HtmlElement {
  name: string;
  /** Raw attribute text of the open tag. */
  attrs: string;
  /** Index of the `<`. */
  start: number;
  /** Index just past the `>` — where the element's content begins. */
  contentStart: number;
}

/** Fresh instance per scan — a shared /g regex carries `lastIndex` between calls and would skip tags on re-entry. */
const openTagScanner = (): RegExp => /<([a-zA-Z][a-zA-Z0-9-]*)\b([^>]*)>/g;

/** Reads one attribute off an open tag's attribute text (quoted, single-quoted, or bare). */
export function attrOf(attrs: string, name: string): string | undefined {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(attrs);
  if (!match) return undefined;
  return decodeEntities(match[1] ?? match[2] ?? match[3] ?? "");
}

/** Whitespace-exact class membership — `loc` must never match `location-wrapper`. */
export function hasClass(attrs: string, className: string): boolean {
  const value = attrOf(attrs, "class");
  return value ? value.split(/\s+/).includes(className) : false;
}

/** Every open tag matching `predicate`, in document order. */
export function findElements(html: string, predicate: (name: string, attrs: string) => boolean): HtmlElement[] {
  const found: HtmlElement[] = [];
  const scanner = openTagScanner();
  for (let match = scanner.exec(html); match; match = scanner.exec(html)) {
    const name = match[1].toLowerCase();
    if (predicate(name, match[2])) found.push({ name, attrs: match[2], start: match.index, contentStart: scanner.lastIndex });
  }
  return found;
}

export function findElement(html: string, predicate: (name: string, attrs: string) => boolean): HtmlElement | undefined {
  return findElements(html, predicate)[0];
}

/** Elements carrying an exact class token. */
export function elementsByClass(html: string, className: string): HtmlElement[] {
  return findElements(html, (_name, attrs) => hasClass(attrs, className));
}

/**
 * Inner markup of `element`, nesting-aware for its own tag name (a `<div class="row3">`
 * full of `<div>`s must not end at the first `</div>`). Unclosed elements — job boards
 * ship plenty — yield the rest of the chunk rather than nothing.
 */
export function innerHtml(html: string, element: HtmlElement): string {
  const scanner = new RegExp(`<(/?)${element.name}\\b[^>]*>`, "gi");
  scanner.lastIndex = element.contentStart;
  let depth = 1;
  for (let match = scanner.exec(html); match; match = scanner.exec(html)) {
    if (match[1] === "/") {
      depth -= 1;
      if (depth === 0) return html.slice(element.contentStart, match.index);
    } else if (!/\/>$/.test(match[0])) {
      depth += 1;
    }
  }
  return html.slice(element.contentStart);
}

/**
 * Best text for an element: its rendered text, else its `title` attribute — Naukri
 * truncates long locations in the DOM and keeps the full value in `title`.
 */
export function elementText(html: string, element: HtmlElement): string {
  const text = stripTags(innerHtml(html, element));
  return text || (attrOf(element.attrs, "title") || "").trim();
}

/**
 * First non-empty text among a list of class names — the drift-tolerance knob. Job
 * boards reshuffle class names constantly, so every field names several candidates.
 */
export function textByClass(html: string, classNames: string[]): string {
  for (const className of classNames) {
    for (const element of elementsByClass(html, className)) {
      const text = elementText(html, element);
      if (text) return text;
    }
  }
  return "";
}

/** Clamp helper so a hostile/huge scraped field can never blow up a prompt or a markdown row. */
export function clamp(value: string, max: number): string {
  return value.replace(/\s+/g, " ").trim().slice(0, max);
}
