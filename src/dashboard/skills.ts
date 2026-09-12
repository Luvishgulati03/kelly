import fs from "node:fs/promises";
import path from "node:path";

/**
 * Skill loader for the web chat.
 *
 * Until now `skills/` was documentation: markdown a *coding agent* reads when it
 * happens to be working in this repo. Nothing in Henry loaded it. This module makes
 * it a real, runtime-selectable resource:
 *
 *   skills/<name>/SKILL.md   → skill "<name>"
 *   skills/<name>.md         → skill "<name>"
 *
 * Files are enumerated and read FROM DISK at request/send time — no build step, no
 * bundling, no cache — so editing a skill takes effect on the next turn.
 *
 * A skill's body is authored by Luvish and injected as GUIDANCE, wrapped in a header
 * that says what it is. It never becomes an instruction to act outbound: the approval
 * gate is unchanged and this module grants no new capability.
 */

export interface SkillSummary {
  name: string;
  description: string;
  /** Repo-relative path of the markdown that backs this skill. */
  path: string;
}

export interface LoadedSkill extends SkillSummary {
  content: string;
}

/** A skill name is a single path segment — never a traversal, never nested. */
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** Injected guidance is capped so a long playbook cannot crowd out the request itself. */
export const MAX_SKILL_CHARS = 24_000;

export function isSkillName(value: string): boolean {
  return NAME_PATTERN.test(value) && !value.includes("..");
}

/**
 * Splits optional YAML-ish frontmatter (`---` … `---`) off the top of a markdown file.
 * Only the flat `key: value` pairs these skill files actually use are parsed — this is
 * deliberately not a YAML implementation, and no dependency is added for it.
 */
export function parseFrontmatter(raw: string): { fields: Record<string, string>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!match) return { fields: {}, body: raw };
  const fields: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim().replace(/^(["'])([\s\S]*)\1$/, "$2");
    if (key && value) fields[key] = value;
  }
  return { fields, body: raw.slice(match[0].length) };
}

/** Frontmatter `description`, else the first real paragraph, else "". Always one line. */
export function describeSkill(raw: string): string {
  const { fields, body } = parseFrontmatter(raw);
  if (fields.description) return oneLine(fields.description);
  for (const block of body.split(/\r?\n\s*\r?\n/)) {
    const text = block.trim();
    if (!text || text.startsWith("#") || text.startsWith("---")) continue;
    return oneLine(text);
  }
  return "";
}

function oneLine(value: string): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > 240 ? `${flat.slice(0, 239)}…` : flat;
}

function skillsDir(rootDir: string): string {
  return path.join(rootDir, "skills");
}

/** Both layouts, resolved without ever leaving `skills/`. Returns undefined for an unknown name. */
async function resolveSkillFile(rootDir: string, name: string): Promise<string | undefined> {
  if (!isSkillName(name)) return undefined;
  const base = skillsDir(rootDir);
  for (const candidate of [path.join(base, name, "SKILL.md"), path.join(base, `${name}.md`)]) {
    const resolved = path.resolve(candidate);
    if (resolved !== path.resolve(base) && !resolved.startsWith(`${path.resolve(base)}${path.sep}`)) continue;
    try {
      const stat = await fs.stat(resolved);
      if (stat.isFile()) return resolved;
    } catch { /* try the next layout */ }
  }
  return undefined;
}

/** Every skill in `skills/`, alphabetical. Unreadable entries are skipped, never thrown. */
export async function listSkills(rootDir: string): Promise<SkillSummary[]> {
  const base = skillsDir(rootDir);
  let entries: Array<{ name: string; isDirectory(): boolean }>;
  try { entries = await fs.readdir(base, { withFileTypes: true }); } catch { return []; }
  const skills: SkillSummary[] = [];
  for (const entry of entries) {
    const name = entry.isDirectory() ? entry.name : entry.name.replace(/\.md$/i, "");
    if (!entry.isDirectory() && !/\.md$/i.test(entry.name)) continue;
    if (!isSkillName(name)) continue;
    const file = await resolveSkillFile(rootDir, name);
    if (!file) continue;
    let raw = "";
    try { raw = await fs.readFile(file, "utf8"); } catch { continue; }
    skills.push({ name, description: describeSkill(raw), path: path.relative(rootDir, file) });
  }
  skills.sort((a, b) => a.name.localeCompare(b.name));
  return skills;
}

/** Reads one skill from disk at call time. Undefined when the name is unknown or unreadable. */
export async function loadSkill(rootDir: string, name: string): Promise<LoadedSkill | undefined> {
  const file = await resolveSkillFile(rootDir, name);
  if (!file) return undefined;
  let raw: string;
  try { raw = await fs.readFile(file, "utf8"); } catch { return undefined; }
  const content = raw.length > MAX_SKILL_CHARS ? `${raw.slice(0, MAX_SKILL_CHARS)}\n\n[skill truncated]` : raw;
  return { name, description: describeSkill(raw), path: path.relative(rootDir, file), content };
}

/**
 * The block prepended to a turn when a skill is active. It labels the material as
 * Luvish's own operating guidance for this turn and restates the outbound rail, so
 * loading a skill can never read as permission to act.
 */
export function skillGuidanceBlock(skill: LoadedSkill): string {
  return [
    `--- Active skill: ${skill.name} (${skill.path}) ---`,
    "Luvish selected this playbook for this turn. Follow it as operating guidance for how to answer.",
    "It grants no new permission: nothing goes outbound (email, post, message, commit) without his explicit approval.",
    "",
    skill.content.trim(),
    `--- end skill: ${skill.name} ---`,
  ].join("\n");
}
