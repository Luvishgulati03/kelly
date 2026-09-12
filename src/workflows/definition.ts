import fs from "node:fs/promises";
import path from "node:path";
import { Cron } from "croner";
import type {
  WorkflowFile,
  WorkflowOutput,
  WorkflowParseResult,
  WorkflowRunnerConfig,
  WorkflowTrigger,
} from "./types.ts";

export const WORKFLOW_SUFFIX = ".workflow.md";
/** Every docs artifact must live under this root, relative to the repository root. */
export const WORKFLOW_RUNS_ROOT = "data/workflow-runs";

type FrontmatterValue = string | number | boolean | FrontmatterValue[] | { [key: string]: FrontmatterValue };

interface Line { indent: number; text: string }

const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]*:(\s|$)/;

/** Drops blanks and comments, records indentation, and splits `- key: value` into a dash line + a mapping line. */
function tokenize(source: string): Line[] {
  const lines: Line[] = [];
  for (const raw of source.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const indent = raw.length - raw.trimStart().length;
    if (trimmed.startsWith("- ")) {
      const rest = trimmed.slice(2).trim();
      if (KEY_PATTERN.test(rest)) {
        lines.push({ indent, text: "-" });
        lines.push({ indent: indent + 2, text: rest });
        continue;
      }
    }
    lines.push({ indent, text: trimmed });
  }
  return lines;
}

function scalar(raw: string): FrontmatterValue {
  const value = raw.trim();
  if (value.length > 1 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1);
  }
  if (value === "true") return true;
  if (value === "false") return false;
  if (value !== "" && !Number.isNaN(Number(value))) return Number(value);
  return value;
}

/** Recursive indentation parser covering mappings, scalar sequences and sequences of mappings. */
function parseBlock(lines: Line[], start: number, indent: number): [FrontmatterValue, number] {
  const first = lines[start];
  if (first && (first.text === "-" || first.text.startsWith("- "))) {
    const items: FrontmatterValue[] = [];
    let index = start;
    while (index < lines.length && lines[index].indent === indent && (lines[index].text === "-" || lines[index].text.startsWith("- "))) {
      const line = lines[index];
      index += 1;
      if (line.text.startsWith("- ")) { items.push(scalar(line.text.slice(2))); continue; }
      if (index < lines.length && lines[index].indent > indent) {
        const [value, next] = parseBlock(lines, index, lines[index].indent);
        items.push(value);
        index = next;
      } else items.push("");
    }
    return [items, index];
  }

  const record: Record<string, FrontmatterValue> = {};
  let index = start;
  while (index < lines.length && lines[index].indent === indent) {
    const line = lines[index];
    const separator = line.text.indexOf(":");
    if (separator < 0) { index += 1; continue; }
    const key = line.text.slice(0, separator).trim();
    const inline = line.text.slice(separator + 1).trim();
    index += 1;
    if (inline) { record[key] = scalar(inline); continue; }
    // A block value is indented deeper, except a sequence which YAML also allows flush with its key.
    const next = lines[index];
    const flushSequence = next?.indent === indent && (next.text === "-" || next.text.startsWith("- "));
    if (index < lines.length && (lines[index].indent > indent || flushSequence)) {
      const [value, nextIndex] = parseBlock(lines, index, lines[index].indent);
      record[key] = value;
      index = nextIndex;
    } else record[key] = "";
  }
  return [record, index];
}

export function parseFrontmatter(source: string): Record<string, FrontmatterValue> {
  const lines = tokenize(source);
  if (!lines.length) return {};
  const [value] = parseBlock(lines, 0, lines[0].indent);
  return typeof value === "object" && !Array.isArray(value) ? value : {};
}

/** Splits `---\n<frontmatter>\n---\n<body>`; returns undefined when the fences are missing. */
function splitDocument(source: string): { frontmatter: string; body: string } | undefined {
  const lines = source.split(/\r?\n/);
  let cursor = 0;
  while (cursor < lines.length && !lines[cursor].trim()) cursor += 1;
  if (lines[cursor]?.trim() !== "---") return undefined;
  const start = cursor + 1;
  for (let index = start; index < lines.length; index += 1) {
    if (lines[index].trim() === "---") {
      return { frontmatter: lines.slice(start, index).join("\n"), body: lines.slice(index + 1).join("\n").trim() };
    }
  }
  return undefined;
}

function asString(value: FrontmatterValue | undefined): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

function asArray(value: FrontmatterValue | undefined): FrontmatterValue[] {
  if (Array.isArray(value)) return value;
  return value === undefined || value === "" ? [] : [value];
}

function asRecord(value: FrontmatterValue | undefined): Record<string, FrontmatterValue> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

/**
 * True when `candidate` stays inside `data/workflow-runs/<name>`. Rejects absolute
 * paths and any `..` traversal — a workflow file is user-editable config, so it must
 * never be able to point artifact writes at an arbitrary location on disk.
 */
export function isAllowedDocsPath(candidate: string, workflowName: string): boolean {
  if (!candidate || path.isAbsolute(candidate) || candidate.includes("\0")) return false;
  const normalized = path.posix.normalize(candidate.replace(/\\/g, "/")).replace(/\/+$/, "");
  if (normalized.startsWith("../") || normalized === ".." || normalized.startsWith("/")) return false;
  const base = `${WORKFLOW_RUNS_ROOT}/${workflowName}`;
  return normalized === base || normalized.startsWith(`${base}/`);
}

function parseTriggers(raw: FrontmatterValue | undefined, errors: string[]): WorkflowTrigger[] {
  const triggers: WorkflowTrigger[] = [];
  for (const entry of asArray(raw)) {
    const record = asRecord(entry);
    if (!record) { errors.push(`trigger must be a mapping, got: ${JSON.stringify(entry)}`); continue; }
    const type = asString(record.type);
    if (type === "schedule") {
      const cron = asString(record.cron);
      const timezone = asString(record.timezone);
      if (!cron) { errors.push("schedule trigger is missing a cron expression"); continue; }
      try {
        new Cron(cron, { paused: true, ...(timezone ? { timezone } : {}) }).stop();
      } catch (error) {
        errors.push(`invalid cron "${cron}"${timezone ? ` (timezone ${timezone})` : ""}: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      triggers.push({ type: "schedule", cron, ...(timezone ? { timezone } : {}) });
    } else if (type === "command") {
      const command = asString(record.command);
      if (!command) { errors.push("command trigger is missing a command name"); continue; }
      triggers.push({ type: "command", command });
    } else errors.push(`unknown trigger type: ${String(type)}`);
  }
  return triggers;
}

function parseOutputs(raw: FrontmatterValue | undefined, name: string, errors: string[]): WorkflowOutput[] {
  const outputs: WorkflowOutput[] = [];
  for (const entry of asArray(raw)) {
    const record = asRecord(entry);
    if (!record) { errors.push(`output must be a mapping, got: ${JSON.stringify(entry)}`); continue; }
    const type = asString(record.type);
    if (type !== "docs") { errors.push(`unknown output type: ${String(type)}`); continue; }
    const docsPath = asString(record.path) ?? "";
    if (!isAllowedDocsPath(docsPath, name)) {
      errors.push(`docs output path must be under ${WORKFLOW_RUNS_ROOT}/${name} (got "${docsPath}")`);
      continue;
    }
    outputs.push({ type: "docs", path: docsPath });
  }
  return outputs;
}

function parseRunner(raw: FrontmatterValue | undefined, errors: string[]): WorkflowRunnerConfig | undefined {
  const record = asRecord(raw);
  if (!record) return undefined;
  const runner: WorkflowRunnerConfig = {};
  const provider = asString(record.provider);
  if (provider !== undefined) {
    if (provider !== "codex" && provider !== "claude") errors.push(`unknown runner provider: ${provider}`);
    else runner.provider = provider;
  }
  const tier = asString(record.tier);
  if (tier !== undefined) {
    if (tier !== "t0" && tier !== "t1" && tier !== "t2") errors.push(`unknown runner tier: ${tier}`);
    else runner.tier = tier;
  }
  if (record.timeoutMs !== undefined && record.timeoutMs !== "") {
    const timeoutMs = Number(record.timeoutMs);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) errors.push(`runner timeoutMs must be a positive number, got: ${String(record.timeoutMs)}`);
    else runner.timeoutMs = timeoutMs;
  }
  return Object.keys(runner).length ? runner : undefined;
}

/** Parses one workflow document. `filePath` supplies the expected name and is echoed on the result. */
export function parseWorkflow(source: string, filePath: string): WorkflowParseResult {
  const errors: string[] = [];
  const fileName = path.basename(filePath);
  if (!fileName.endsWith(WORKFLOW_SUFFIX)) return { ok: false, errors: [`workflow file must end with ${WORKFLOW_SUFFIX}: ${fileName}`] };
  const expectedName = fileName.slice(0, -WORKFLOW_SUFFIX.length);

  const document = splitDocument(source);
  if (!document) return { ok: false, errors: [`${fileName}: missing --- frontmatter fences`] };

  const frontmatter = parseFrontmatter(document.frontmatter);
  const name = asString(frontmatter.name) ?? "";
  if (!name) errors.push("frontmatter is missing name");
  else if (name !== expectedName) errors.push(`name "${name}" does not match filename "${expectedName}"`);

  const enabledRaw = frontmatter.enabled;
  const enabled = enabledRaw === undefined || enabledRaw === "" ? true : enabledRaw === true || enabledRaw === "true";
  const description = asString(frontmatter.description) ?? "";
  const triggers = parseTriggers(frontmatter.triggers, errors);
  const outputs = parseOutputs(frontmatter.outputs, name || expectedName, errors);
  const runner = parseRunner(frontmatter.runner, errors);

  const concurrencyRaw = asString(frontmatter.concurrency);
  let concurrency: WorkflowFile["concurrency"];
  if (concurrencyRaw !== undefined && concurrencyRaw !== "") {
    if (concurrencyRaw !== "skip" && concurrencyRaw !== "parallel") errors.push(`unknown concurrency: ${concurrencyRaw}`);
    else concurrency = concurrencyRaw;
  }

  if (!document.body.trim()) errors.push("workflow body (the prompt) is empty");
  if (errors.length) return { ok: false, errors: errors.map((error) => `${fileName}: ${error}`) };

  return {
    ok: true,
    errors: [],
    workflow: {
      name, enabled, description, triggers, outputs,
      ...(runner ? { runner } : {}), ...(concurrency ? { concurrency } : {}),
      body: document.body, sourcePath: path.resolve(filePath),
    },
  };
}

export async function loadWorkflowFile(filePath: string): Promise<WorkflowParseResult> {
  try {
    return parseWorkflow(await fs.readFile(filePath, "utf8"), filePath);
  } catch (error) {
    return { ok: false, errors: [`${path.basename(filePath)}: ${error instanceof Error ? error.message : String(error)}`] };
  }
}
